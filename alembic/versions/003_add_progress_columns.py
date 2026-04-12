"""Add progress and audio_duration columns

Revision ID: 003
Revises: 002
Create Date: 2026-04-12
"""

from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("progress", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("jobs", sa.Column("audio_duration", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "audio_duration")
    op.drop_column("jobs", "progress")
