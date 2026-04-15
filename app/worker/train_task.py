"""Celery task to run the full training pipeline: sync → train → convert → restart."""

import json
import logging
import os
import subprocess
import tempfile
from datetime import datetime, timezone

from app.core.config import settings
from app.core.storage import download_file, get_minio_client, upload_file
from app.worker.celery_app import celery

logger = logging.getLogger(__name__)

SETTINGS_KEY = "app-settings.json"


def _load_settings() -> dict:
    client = get_minio_client()
    tmp = os.path.join(tempfile.gettempdir(), "app_settings_worker.json")
    try:
        client.fget_object(settings.MINIO_BUCKET_TRANSCRIPTS, SETTINGS_KEY, tmp)
        with open(tmp, "r") as f:
            return json.load(f)
    except Exception:
        return {}
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _save_settings(data: dict) -> None:
    client = get_minio_client()
    tmp = os.path.join(tempfile.gettempdir(), "app_settings_worker.json")
    try:
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        upload_file(settings.MINIO_BUCKET_TRANSCRIPTS, SETTINGS_KEY, tmp, content_type="application/json")
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _run_step(name, cmd):
    """Run a shell command and return (success, output)."""
    logger.info("Training step: %s — %s", name, " ".join(cmd))
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=3600 * 12
        )
        if result.returncode != 0:
            logger.error("Step '%s' failed:\n%s\n%s", name, result.stdout, result.stderr)
            return False, result.stderr or result.stdout
        logger.info("Step '%s' completed", name)
        return True, result.stdout
    except subprocess.TimeoutExpired:
        return False, "Timed out after 12 hours"
    except Exception as e:
        return False, str(e)


@celery.task(bind=True, name="run_training_pipeline")
def run_training_pipeline(self) -> dict:
    """
    Full training pipeline:
    1. Sync training data from MinIO to local disk
    2. Run training script
    3. Convert model to CTranslate2 format
    4. The new model is written to the mounted volume — worker restart loads it
    """
    data = _load_settings()
    results = []

    try:
        # Step 1: Sync training data from MinIO
        # Download all training data from MinIO bucket to local /tmp/training_data
        train_dir = "/tmp/training_sync"
        os.makedirs(train_dir, exist_ok=True)

        client = get_minio_client()
        bucket = settings.MINIO_BUCKET_TRAINING

        try:
            objects = list(client.list_objects(bucket, recursive=True))
            if not objects:
                data["is_training"] = False
                data["last_trained"] = datetime.now(timezone.utc).isoformat()
                data["last_train_result"] = "No training data found. Publish some corrected transcripts first."
                _save_settings(data)
                return {"status": "no_data"}

            for obj in objects:
                local_path = os.path.join(train_dir, obj.object_name)
                os.makedirs(os.path.dirname(local_path), exist_ok=True)
                client.fget_object(bucket, obj.object_name, local_path)

            logger.info("Synced %d files from training-data bucket", len(objects))
            results.append(f"Synced {len(objects)} training files")
        except Exception as e:
            data["is_training"] = False
            data["last_trained"] = datetime.now(timezone.utc).isoformat()
            data["last_train_result"] = f"Sync failed: {e}"
            _save_settings(data)
            return {"status": "sync_failed", "error": str(e)}

        # Step 2: Train
        train_cmd = [
            "python", "/app/training/train.py" if os.path.exists("/app/training/train.py") else "training/train.py",
            "--custom_data_dir", train_dir,
            "--output_dir", "/tmp/train_output",
            "--num_train_epochs", os.environ.get("NUM_TRAIN_EPOCHS", "3"),
            "--per_device_train_batch_size", os.environ.get("PER_DEVICE_TRAIN_BATCH_SIZE", "4"),
        ]

        # Check if training script exists
        if not os.path.exists("/app/training/train.py") and not os.path.exists("training/train.py"):
            data["is_training"] = False
            data["last_trained"] = datetime.now(timezone.utc).isoformat()
            data["last_train_result"] = "Training script not found. Training must be run via docker-compose.train.yml"
            _save_settings(data)
            return {"status": "script_not_found"}

        ok, output = _run_step("train", train_cmd)
        if not ok:
            data["is_training"] = False
            data["last_trained"] = datetime.now(timezone.utc).isoformat()
            data["last_train_result"] = f"Training failed: {output[:500]}"
            _save_settings(data)
            return {"status": "train_failed", "error": output[:500]}
        results.append("Training completed")

        # Step 3: Convert to CTranslate2
        convert_cmd = [
            "python", "/app/training/convert.py" if os.path.exists("/app/training/convert.py") else "training/convert.py",
            "--model_dir", "/tmp/train_output",
            "--output_dir", settings.WHISPER_MODEL_PATH,
            "--quantization", settings.WHISPER_COMPUTE_TYPE,
        ]

        ok, output = _run_step("convert", convert_cmd)
        if not ok:
            data["is_training"] = False
            data["last_trained"] = datetime.now(timezone.utc).isoformat()
            data["last_train_result"] = f"Conversion failed: {output[:500]}"
            _save_settings(data)
            return {"status": "convert_failed", "error": output[:500]}
        results.append("Model converted")

        # Step 4: Reload the whisper model (clear the cached singleton)
        global _model
        try:
            from app.worker import tasks
            tasks._model = None
            results.append("Model cache cleared — next transcription will load the new model")
        except Exception:
            results.append("Could not clear model cache — restart worker manually")

        # Success
        data["is_training"] = False
        data["last_trained"] = datetime.now(timezone.utc).isoformat()
        data["last_train_result"] = "Success: " + "; ".join(results)
        _save_settings(data)

        logger.info("Training pipeline completed: %s", results)
        return {"status": "completed", "results": results}

    except Exception as e:
        logger.exception("Training pipeline failed")
        data["is_training"] = False
        data["last_trained"] = datetime.now(timezone.utc).isoformat()
        data["last_train_result"] = f"Pipeline error: {str(e)[:500]}"
        _save_settings(data)
        raise
