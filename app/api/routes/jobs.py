import json
import os
import tempfile
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import logging

from app.api.deps import get_db
from app.api.schemas import JobResponse, TranscriptData, TranscriptUpdate
from app.core.config import settings
from app.core.models import Job
from app.core.storage import download_file, get_minio_client, presigned_get_url, upload_file

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/jobs/{job_id}", response_model=JobResponse)
async def get_job(job_id: UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Job).where(Job.job_id == job_id))
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    audio_url = None
    transcript_url = None
    transcript_json_url = None

    try:
        audio_url = presigned_get_url(settings.MINIO_BUCKET_AUDIO, job.audio_path)
    except Exception:
        pass

    if job.status == "completed" and job.transcript_path:
        try:
            transcript_url = presigned_get_url(
                settings.MINIO_BUCKET_TRANSCRIPTS, job.transcript_path
            )
        except Exception:
            pass

    if job.status == "completed" and job.transcript_json_path:
        try:
            transcript_json_url = presigned_get_url(
                settings.MINIO_BUCKET_TRANSCRIPTS, job.transcript_json_path
            )
        except Exception:
            pass

    return JobResponse(
        job_id=job.job_id,
        status=job.status,
        client_email=job.client_email,
        audio_url=audio_url,
        transcript_url=transcript_url,
        transcript_json_url=transcript_json_url,
        error_message=job.error_message,
        created_at=job.created_at,
    )


@router.get("/jobs/{job_id}/transcript")
async def get_transcript(job_id: UUID, db: AsyncSession = Depends(get_db)):
    """Return the structured transcript JSON with word-level timestamps."""
    result = await db.execute(select(Job).where(Job.job_id == job_id))
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job.transcript_json_path:
        raise HTTPException(status_code=404, detail="Transcript not ready")

    tmp_path = os.path.join(tempfile.gettempdir(), f"read_{job_id}.json")
    try:
        download_file(settings.MINIO_BUCKET_TRANSCRIPTS, job.transcript_json_path, tmp_path)
        with open(tmp_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return JSONResponse(data)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@router.put("/jobs/{job_id}/transcript")
async def save_transcript(
    job_id: UUID, body: TranscriptUpdate, db: AsyncSession = Depends(get_db)
):
    """Save corrected transcript. Updates both JSON and plain text in MinIO."""
    result = await db.execute(select(Job).where(Job.job_id == job_id))
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    # Load existing JSON to preserve metadata
    existing_data = {"job_id": str(job_id), "language": "af", "language_probability": 0, "duration": 0}
    if job.transcript_json_path:
        tmp_read = os.path.join(tempfile.gettempdir(), f"read_{job_id}.json")
        try:
            download_file(settings.MINIO_BUCKET_TRANSCRIPTS, job.transcript_json_path, tmp_read)
            with open(tmp_read, "r", encoding="utf-8") as f:
                existing_data = json.load(f)
        except Exception:
            pass
        finally:
            if os.path.exists(tmp_read):
                os.remove(tmp_read)

    # Update segments with corrections
    existing_data["segments"] = [seg.model_dump() for seg in body.segments]

    # Write updated JSON
    json_key = f"{job_id}.json"
    tmp_json = os.path.join(tempfile.gettempdir(), f"save_{job_id}.json")
    try:
        with open(tmp_json, "w", encoding="utf-8") as f:
            json.dump(existing_data, f, ensure_ascii=False, indent=2)
        upload_file(
            settings.MINIO_BUCKET_TRANSCRIPTS, json_key, tmp_json,
            content_type="application/json",
        )
    finally:
        if os.path.exists(tmp_json):
            os.remove(tmp_json)

    # Write updated plain text
    txt_key = f"{job_id}.txt"
    full_text = "\n".join(seg.text for seg in body.segments)
    tmp_txt = os.path.join(tempfile.gettempdir(), f"save_{job_id}.txt")
    try:
        with open(tmp_txt, "w", encoding="utf-8") as f:
            f.write(full_text)
        upload_file(
            settings.MINIO_BUCKET_TRANSCRIPTS, txt_key, tmp_txt,
            content_type="text/plain; charset=utf-8",
        )
    finally:
        if os.path.exists(tmp_txt):
            os.remove(tmp_txt)

    # Update DB paths if needed
    job.transcript_path = txt_key
    job.transcript_json_path = json_key
    await db.commit()

    return {"status": "saved"}


@router.get("/jobs/{job_id}/export-training")
async def export_training_data(job_id: UUID, db: AsyncSession = Depends(get_db)):
    """Export corrected transcript as training data (audio path + segments)."""
    result = await db.execute(select(Job).where(Job.job_id == job_id))
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job.transcript_json_path:
        raise HTTPException(status_code=404, detail="Transcript not ready")

    tmp_path = os.path.join(tempfile.gettempdir(), f"export_{job_id}.json")
    try:
        download_file(settings.MINIO_BUCKET_TRANSCRIPTS, job.transcript_json_path, tmp_path)
        with open(tmp_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    audio_url = None
    try:
        audio_url = presigned_get_url(settings.MINIO_BUCKET_AUDIO, job.audio_path, expires_hours=24)
    except Exception:
        pass

    training_pairs = []
    for seg in data.get("segments", []):
        training_pairs.append({
            "audio_file": job.audio_path,
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"],
            "speaker": seg.get("speaker", "Spreker 1"),
        })

    return {
        "job_id": str(job_id),
        "audio_path": job.audio_path,
        "audio_url": audio_url,
        "language": "af",
        "pairs": training_pairs,
    }


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: UUID, db: AsyncSession = Depends(get_db)):
    """Delete a job and its files from MinIO."""
    result = await db.execute(select(Job).where(Job.job_id == job_id))
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    client = get_minio_client()

    # Delete audio file from MinIO
    if job.audio_path:
        try:
            client.remove_object(settings.MINIO_BUCKET_AUDIO, job.audio_path)
        except Exception as e:
            logger.warning("Failed to delete audio %s: %s", job.audio_path, e)

    # Delete transcript files from MinIO
    if job.transcript_path:
        try:
            client.remove_object(settings.MINIO_BUCKET_TRANSCRIPTS, job.transcript_path)
        except Exception as e:
            logger.warning("Failed to delete transcript %s: %s", job.transcript_path, e)

    if job.transcript_json_path:
        try:
            client.remove_object(settings.MINIO_BUCKET_TRANSCRIPTS, job.transcript_json_path)
        except Exception as e:
            logger.warning("Failed to delete transcript JSON %s: %s", job.transcript_json_path, e)

    # Delete from database
    await db.delete(job)
    await db.commit()

    return {"status": "deleted"}
