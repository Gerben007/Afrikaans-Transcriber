"""Add original_filename column

Revision ID: 004
Revises: 003
Create Date: 2026-04-12
"""

from alembic import op
import sqlalchemy as sa

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("original_filename", sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "original_filename")
