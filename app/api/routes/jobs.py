from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.api.schemas import JobResponse
from app.core.config import settings
from app.core.models import Job
from app.core.storage import presigned_get_url

router = APIRouter()


@router.get("/jobs/{job_id}", response_model=JobResponse)
async def get_job(job_id: UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Job).where(Job.job_id == job_id))
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    transcript_url = None
    if job.status == "completed" and job.transcript_path:
        try:
            transcript_url = presigned_get_url(
                settings.MINIO_BUCKET_TRANSCRIPTS, job.transcript_path
            )
        except Exception:
            pass

    return JobResponse(
        job_id=job.job_id,
        status=job.status,
        client_email=job.client_email,
        transcript_url=transcript_url,
        error_message=job.error_message,
        created_at=job.created_at,
    )
