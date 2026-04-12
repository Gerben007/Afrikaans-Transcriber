import json
import logging
import os
import tempfile
import time

import httpx

from app.core.config import settings
from app.core.database import SyncSessionLocal
from app.core.models import Job
from app.core.storage import download_file, upload_file
from app.worker.celery_app import celery

logger = logging.getLogger(__name__)

_model = None


def get_model():
    """Lazy-load the faster-whisper model (singleton)."""
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        logger.info(
            "Loading whisper model from %s (device=%s, compute_type=%s)",
            settings.WHISPER_MODEL_PATH,
            settings.WHISPER_DEVICE,
            settings.WHISPER_COMPUTE_TYPE,
        )
        _model = WhisperModel(
            settings.WHISPER_MODEL_PATH,
            device=settings.WHISPER_DEVICE,
            compute_type=settings.WHISPER_COMPUTE_TYPE,
        )
        logger.info("Whisper model loaded successfully")
    return _model


def _update_progress(session, job_id, progress, duration=None):
    """Update job progress in DB."""
    job = session.query(Job).filter(Job.job_id == job_id).first()
    if job:
        job.progress = min(progress, 100)
        if duration is not None:
            job.audio_duration = duration
        session.commit()


def _save_partial_transcript(job_id, info, segments_so_far, duration):
    """Write partial transcript JSON to MinIO so the UI can show live progress."""
    partial_data = {
        "job_id": job_id,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(duration, 3),
        "partial": True,
        "segments": segments_so_far,
    }
    partial_key = f"{job_id}.partial.json"
    tmp_path = os.path.join(tempfile.gettempdir(), f"{job_id}_partial.json")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(partial_data, f, ensure_ascii=False)
        upload_file(
            settings.MINIO_BUCKET_TRANSCRIPTS,
            partial_key,
            tmp_path,
            content_type="application/json",
        )
    except Exception as e:
        logger.warning("Failed to save partial transcript: %s", e)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@celery.task(bind=True, name="transcribe_audio")
