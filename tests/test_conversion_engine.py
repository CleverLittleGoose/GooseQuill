"""What the interactive converter writes down, and what it refuses to.

Two things a page cache must never contain: an empty page, and a note saying
the page could not be converted. Both are the right size to look like a
transcription, so both mark the page done — and every later run skips it. A
hole that reports itself as filled is the one kind that never heals.
"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.models.document import PRESET_PROMPT_ID, RECITATION_FALLBACK_PROMPTS
from goosequill.services.cache_manager import CacheManager
from goosequill.services.conversion_engine import ConversionEngine

MODEL = "gemini-3.5-flash-lite"
PDF = Path("/docs/Acme Holdings Limited/Acme Holdings Limited - Annual Report 2024.pdf")


class FakeOCRClient:
    """Stands in for Gemini, including its recitation filter."""

    def __init__(self, model_name=MODEL, text="# A page\n\nSome transcribed text.",
                 error=None, fallbacks_before_success=0):
        self.model_name = model_name
        self.text = text
        self.error = error
        self.fallbacks_before_success = fallbacks_before_success
        self.calls = 0

    def ocr_page_image(self, img_bytes, prompt=None, max_retries=4, backoff_factor=2.0,
                       status_callback=None, cancel_check=None, prompt_callback=None):
        self.calls += 1
        if prompt_callback:
            prompt_callback(PRESET_PROMPT_ID)
        for index in range(self.fallbacks_before_success):
            if prompt_callback:
                prompt_callback(RECITATION_FALLBACK_PROMPTS[index].id)
        if self.error:
            raise self.error
        return self.text


class TestConversionEngine(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gq_engine_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.cache = CacheManager(cache_dir=self.tmp)

    def _engine(self, client):
        return ConversionEngine(
            ocr_client=client,
            cache_manager=self.cache,
            pdf_renderer=mock.Mock(),
            model_name=MODEL,
        )

    def _convert(self, client, page_idx=0):
        engine = self._engine(client)
        return engine._process_single_page(
            pdf_path=PDF, page_idx=page_idx, total_pages=10,
            img_bytes=b"png", force_reprocess=False, status_cb=None,
        )

    # ------------------------------------------------------------------

    def test_a_converted_page_is_cached(self):
        _, text = self._convert(FakeOCRClient())
        self.assertIn("transcribed text", text)
        self.assertTrue(self.cache.is_page_cached(PDF, 1, MODEL))

    def test_a_page_that_could_not_be_converted_is_not_cached(self):
        """The note used to be written to the page file, where it counted as done."""
        client = FakeOCRClient(error=RuntimeError("blocked due to copyright/recitation"))
        _, text = self._convert(client)

        self.assertIn("could not be converted", text, "the caller is still told")
        self.assertFalse(self.cache.is_page_cached(PDF, 1, MODEL),
                         "a page that failed must stay findable by a retry")
        self.assertFalse(self.cache.get_page_cache_path(PDF, 1, MODEL).exists())

    def test_a_failed_page_is_attempted_again_next_run(self):
        failing = FakeOCRClient(error=RuntimeError("blocked"))
        self._convert(failing)

        working = FakeOCRClient()
        _, text = self._convert(working)
        self.assertEqual(working.calls, 1, "the page was asked for again")
        self.assertIn("transcribed text", text)
        self.assertTrue(self.cache.is_page_cached(PDF, 1, MODEL))

    def test_an_empty_answer_is_not_cached_as_a_conversion(self):
        _, _ = self._convert(FakeOCRClient(text="   "))
        self.assertFalse(self.cache.is_page_cached(PDF, 1, MODEL))

    # --- provenance ---------------------------------------------------

    def test_an_ordinary_page_records_the_preset(self):
        self._convert(FakeOCRClient())
        provenance = self.cache.read_page_provenance(PDF, 1, MODEL)
        self.assertNotIn("prompt", provenance)

    def test_a_page_rescued_by_a_fallback_records_which_one(self):
        """Otherwise a page converted under duress is indistinguishable."""
        self._convert(FakeOCRClient(fallbacks_before_success=2))

        provenance = self.cache.read_page_provenance(PDF, 1, MODEL)
        self.assertEqual(provenance.get("prompt"), RECITATION_FALLBACK_PROMPTS[1].id)


if __name__ == "__main__":
    unittest.main()
