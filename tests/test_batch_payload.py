"""What goes into a batch payload, and what is refused before anything renders.

Two failures motivate these tests. Batch used to resubmit every page whether or
not it was already converted, which on a corpus-sized run means paying twice.
And it used to render the whole selection to disk before discovering the
payload exceeded the File API's limit, so the first sign of trouble was a
rejected upload after gigabytes of work.
"""

import os
import sys
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.batch_service import BatchService
from goosequill.services.cache_manager import CacheManager

MODEL = "gemini-3.5-flash-lite"


class FakeRenderer:
    """Every document has the same page count; every page renders to one byte."""

    def __init__(self, pages_per_doc=4, page_bytes=1):
        self.pages_per_doc = pages_per_doc
        self.page_bytes = page_bytes
        self.rendered = []

    def get_page_count(self, path):
        return self.pages_per_doc

    def render_page_from_path(self, path, page_num, dpi=200):
        self.rendered.append((Path(path).name, page_num))
        return b"\x00" * self.page_bytes


class TestBatchPayload(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gq_payload_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        patcher = mock.patch("goosequill.services.genai_factory.load_dotenv", lambda *a, **k: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for var in ("GOOSEQUILL_USE_VERTEX", "GOOGLE_GENAI_USE_VERTEXAI"):
            os.environ.pop(var, None)

        self.docs_dir = self.tmp / "Acme Holdings Limited"
        self.docs_dir.mkdir(parents=True)
        self.pdfs = []
        for year in (2023, 2024):
            pdf = self.docs_dir / f"Acme Holdings Limited - Annual Report {year}.pdf"
            pdf.write_bytes(b"%PDF-1.4\n")
            self.pdfs.append(pdf)

        self.cache = CacheManager(cache_dir=self.tmp / ".cache")
        self.renderer = FakeRenderer()
        self.service = BatchService(cache_manager=self.cache, pdf_renderer=self.renderer)
        self.service.client = mock.MagicMock()
        # ``name`` is reserved by Mock's constructor, so it has to be set after.
        uploaded = mock.Mock()
        uploaded.name = "files/abc"
        self.service.client.files.upload.return_value = uploaded
        created = mock.Mock()
        created.name = "batches/xyz"
        self.service.client.batches.create.return_value = created

    def _submit(self, **kwargs):
        return self.service.create_batch_job(
            pdf_paths=[str(p) for p in self.pdfs], model_name=MODEL, **kwargs
        )

    def _payload_keys(self, job):
        jsonl = self.service.batch_dir / f"{job['id']}.jsonl"
        return [json.loads(line)["key"] for line in jsonl.read_text().splitlines() if line.strip()]

    # ------------------------------------------------------------------

    def test_pages_already_converted_by_this_model_are_left_out(self):
        self.cache.write_page_cache(self.pdfs[0], 1, "already done", MODEL)
        self.cache.write_page_cache(self.pdfs[0], 2, "already done", MODEL)

        job = self._submit()

        self.assertEqual(job["total_requests"], 6, "8 pages minus the 2 already cached")
        self.assertNotIn((self.pdfs[0].name, 1), self.renderer.rendered,
                         "a cached page was rendered anyway")
        self.assertIn((self.pdfs[0].name, 3), self.renderer.rendered)

    def test_a_page_cached_by_a_different_model_is_still_submitted(self):
        """Cross-model reuse is the bug, not the feature."""
        self.cache.write_page_cache(self.pdfs[0], 1, "done by 3.1", "gemini-3.1-flash-lite")

        job = self._submit()
        self.assertEqual(job["total_requests"], 8)

    def test_skip_cached_false_forces_a_genuine_reconversion(self):
        self.cache.write_page_cache(self.pdfs[0], 1, "already done", MODEL)

        job = self._submit(skip_cached=False)
        self.assertEqual(job["total_requests"], 8)

    def test_a_fully_cached_selection_is_refused_rather_than_submitted_empty(self):
        for pdf in self.pdfs:
            for page in range(1, 5):
                self.cache.write_page_cache(pdf, page, "done", MODEL)

        with self.assertRaises(ValueError) as ctx:
            self._submit()
        message = str(ctx.exception)
        self.assertIn("already been converted", message)
        self.assertIn("skip_cached=False", message, "must say how to override")
        self.assertEqual(self.renderer.rendered, [], "nothing should have been rendered")

    def test_an_oversized_selection_is_refused_before_anything_renders(self):
        self.renderer.pages_per_doc = self.service.max_pages_per_job()

        with self.assertRaises(ValueError) as ctx:
            self._submit()
        message = str(ctx.exception)
        self.assertIn("too large for one batch job", message)
        self.assertIn("one per company folder", message, "must say what to do instead")
        self.assertEqual(self.renderer.rendered, [], "refusal came too late to help")

    def test_an_unexpectedly_heavy_corpus_stops_at_the_real_boundary(self):
        """The up-front check is an average; the hard stop is the actual size."""
        self.service.MAX_BATCH_FILE_BYTES = 5_000
        self.service.ESTIMATED_BYTES_PER_PAGE = 1  # so the estimate waves it through
        self.renderer.page_bytes = 4_000

        with self.assertRaises(ValueError) as ctx:
            self._submit()
        self.assertIn("too large for one batch job", str(ctx.exception))
        # The half-written payload must not be left lying around.
        self.assertEqual(list(self.service.batch_dir.glob("*.jsonl")), [])

    def test_the_mapping_covers_exactly_what_was_submitted(self):
        self.cache.write_page_cache(self.pdfs[0], 1, "already done", MODEL)
        job = self._submit()

        mapping = json.loads(Path(job["mapping_file"]).read_text())
        self.assertEqual(len(mapping), job["total_requests"])
        self.assertEqual(sorted(mapping.keys()), sorted(self._payload_keys(job)))
        self.assertNotIn("doc000_p001", mapping, "the cached page leaked into the payload")


if __name__ == "__main__":
    unittest.main()