def transcribe_audio(self, job_id: str) -> dict:
    """Pull audio from MinIO, transcribe with faster-whisper, store result."""
    tmp_audio = None
    tmp_txt = None
    tmp_json = None
    session = SyncSessionLocal()

    try:
        # 1. Check if job was cancelled
        job = session.query(Job).filter(Job.job_id == job_id).first()
        if job is None:
            raise ValueError(f"Job {job_id} not found")
        if job.status == "cancelled":
            logger.info("Job %s was cancelled, skipping", job_id)
            return {"job_id": job_id, "status": "cancelled"}

        job.status = "processing"
        job.progress = 0
        session.commit()

        # 2. Download audio from MinIO
        _update_progress(session, job_id, 5)
        audio_ext = os.path.splitext(job.audio_path)[1] or ".wav"
        tmp_audio = os.path.join(tempfile.gettempdir(), f"{job_id}{audio_ext}")
        download_file(settings.MINIO_BUCKET_AUDIO, job.audio_path, tmp_audio)
        logger.info("Downloaded audio for job %s: %s", job_id, job.audio_path)

        # 3. Run transcription with word-level timestamps
        _update_progress(session, job_id, 10)
        model = get_model()
        segments, info = model.transcribe(
            tmp_audio,
            language="af",
            beam_size=5,
            vad_filter=True,
            word_timestamps=True,
        )

        duration = info.duration
        _update_progress(session, job_id, 15, duration=duration)
        logger.info(
            "Transcription started for job %s (language: %s, duration: %.1fs)",
            job_id, info.language, duration,
        )

        # 4. Build structured transcript with progress updates
        transcript_segments = []
        full_text_parts = []
        last_progress_update = time.time()
        last_partial_save = time.time()

        for segment in segments:
            # Check if cancelled + update progress every 2s
            now = time.time()
            if now - last_progress_update > 2:
                session.expire_all()
                job = session.query(Job).filter(Job.job_id == job_id).first()
                if job and job.status == "cancelled":
                    logger.info("Job %s cancelled during transcription", job_id)
                    return {"job_id": job_id, "status": "cancelled"}

                # Update progress: 15-90% maps to transcription progress
                if duration > 0:
                    pct = 15 + int((segment.end / duration) * 75)
                    _update_progress(session, job_id, pct)
                last_progress_update = now

            words = []
            if segment.words:
                for w in segment.words:
                    words.append({
                        "word": w.word,
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                        "probability": round(w.probability, 3),
                    })

            seg_text = segment.text.strip()
            full_text_parts.append(seg_text)
            transcript_segments.append({
                "id": segment.id,
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "text": seg_text,
                "speaker": "Spreker 1",
                "words": words,
            })

            # Save partial transcript every ~10 seconds
            if now - last_partial_save > 10 and transcript_segments:
                _save_partial_transcript(
                    job_id, info, transcript_segments, duration
                )
                last_partial_save = now

        _update_progress(session, job_id, 90)

        full_text = "\n".join(full_text_parts)
        transcript_data = {
            "job_id": job_id,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 3),
            "segments": transcript_segments,
        }

        logger.info("Transcription complete for job %s (%d segments, %d chars)", job_id, len(transcript_segments), len(full_text))

        # 5. Write plain text transcript to MinIO
        _update_progress(session, job_id, 92)
        transcript_key = f"{job_id}.txt"
        tmp_txt = os.path.join(tempfile.gettempdir(), f"{job_id}.txt")
        with open(tmp_txt, "w", encoding="utf-8") as f:
            f.write(full_text)
        upload_file(
            settings.MINIO_BUCKET_TRANSCRIPTS,
            transcript_key,
            tmp_txt,
            content_type="text/plain; charset=utf-8",
        )

        # 6. Write JSON transcript with timestamps to MinIO
        _update_progress(session, job_id, 95)
        json_key = f"{job_id}.json"
        tmp_json = os.path.join(tempfile.gettempdir(), f"{job_id}.json")
        with open(tmp_json, "w", encoding="utf-8") as f:
            json.dump(transcript_data, f, ensure_ascii=False, indent=2)
        upload_file(
            settings.MINIO_BUCKET_TRANSCRIPTS,
            json_key,
            tmp_json,
            content_type="application/json",
        )

        # 7. Update job status and clean up partial file
        job = session.query(Job).filter(Job.job_id == job_id).first()
        job.transcript_path = transcript_key
        job.transcript_json_path = json_key
        job.status = "completed"
        job.progress = 100
        session.commit()

        # Remove partial transcript
        try:
            from app.core.storage import get_minio_client
            mc = get_minio_client()
            mc.remove_object(settings.MINIO_BUCKET_TRANSCRIPTS, f"{job_id}.partial.json")
        except Exception:
            pass

        # 8. Fire webhook to n8n
        if settings.N8N_WEBHOOK_URL:
            try:
                httpx.post(
                    settings.N8N_WEBHOOK_URL,
                    json={
                        "job_id": job_id,
                        "status": "completed",
                        "client_email": job.client_email,
                        "transcript_key": transcript_key,
                    },
                    timeout=10.0,
                )
                logger.info("n8n webhook fired for job %s", job_id)
            except Exception as wh_exc:
                logger.warning("n8n webhook failed for job %s: %s", job_id, wh_exc)

        return {"job_id": job_id, "status": "completed"}

    except Exception as exc:
        logger.exception("Transcription failed for job %s", job_id)
        try:
            job = session.query(Job).filter(Job.job_id == job_id).first()
            if job:
                job.status = "failed"
                job.error_message = str(exc)
                session.commit()
        except Exception:
            logger.exception("Failed to update job %s status to failed", job_id)
        raise

    finally:
        session.close()
        for path in (tmp_audio, tmp_txt, tmp_json):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
