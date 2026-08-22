import os
import time
import base64
import logging
from typing import Optional, Callable, Dict, Any, List
from dotenv import load_dotenv
from google import genai
from .genai_factory import build_client, resolve_api_key
from ..models.document import (
    DEFAULT_SYSTEM_PROMPT,
    PRESET_PROMPT_ID,
    RECITATION_FALLBACK_PROMPTS,
)

logger = logging.getLogger(__name__)

class GeminiOCRClient:
    """Encapsulates communication with Google GenAI Interactions API, retries, and recitation fallbacks."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model_name: str = "gemini-3.1-flash-lite",
        system_prompt: Optional[str] = None
    ):
        load_dotenv()
        # Backend choice (Gemini API vs Vertex AI) and credential handling live
        # in one place; this class only needs the client that comes back.
        self.client, self.backend = build_client(api_key)
        self.api_key = None if self.backend.vertex else resolve_api_key(api_key)
        self.model_name = model_name
        self.system_prompt = system_prompt or DEFAULT_SYSTEM_PROMPT

    def test_connection(self) -> Dict[str, Any]:
        """Test API connectivity and key validity."""
        try:
            res = self.client.interactions.create(
                model=self.model_name,
                input="Ping. Reply with 'PONG'."
            )
            return {
                "status": "connected",
                "model": self.model_name,
                "message": "API key is valid and Interactions API responded successfully.",
                "sample_output": (res.output_text or "").strip()
            }
        except Exception as e:
            err_str = str(e)
            error_type = "API_ERROR"
            if "403" in err_str or "API_KEY_INVALID" in err_str or "permission" in err_str.lower():
                error_type = "AUTH_ERROR"
            elif "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                error_type = "QUOTA_ERROR"
            elif "404" in err_str or "not found" in err_str.lower():
                error_type = "MODEL_NOT_FOUND"

            return {
                "status": "error",
                "error_type": error_type,
                "model": self.model_name,
                "message": err_str
            }

    def ocr_page_image(
        self,
        img_bytes: bytes,
        prompt: Optional[str] = None,
        max_retries: int = 4,
        backoff_factor: float = 2.0,
        status_callback: Optional[Callable[[str], None]] = None,
        cancel_check: Optional[Callable[[], bool]] = None,
        prompt_callback: Optional[Callable[[str], None]] = None
    ) -> str:
        """Submit a single page image to Gemini Interactions API with automated retry and recitation fallback.

        ``prompt_callback`` is told the id of the prompt in force whenever it
        changes, so the caller can record which one produced the page it gets
        back. A page converted by a recitation fallback is not the same kind of
        thing as its neighbours, and nothing else can tell them apart.
        """
        b64_img = base64.b64encode(img_bytes).decode("utf-8")
        last_exception = None
        current_prompt = prompt or self.system_prompt
        current_prompt_id = PRESET_PROMPT_ID
        fallback_idx = 0
        if prompt_callback:
            prompt_callback(current_prompt_id)

        for attempt in range(1, max_retries + 1):
            if cancel_check and cancel_check():
                raise InterruptedError("Conversion cancelled by user.")

            try:
                response = self.client.interactions.create(
                    model=self.model_name,
                    input=[
                        {"type": "image", "mime_type": "image/png", "data": b64_img},
                        {"type": "text", "text": current_prompt}
                    ]
                )
                text = response.output_text or ""
                # Fence unwrapping happens once, in MarkdownAssembler, so the
                # live and batch paths treat model output identically.
                return text.strip()
            except Exception as e:
                last_exception = e
                err_msg = str(e)
                logger.warning(f"Attempt {attempt}/{max_retries} failed: {err_msg}")

                # Check for copyright / recitation block filter
                if "copyright" in err_msg.lower() or "recitation" in err_msg.lower():
                    msg = f"Public statutory recitation check triggered. Using public filing prompt (Option {fallback_idx + 1})..."
                    logger.info(msg)
                    if status_callback:
                        status_callback(msg)
                    fallback = RECITATION_FALLBACK_PROMPTS[fallback_idx % len(RECITATION_FALLBACK_PROMPTS)]
                    current_prompt = fallback.text
                    current_prompt_id = fallback.id
                    if prompt_callback:
                        prompt_callback(current_prompt_id)
                    fallback_idx += 1
                    time.sleep(1.0)
                    continue

                # Rate Limit (429)
                if "RESOURCE_EXHAUSTED" in err_msg or "429" in err_msg or "Rate" in err_msg:
                    sleep_time = (backoff_factor ** attempt) + 1.0
                    msg = f"Rate limit reached (429). Backing off for {sleep_time:.1f}s (Attempt {attempt}/{max_retries})..."
                    logger.info(msg)
                    if status_callback:
                        status_callback(msg)
                    time.sleep(sleep_time)
                # Auth error
                elif "403" in err_msg or "API_KEY_INVALID" in err_msg:
                    raise PermissionError(f"Gemini API Authentication Error: {err_msg}")
                elif attempt < max_retries:
                    sleep_time = 2.0 * attempt
                    msg = f"API error: {err_msg[:80]}... Retrying in {sleep_time}s..."
                    logger.info(msg)
                    if status_callback:
                        status_callback(msg)
                    time.sleep(sleep_time)
                else:
                    raise last_exception

        if last_exception:
            raise last_exception
        return ""
