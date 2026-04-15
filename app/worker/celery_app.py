from celery import Celery

from app.core.config import settings

celery = Celery("worker")
celery.conf.broker_url = settings.REDIS_URL
celery.conf.result_backend = settings.REDIS_URL
celery.conf.task_serializer = "json"
celery.conf.result_serializer = "json"
celery.conf.accept_content = ["json"]
celery.conf.task_track_started = True
celery.conf.task_acks_late = True

celery.autodiscover_tasks(["app.worker"])

# Explicitly import train_task so Celery registers it
import app.worker.train_task  # noqa: F401, E402
