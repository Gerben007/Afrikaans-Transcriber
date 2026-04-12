import logging
import os
import tempfile

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


@celery.task(bind=True, name="transcribe_audio")
def transcribe_audio(self, job_id: str) -> dict:
    """Pull audio from MinIO, transcribe with faster-whisper, store result."""
    tmp_audio = None
    tmp_txt = None
    session = SyncSessionLocal()

    try:
        # 1. Update status to processing
        job = session.query(Job).filter(Job.job_id == job_id).first()
        if job is None:
            raise ValueError(f"Job {job_id} not found")
        job.status = "processing"
        session.commit()

        # 2. Download audio from MinIO
        audio_ext = os.path.splitext(job.audio_path)[1] or ".wav"
        tmp_audio = os.path.join(tempfile.gettempdir(), f"{job_id}{audio_ext}")
        download_file(settings.MINIO_BUCKET_AUDIO, job.audio_path, tmp_audio)
        logger.info("Downloaded audio for job %s: %s", job_id, job.audio_path)

        # 3. Run transcription
        model = get_model()
        segments, info = model.transcribe(
            tmp_audio,
            language="af",
            beam_size=5,
            vad_filter=True,
        )
        logger.info(
            "Transcription started for job %s (detected language: %s, probability: %.2f)",
            job_id,
            info.language,
            info.language_probability,
        )

        full_text = "\n".join(segment.text.strip() for segment in segments)
        logger.info("Transcription complete for job %s (%d chars)", job_id, len(full_text))

        # 4. Write transcript to MinIO
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

        # 5. Update job status
        job.transcript_path = transcript_key
        job.status = "completed"
        session.commit()

        # 6. Fire webhook to n8n
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
        for path in (tmp_audio, tmp_txt):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
