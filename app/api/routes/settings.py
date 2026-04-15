import json
import logging
import os
import subprocess
import tempfile

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.core.config import settings
from app.core.models import Job
from app.core.storage import download_file, get_minio_client, upload_file

router = APIRouter()
logger = logging.getLogger(__name__)

SETTINGS_KEY = "app-settings.json"


class TrainingSchedule(BaseModel):
    auto_train_enabled: bool = False
    auto_train_cron: str = "weekly"  # "daily", "weekly", "monthly", "off"
    min_published_before_train: int = 5  # Minimum published transcripts before auto-training


class TrainingStatus(BaseModel):
    is_training: bool = False
    training_step: str = ""
    training_progress: int = 0
    training_message: str = ""
    last_trained: str | None = None
    last_train_result: str | None = None
    published_count: int = 0
    total_completed: int = 0
    total_edited: int = 0


class AppSettings(BaseModel):
    training_schedule: TrainingSchedule = TrainingSchedule()


def _load_settings() -> dict:
    """Load app settings from MinIO."""
    client = get_minio_client()
    tmp = os.path.join(tempfile.gettempdir(), "app_settings.json")
    try:
        client.fget_object(settings.MINIO_BUCKET_TRANSCRIPTS, SETTINGS_KEY, tmp)
        with open(tmp, "r") as f:
            return json.load(f)
    except Exception:
        return {}
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _save_settings(data: dict) -> None:
    """Save app settings to MinIO."""
    client = get_minio_client()
    tmp = os.path.join(tempfile.gettempdir(), "app_settings.json")
    try:
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        upload_file(settings.MINIO_BUCKET_TRANSCRIPTS, SETTINGS_KEY, tmp, content_type="application/json")
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


@router.get("/settings")
async def get_settings():
    """Get app settings."""
    data = _load_settings()
    return AppSettings(**data)


@router.put("/settings")
async def update_settings(body: AppSettings):
    """Update app settings."""
    _save_settings(body.model_dump())
    return {"status": "saved"}


@router.get("/settings/training-status")
async def get_training_status(db: AsyncSession = Depends(get_db)):
    """Get current training status and stats."""
    # Count published transcripts
    published = await db.execute(
        select(func.count()).where(Job.training_published == True)
    )
    published_count = published.scalar() or 0

    completed = await db.execute(
        select(func.count()).where(Job.status == "completed")
    )
    total_completed = completed.scalar() or 0

    edited = await db.execute(
        select(func.count()).where(Job.is_edited == True)
    )
    total_edited = edited.scalar() or 0

    # Check if training is currently running
    data = _load_settings()
    is_training = data.get("is_training", False)
    last_trained = data.get("last_trained")
    last_train_result = data.get("last_train_result")

    return TrainingStatus(
        is_training=is_training,
        training_step=data.get("training_step", ""),
        training_progress=data.get("training_progress", 0),
        training_message=data.get("training_message", ""),
        last_trained=last_trained,
        last_train_result=last_train_result,
        published_count=published_count,
        total_completed=total_completed,
        total_edited=total_edited,
    )


@router.post("/settings/train-now")
async def train_now():
    """Trigger model training: sync data, train, convert, restart worker."""
    data = _load_settings()
    if data.get("is_training"):
        raise HTTPException(status_code=409, detail="Training already in progress")

    # Mark as training
    data["is_training"] = True
    _save_settings(data)

    # Dispatch as Celery task so it doesn't block the API
    from app.worker.celery_app import celery
    celery.send_task("run_training_pipeline", args=[])

    return {"status": "training_started"}
