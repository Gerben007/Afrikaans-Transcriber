import os
import tempfile
import uuid

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.api.schemas import UploadResponse
from app.core.config import settings
from app.core.models import Job
from app.core.storage import get_minio_client

router = APIRouter()

ALLOWED_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".opus", ".mp4", ".webm", ".3gp", ".aac"}
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500 MB


@router.post("/upload", response_model=UploadResponse, status_code=201)
async def upload_audio(
    file: UploadFile,
    client_email: str = Form(...),
    db: AsyncSession = Depends(get_db),
):
    # Validate file extension
    _, ext = os.path.splitext(file.filename or "")
    ext = ext.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    # Generate job ID and MinIO object key
    job_id = uuid.uuid4()
    object_key = f"{job_id}{ext}"

    # Save upload to temp file, then push to MinIO
    tmp_path = os.path.join(tempfile.gettempdir(), f"upload_{job_id}{ext}")
    try:
        size = 0
        with open(tmp_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_FILE_SIZE:
                    raise HTTPException(status_code=413, detail="File too large (max 500 MB)")
                f.write(chunk)

        client = get_minio_client()
        client.fput_object(
            settings.MINIO_BUCKET_AUDIO,
            object_key,
            tmp_path,
            content_type=file.content_type or "application/octet-stream",
        )
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    # Create job record
    job = Job(
        job_id=job_id,
        client_email=client_email,
        audio_path=object_key,
        status="pending",
    )
    db.add(job)
    await db.commit()

    # Dispatch Celery task by name (avoids importing worker code which needs faster-whisper)
    from app.worker.celery_app import celery

    celery.send_task("transcribe_audio", args=[str(job_id)])

    return UploadResponse(job_id=job_id, status="pending")
