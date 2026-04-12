from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr


class UploadResponse(BaseModel):
    job_id: UUID
    status: str


class JobResponse(BaseModel):
    job_id: UUID
    status: str
    client_email: str
    transcript_url: Optional[str] = None
    error_message: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}
