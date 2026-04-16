import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import select, update

from app.api.routes import ai, jobs, payfast, settings as settings_routes, upload
from app.core.database import AsyncSessionLocal, async_engine
from app.core.models import Job

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    # On startup: reset any stuck "processing" jobs back to "pending"
    # This handles server crashes / restarts mid-transcription
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            update(Job)
            .where(Job.status == "processing")
            .values(status="pending", progress=0, error_message=None)
        )
        if result.rowcount > 0:
            await session.commit()
            logger.info("Reset %d stuck processing jobs to pending", result.rowcount)

            # Re-queue them
            from app.worker.celery_app import celery

            rows = await session.execute(select(Job).where(Job.status == "pending"))
            for job in rows.scalars():
                celery.send_task("transcribe_audio", args=[str(job.job_id)])
                logger.info("Re-queued job %s", job.job_id)

    yield
    await async_engine.dispose()


app = FastAPI(
    title="Afrikaans Transcription Service",
    version="1.0.0",
    lifespan=lifespan,
)

# Static files and templates
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# API routes
app.include_router(upload.router, prefix="/api/v1", tags=["upload"])
app.include_router(jobs.router, prefix="/api/v1", tags=["jobs"])
app.include_router(payfast.router, prefix="/api/v1", tags=["payfast"])
app.include_router(settings_routes.router, prefix="/api/v1", tags=["settings"])
app.include_router(ai.router, prefix="/api/v1", tags=["ai"])


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


@app.get("/settings")
async def settings_page(request: Request):
    return templates.TemplateResponse(request=request, name="settings.html")


@app.get("/transcripts")
async def transcripts(request: Request):
    return templates.TemplateResponse(request=request, name="transcripts.html")


@app.get("/editor/{job_id}")
async def editor(request: Request, job_id: str):
    return templates.TemplateResponse(request=request, name="editor.html", context={"job_id": job_id})


@app.get("/health")
async def health():
    return JSONResponse({"status": "ok"})
