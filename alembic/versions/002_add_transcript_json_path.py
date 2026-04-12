"""Add transcript_json_path column

Revision ID: 002
Revises: 001
Create Date: 2026-04-12
"""

from alembic import op
import sqlalchemy as sa

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("transcript_json_path", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "transcript_json_path")
