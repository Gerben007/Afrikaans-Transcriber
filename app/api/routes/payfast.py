import hashlib
import logging
import urllib.parse

from fastapi import APIRouter, HTTPException, Request

from app.core.config import settings
from app.core.database import SyncSessionLocal
from app.core.models import Job

router = APIRouter()
logger = logging.getLogger(__name__)


def validate_payfast_signature(post_data: dict, passphrase: str) -> bool:
    """Validate PayFast ITN signature using MD5."""
    signature = post_data.pop("signature", None)
    if not signature:
        return False

    # Build param string in the order received (PayFast sends in correct order)
    # Exclude empty values
    param_string = "&".join(
        f"{k}={urllib.parse.quote_plus(str(v).strip())}"
        for k, v in post_data.items()
        if v is not None and str(v).strip() != ""
    )

    if passphrase:
        param_string += f"&passphrase={urllib.parse.quote_plus(passphrase.strip())}"

    computed = hashlib.md5(param_string.encode()).hexdigest()
    return computed == signature.lower()


@router.post("/payfast/itn")
async def payfast_itn(request: Request):
    """Handle PayFast Instant Transaction Notification."""
    form_data = await request.form()
    data = dict(form_data)

    # Validate signature
    if not validate_payfast_signature(data.copy(), settings.PAYFAST_PASSPHRASE):
        logger.warning("PayFast ITN: invalid signature")
        raise HTTPException(status_code=400, detail="Invalid signature")

    payment_status = data.get("payment_status", "")
    m_payment_id = data.get("m_payment_id", "")

    if not m_payment_id:
        raise HTTPException(status_code=400, detail="Missing m_payment_id")

    logger.info(
        "PayFast ITN: payment_id=%s status=%s", m_payment_id, payment_status
    )

    if payment_status == "COMPLETE":
        # Use sync session since this is a simple update
        session = SyncSessionLocal()
        try:
            job = session.query(Job).filter(Job.job_id == m_payment_id).first()
            if job:
                job.payment_ref = data.get("pf_payment_id", "")
                if job.status == "pending":
                    session.commit()
                    # Dispatch transcription by name (avoids importing worker code)
                    from app.worker.celery_app import celery

                    celery.send_task("transcribe_audio", args=[str(job.job_id)])
                else:
                    session.commit()
            else:
                logger.warning("PayFast ITN: job %s not found", m_payment_id)
        finally:
            session.close()

    return {"status": "ok"}
