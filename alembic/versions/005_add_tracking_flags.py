"""Add tracking flags: is_edited, training_published, is_exported

Revision ID: 005
Revises: 004
Create Date: 2026-04-15
"""

from alembic import op
import sqlalchemy as sa

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("is_edited", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("jobs", sa.Column("training_published", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("jobs", sa.Column("is_exported", sa.Boolean(), nullable=False, server_default="false"))


def downgrade() -> None:
    op.drop_column("jobs", "is_exported")
    op.drop_column("jobs", "training_published")
    op.drop_column("jobs", "is_edited")
