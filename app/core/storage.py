from datetime import timedelta

from minio import Minio

from app.core.config import settings


def get_minio_client() -> Minio:
    return Minio(
        settings.MINIO_ENDPOINT,
        access_key=settings.MINIO_ROOT_USER,
        secret_key=settings.MINIO_ROOT_PASSWORD,
        secure=settings.MINIO_SECURE,
    )


def upload_file(
    bucket: str, object_name: str, file_path: str, content_type: str = "application/octet-stream"
) -> None:
    client = get_minio_client()
    client.fput_object(bucket, object_name, file_path, content_type=content_type)


def download_file(bucket: str, object_name: str, local_path: str) -> None:
    client = get_minio_client()
    client.fget_object(bucket, object_name, local_path)


def presigned_get_url(bucket: str, object_name: str, expires_hours: int = 1) -> str:
    client = get_minio_client()
    return client.presigned_get_object(
        bucket, object_name, expires=timedelta(hours=expires_hours)
    )
