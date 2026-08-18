import sys
from pathlib import Path
import unittest
import shutil

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.cache_manager import CacheManager

class TestCacheManager(unittest.TestCase):
    def setUp(self):
        self.test_cache_dir = PROJECT_ROOT / ".cache" / "unit_test_cache"
        self.test_cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_mgr = CacheManager(cache_dir=self.test_cache_dir)
        self.dummy_pdf = PROJECT_ROOT / "documents" / "TestCompany" / "Report2024.pdf"

    def tearDown(self):
        if self.test_cache_dir.exists():
            shutil.rmtree(self.test_cache_dir, ignore_errors=True)

    def test_cache_write_and_read(self):
        content = "## Balance Sheet\n| Asset | Value |\n| Cash | £10,000 |"
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, content)

        self.assertTrue(self.cache_mgr.is_page_cached(self.dummy_pdf, 1))
        self.assertFalse(self.cache_mgr.is_page_cached(self.dummy_pdf, 2))

        read_content = self.cache_mgr.read_page_cache(self.dummy_pdf, 1)
        self.assertEqual(read_content, content)

    def test_count_cached_pages(self):
        self.cache_mgr.write_page_cache(self.dummy_pdf, 1, "Page 1")
        self.cache_mgr.write_page_cache(self.dummy_pdf, 2, "Page 2")
        self.cache_mgr.write_page_cache(self.dummy_pdf, 3, "Page 3")

        count = self.cache_mgr.count_cached_pages(self.dummy_pdf, 5)
        self.assertEqual(count, 3)

    def test_job_status_roundtrip(self):
        status_data = {"is_running": True, "percent": 55.5, "current_file": "Report.pdf"}
        self.cache_mgr.write_job_status(status_data)

        loaded = self.cache_mgr.read_job_status()
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.get("current_file"), "Report.pdf")
        self.assertEqual(loaded.get("percent"), 55.5)

if __name__ == "__main__":
    unittest.main()
