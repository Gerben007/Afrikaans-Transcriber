"""AI-assisted transcript correction using Claude API."""

import json
import logging

from fastapi import APIRouter, HTTPException

from app.api.schemas import SegmentCorrectionRequest, SegmentCorrectionResponse
from app.api.routes.settings import get_anthropic_api_key

logger = logging.getLogger(__name__)

router = APIRouter()

SYSTEM_PROMPT = """You are an Afrikaans language expert specializing in correcting automatic speech recognition (ASR) errors from Whisper transcription.

Your task is to fix common ASR errors while preserving the original meaning and natural speech patterns. Common errors include:
- Word substitutions with phonetically similar Afrikaans words
- Missing or incorrect punctuation
- English words incorrectly transcribed instead of Afrikaans equivalents
- Hallucinated filler phrases (e.g. "Dankie vir die kyk", "Ondertitels deur die Amara.org-gemeenskap")
- Repeated words or phrases (stuttering artifacts)
- Missing apostrophes in words like 'n, dis, ek's
- Number and date formatting issues
- Fused or split words that should be one word or separate

If the text appears correct, return it unchanged with high confidence.

Respond ONLY with valid JSON (no markdown, no code fences):
{"suggestion": "corrected text here", "explanation": "brief explanation of changes made", "confidence": 0.95}"""


@router.get("/ai/status")
async def ai_status():
    """Check if AI correction is available."""
    return {"available": bool(get_anthropic_api_key())}


@router.post("/ai/correct-segment", response_model=SegmentCorrectionResponse)
async def correct_segment(body: SegmentCorrectionRequest):
    """Send a transcript segment to Claude for correction suggestions."""
    api_key = get_anthropic_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="AI correction not configured. Add your API key in Settings.")

    try:
        import anthropic
    except ImportError:
        raise HTTPException(status_code=503, detail="anthropic package not installed")

    context_parts = []
    if body.context_before:
        context_parts.append("Previous context:\n" + "\n".join(body.context_before))
    context_parts.append(f"Segment to correct:\n{body.segment_text}")
    if body.context_after:
        context_parts.append("Following context:\n" + "\n".join(body.context_after))

    user_message = "\n\n".join(context_parts)

    try:
        client = anthropic.Anthropic(api_key=api_key)
        message = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        result = json.loads(message.content[0].text)
        return SegmentCorrectionResponse(
            suggestion=result.get("suggestion", body.segment_text),
            explanation=result.get("explanation", ""),
            confidence=result.get("confidence", 0.0),
        )

    except json.JSONDecodeError:
        logger.warning("AI returned non-JSON response: %s", message.content[0].text[:200])
        raise HTTPException(status_code=502, detail="AI returned invalid response format")
    except anthropic.RateLimitError:
        raise HTTPException(status_code=429, detail="AI rate limit exceeded. Try again shortly.")
    except anthropic.APIError as e:
        logger.error("Anthropic API error: %s", e)
        raise HTTPException(status_code=502, detail=f"AI service error: {e}")
    except Exception as e:
        logger.error("AI correction failed: %s", e)
        raise HTTPException(status_code=500, detail="AI correction failed")
