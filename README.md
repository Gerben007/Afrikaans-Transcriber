# Afrikaans Transcription Service

A self-hosted Afrikaans audio transcription service built with faster-whisper, FastAPI, Celery, and Docker Compose.

## Architecture

| Service | Role |
|---------|------|
| **FastAPI** | REST API + Web UI |
| **Celery** | Task queue (transcription worker) |
| **faster-whisper** | ASR inference engine (Systran/faster-whisper) |
| **Redis** | Celery message broker |
| **PostgreSQL** | Jobs database |
| **MinIO** | S3-compatible file storage |
| **Caddy** | Reverse proxy with automatic HTTPS (production) |

## Prerequisites

- Docker Engine 20.10+ and Docker Compose v2
- ~6 GB disk space for the faster-whisper model
- (Optional) NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) for GPU acceleration

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/Gerben007/Afrikaans-Transcriber.git
cd Afrikaans-Transcriber
cp .env.example .env
# Edit .env with your passwords and settings
```

### 2. Download the whisper model

```bash
pip install huggingface-hub
huggingface-cli download Systran/faster-whisper-large-v3 \
    --local-dir /opt/models/faster-whisper-large-v3
```

Make sure `HOST_MODEL_PATH` in `.env` points to this directory.

### 3. Bring the stack up (development mode)

```bash
docker compose up -d --build
```

This starts all services except Caddy (dev mode). The `minio-init` service automatically creates the required buckets (`audio-inbox` and `transcripts-out`).

### 4. Verify services are running

```bash
# Check all containers
docker compose ps

# Health check
curl http://localhost:8000/health

# Open the Web UI
# Navigate to http://localhost:8000 in your browser
```

### 5. Create MinIO buckets manually (if needed)

The `minio-init` service handles this automatically. To do it manually:

```bash
# Using docker
docker compose run --rm minio-init

# Or using mc locally
mc alias set local http://localhost:9000 minioadmin CHANGE_ME_minio_secret
mc mb --ignore-existing local/audio-inbox
mc mb --ignore-existing local/transcripts-out
```

## Test Transcription

### Via Web UI

Open http://localhost:8000 in your browser, upload an audio file, and enter your email.

### Via CLI

```bash
# Upload an audio file
curl -X POST http://localhost:8000/api/v1/upload \
    -F "file=@test_audio.wav" \
    -F "client_email=test@example.com"

# Response: {"job_id": "abc123-...", "status": "pending"}

# Check job status (replace with your job_id)
curl http://localhost:8000/api/v1/jobs/abc123-...

# Response includes transcript_url when status is "completed"
```

### Watch worker logs

```bash
docker compose logs -f worker
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Web UI |
| `GET` | `/health` | Health check |
| `POST` | `/api/v1/upload` | Upload audio file for transcription |
| `GET` | `/api/v1/jobs/{job_id}` | Check job status |
| `POST` | `/api/v1/payfast/itn` | PayFast payment webhook |

## Production Deployment

### Enable HTTPS with Caddy

1. Set `DOMAIN=your-domain.com` in `.env`
2. Make sure ports 80 and 443 are open
3. Start with the production profile:

```bash
docker compose --profile production up -d --build
```

Caddy will automatically obtain a Let's Encrypt certificate.

### Enable GPU Acceleration

If you add an NVIDIA GPU later:

1. Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
2. Update `.env`:
   ```
   WHISPER_DEVICE=cuda
   WHISPER_COMPUTE_TYPE=float16
   ```
3. Uncomment the `deploy.resources` block in `docker-compose.yml` under the `worker` service
4. Rebuild and restart the worker:
   ```bash
   docker compose up -d --build worker
   ```

## Configuration

All configuration is via environment variables in `.env`. See `.env.example` for all available options.

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_DEVICE` | `cpu` | `cpu` or `cuda` |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8` (CPU), `float16` (GPU) |
| `HOST_MODEL_PATH` | `/opt/models/faster-whisper-large-v3` | Model directory on host |
| `N8N_WEBHOOK_URL` | (empty) | Webhook URL called on job completion |
| `DOMAIN` | `transcribe.example.com` | Domain for Caddy HTTPS |

## Database

Jobs are stored in PostgreSQL with the following schema:

| Column | Type | Description |
|--------|------|-------------|
| `job_id` | UUID | Primary key |
| `client_email` | VARCHAR(255) | Submitter email |
| `audio_path` | TEXT | MinIO key in `audio-inbox` |
| `transcript_path` | TEXT | MinIO key in `transcripts-out` |
| `status` | VARCHAR(50) | pending / processing / completed / failed |
| `created_at` | TIMESTAMP | Job creation time |

To inspect the database:

```bash
docker compose exec postgres psql -U transcriber -d transcriber -c "SELECT job_id, status, created_at FROM jobs ORDER BY created_at DESC LIMIT 10;"
```

## Useful Commands

```bash
# View logs for a specific service
docker compose logs -f api
docker compose logs -f worker

# Restart a single service
docker compose restart worker

# Stop everything
docker compose down

# Stop and remove all data (volumes)
docker compose down -v

# Run database migrations manually
docker compose exec api alembic upgrade head

# Access MinIO console
# http://localhost:9001 (dev mode)
```
