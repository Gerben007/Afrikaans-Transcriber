from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://transcriber:transcriber@postgres:5432/transcriber"
    DATABASE_URL_SYNC: str = "postgresql+psycopg2://transcriber:transcriber@postgres:5432/transcriber"

    # Redis
    REDIS_URL: str = "redis://redis:6379/0"

    # MinIO
    MINIO_ENDPOINT: str = "minio:9000"
    MINIO_ROOT_USER: str = "minioadmin"
    MINIO_ROOT_PASSWORD: str = "minioadmin"
    MINIO_SECURE: bool = False
    MINIO_BUCKET_AUDIO: str = "audio-inbox"
    MINIO_BUCKET_TRANSCRIPTS: str = "transcripts-out"

    # PayFast
    PAYFAST_PASSPHRASE: str = ""
    PAYFAST_MERCHANT_ID: str = ""

    # Whisper (worker only)
    WHISPER_MODEL_PATH: str = "/models/whisper"
    WHISPER_DEVICE: str = "cpu"
    WHISPER_COMPUTE_TYPE: str = "int8"

    # Webhooks
    N8N_WEBHOOK_URL: str = ""

    # App
    DEBUG: bool = False

    model_config = {"env_file": ".env", "case_sensitive": True}


settings = Settings()
