import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Index, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Job(Base):
    __tablename__ = "jobs"

    job_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    client_email = Column(String(255), nullable=False)
    audio_path = Column(Text, nullable=False)
    transcript_path = Column(Text, nullable=True)
    transcript_json_path = Column(Text, nullable=True)
    status = Column(String(50), nullable=False, default="pending")
    payment_ref = Column(String(255), nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        Index("ix_jobs_client_email", "client_email"),
        Index("ix_jobs_status", "status"),
    )
