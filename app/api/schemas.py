from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel


class UploadResponse(BaseModel):
    job_id: UUID
    status: str


class JobResponse(BaseModel):
    job_id: UUID
    status: str
    client_email: str
    original_filename: Optional[str] = None
    progress: int = 0
    audio_duration: Optional[float] = None
    is_edited: bool = False
    training_published: bool = False
    is_exported: bool = False
    audio_url: Optional[str] = None
    transcript_url: Optional[str] = None
    transcript_json_url: Optional[str] = None
    error_message: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class JobListItem(BaseModel):
    job_id: UUID
    status: str
    original_filename: Optional[str] = None
    client_email: str
    progress: int = 0
    audio_duration: Optional[float] = None
    is_edited: bool = False
    training_published: bool = False
    is_exported: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class WordTimestamp(BaseModel):
    word: str
    start: float
    end: float
    probability: float


class TranscriptSegment(BaseModel):
    id: int
    start: float
    end: float
    text: str
    speaker: str = "Spreker 1"
    words: list[WordTimestamp] = []


class TranscriptData(BaseModel):
    job_id: str
    language: str = "af"
    language_probability: float = 0.0
    duration: float = 0.0
    segments: list[TranscriptSegment] = []


class TranscriptUpdate(BaseModel):
    segments: list[TranscriptSegment]
