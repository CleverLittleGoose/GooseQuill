import sys
from pathlib import Path
import unittest
import shutil

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.cache_manager import CacheManager

MODEL = "gemini-3.5-flash-lite"
OTHER_MODEL = "gemini-3.1-flash-lite"


class TestCacheManager(unittest.TestCase):
    def setUp(self):
        self.test_cache_dir = PROJECT_ROOT / ".cache" / "unit_test_cache"
        self.test_cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_mgr = CacheManager(cache_dir=self.test_cache_dir)
        self.dummy_pdf = PROJECT_ROOT / "documents" / "TestCompany" / "Report2024.pdf"

    def tearDown(self):
        if self.test_cache_dir.exists():
            shutil.rmtree(self.test_cache_dir, ignore_errors=True)

    def _write_legacy(self, page_num: int, content: str) -> Path:
        """Put a page where a pre-model-keyed run would have left it."""
        path = self.cache_mgr.get_legacy_page_cache_path(self.dummy_pdf, page_num)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_cache_write_and_read(self):
        content = "## Balance Sheet\n| Asset | Value |\n| Cash | £10,000 |"
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, content, MODEL)

        self.assertTrue(self.cache_mgr.is_page_cached(self.dummy_pdf, 1, MODEL))
        self.assertFalse(self.cache_mgr.is_page_cached(self.dummy_pdf, 2, MODEL))

        read_content = self.cache_mgr.read_page_cache(self.dummy_pdf, 1, MODEL)
        self.assertEqual(read_content, content)

    def test_count_cached_pages(self):
        for page in (1, 2, 3):
            self.cache_mgr.write_page_cache(self.dummy_pdf, page, f"Page {page}", MODEL)

        count = self.cache_mgr.count_cached_pages(self.dummy_pdf, 5, MODEL)
        self.assertEqual(count, 3)

    def test_a_page_converted_by_one_model_is_not_served_for_another(self):
        """The whole point of keying by model: no silent cross-model reuse."""
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "transcribed by 3.5", MODEL)

        self.assertFalse(self.cache_mgr.is_page_cached(self.dummy_pdf, 1, OTHER_MODEL))
        self.assertIsNone(self.cache_mgr.read_page_cache(self.dummy_pdf, 1, OTHER_MODEL))
        self.assertEqual(self.cache_mgr.count_cached_pages(self.dummy_pdf, 1, OTHER_MODEL), 0)

    def test_the_model_is_recorded_in_the_page_file(self):
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "# Page one", MODEL)

        raw = self.cache_mgr.get_page_cache_path(self.dummy_pdf, 1, MODEL).read_text(encoding="utf-8")
        self.assertTrue(raw.startswith("<!-- goosequill:"))
        self.assertIn(f"model={MODEL}", raw.splitlines()[0])

        provenance = self.cache_mgr.read_page_provenance(self.dummy_pdf, 1, MODEL)
        self.assertEqual(provenance.get("model"), MODEL)
        self.assertIn("converted", provenance)

    def test_the_prompt_that_produced_a_page_is_recorded(self):
        """A summary and a transcription are the same thing on disk otherwise."""
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "# Page one", MODEL,
                                        prompt="summary-of-last-resort")

        provenance = self.cache_mgr.read_page_provenance(self.dummy_pdf, 1, MODEL)
        self.assertEqual(provenance.get("prompt"), "summary-of-last-resort")
        self.assertEqual(provenance.get("model"), MODEL)

    def test_an_ordinary_conversion_carries_no_prompt_field(self):
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "# Page one", MODEL)
        self.assertNotIn("prompt", self.cache_mgr.read_page_provenance(self.dummy_pdf, 1, MODEL))

    def test_a_longer_stamp_does_not_make_a_page_look_empty(self):
        """The empty-page floor is the shortest stamp; a named prompt is longer."""
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "x", MODEL,
                                        prompt="verbatim-public-record")
        self.assertTrue(self.cache_mgr.is_page_cached(self.dummy_pdf, 1, MODEL))
        self.assertEqual(self.cache_mgr.cached_page_numbers(self.dummy_pdf, MODEL), {1})

    def test_provenance_never_reaches_the_caller(self):
        """A stamp is bookkeeping; it must not turn up in assembled output."""
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "# Page one", MODEL)
        self.assertEqual(self.cache_mgr.read_page_cache(self.dummy_pdf, 1, MODEL), "# Page one")

    def test_rewriting_a_page_does_not_accumulate_stamps(self):
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "first", MODEL)
        stamped = self.cache_mgr.get_page_cache_path(self.dummy_pdf, 1, MODEL).read_text(encoding="utf-8")
        # Feed a stamped page straight back in, as a re-collection would.
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, stamped, MODEL)

        raw = self.cache_mgr.get_page_cache_path(self.dummy_pdf, 1, MODEL).read_text(encoding="utf-8")
        self.assertEqual(raw.count("<!-- goosequill:"), 1)
        self.assertEqual(self.cache_mgr.read_page_cache(self.dummy_pdf, 1, MODEL), "first")

    def test_an_empty_page_is_not_recorded_as_converted(self):
        """A page the model declined must stay findable by a retry."""
        for empty in ("", "   ", "\n\n"):
            with self.subTest(content=repr(empty)):
                self.assertIsNone(self.cache_mgr.write_page_cache(self.dummy_pdf, 1, empty, MODEL))
                self.assertFalse(self.cache_mgr.is_page_cached(self.dummy_pdf, 1, MODEL))
                self.assertFalse(self.cache_mgr.get_page_cache_path(self.dummy_pdf, 1, MODEL).exists())

    def test_a_page_holding_only_its_stamp_is_not_counted_as_cached(self):
        """Pages written before empty results were rejected must still retry."""
        path = self.cache_mgr.get_page_cache_path(self.dummy_pdf, 1, MODEL)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.cache_mgr._provenance_header(MODEL), encoding="utf-8")

        self.assertFalse(self.cache_mgr.is_page_cached(self.dummy_pdf, 1, MODEL))
        self.assertEqual(self.cache_mgr.count_cached_pages(self.dummy_pdf, 1, MODEL), 0)

    def test_legacy_pages_are_ignored_unless_asked_for(self):
        self._write_legacy(1, "converted by something, we cannot say what")

        self.assertFalse(self.cache_mgr.is_page_cached(self.dummy_pdf, 1, MODEL))
        self.assertIsNone(self.cache_mgr.read_page_cache(self.dummy_pdf, 1, MODEL))

        self.assertTrue(self.cache_mgr.is_page_cached(self.dummy_pdf, 1, MODEL, allow_legacy=True))
        self.assertEqual(
            self.cache_mgr.read_page_cache(self.dummy_pdf, 1, MODEL, allow_legacy=True),
            "converted by something, we cannot say what",
        )

    def test_legacy_pages_are_counted_apart_from_this_model_s_work(self):
        self._write_legacy(1, "old")
        self._write_legacy(2, "old")
        self.cache_mgr.write_page_cache(self.dummy_pdf, 2, "new", MODEL)
        self.cache_mgr.write_page_cache(self.dummy_pdf, 3, "new", MODEL)

        self.assertEqual(self.cache_mgr.count_cached_pages(self.dummy_pdf, 3, MODEL), 2)
        # Page 2 exists under both layouts, so it is this model's work, not legacy.
        self.assertEqual(self.cache_mgr.count_legacy_only_pages(self.dummy_pdf, 3, MODEL), 1)

    def test_a_model_keyed_page_wins_over_a_legacy_one(self):
        self._write_legacy(1, "old transcription")
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "new transcription", MODEL)

        self.assertEqual(
            self.cache_mgr.read_page_cache(self.dummy_pdf, 1, MODEL, allow_legacy=True),
            "new transcription",
        )

    def test_asking_whether_a_page_is_cached_creates_nothing(self):
        """Checking must not litter the cache with a folder per page considered."""
        self.cache_mgr.is_page_cached(self.dummy_pdf, 1, MODEL, allow_legacy=True)
        self.cache_mgr.count_cached_pages(self.dummy_pdf, 50, MODEL)
        self.cache_mgr.read_page_cache(self.dummy_pdf, 1, MODEL)

        created = [p for p in self.test_cache_dir.rglob("*") if p.is_dir()]
        self.assertEqual(created, [], f"read-only calls created {created}")

    def test_a_directory_scan_finds_exactly_the_pages_a_page_by_page_check_does(self):
        """The fast count exists for speed; it must not buy that with accuracy."""
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "one", MODEL)
        self.cache_mgr.write_page_cache(self.dummy_pdf, 3, "three", MODEL)
        self.cache_mgr.write_page_cache(self.dummy_pdf, 12, "twelve", MODEL)

        self.assertEqual(self.cache_mgr.cached_page_numbers(self.dummy_pdf, MODEL), {1, 3, 12})
        self.assertEqual(
            self.cache_mgr.cached_page_numbers(self.dummy_pdf, MODEL),
            {n for n in range(1, 20) if self.cache_mgr.is_page_cached(self.dummy_pdf, n, MODEL)},
        )

    def test_a_stamp_only_page_is_not_scanned_as_converted_either(self):
        """A hole counted as done is a hole that never heals."""
        path = self.cache_mgr.get_page_cache_path(self.dummy_pdf, 2, MODEL)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.cache_mgr._provenance_header(MODEL), encoding="utf-8")
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "one", MODEL)

        self.assertEqual(self.cache_mgr.cached_page_numbers(self.dummy_pdf, MODEL), {1})

    def test_scanning_a_document_with_no_cache_at_all_finds_nothing(self):
        self.assertEqual(self.cache_mgr.cached_page_numbers(self.dummy_pdf, MODEL), set())

    def test_the_scan_is_kept_to_this_model_s_own_work(self):
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "by 3.5", MODEL)
        self.assertEqual(self.cache_mgr.cached_page_numbers(self.dummy_pdf, OTHER_MODEL), set())

    def test_counting_past_the_end_of_a_document_does_not_inflate_it(self):
        """A cache holding more pages than the plan counted is still bounded."""
        for page in (1, 2, 3):
            self.cache_mgr.write_page_cache(self.dummy_pdf, page, f"p{page}", MODEL)
        self.assertEqual(self.cache_mgr.count_cached_pages(self.dummy_pdf, 2, MODEL), 2)

    def test_a_model_name_cannot_escape_the_cache_directory(self):
        path = self.cache_mgr.get_page_cache_path(self.dummy_pdf, 1, "../../etc/passwd")
        self.assertIn(self.test_cache_dir.resolve(), path.resolve().parents)

    def test_job_status_roundtrip(self):
        status_data = {"is_running": True, "percent": 55.5, "current_file": "Report.pdf"}
        self.cache_mgr.write_job_status(status_data)

        loaded = self.cache_mgr.read_job_status()
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.get("current_file"), "Report.pdf")
        self.assertEqual(loaded.get("percent"), 55.5)


if __name__ == "__main__":
    unittest.main()
