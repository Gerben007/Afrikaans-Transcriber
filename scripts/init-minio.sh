#!/usr/bin/env bash
# Create MinIO buckets for the transcription service.
# Usage: ./scripts/init-minio.sh
#
# Requires: mc (MinIO Client) — https://min.io/docs/minio/linux/reference/minio-mc.html
# Reads MINIO_ROOT_USER and MINIO_ROOT_PASSWORD from .env or environment.

set -euo pipefail

MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"

echo "Configuring MinIO alias..."
mc alias set local "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

echo "Creating buckets..."
mc mb --ignore-existing local/audio-inbox
mc mb --ignore-existing local/transcripts-out

echo "Done. Buckets:"
mc ls local/
