import sys
from pathlib import Path
import unittest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.document_repository import DocumentRepository
from goosequill.services.cache_manager import CacheManager

class TestDocumentRepository(unittest.TestCase):
    def setUp(self):
        self.cache_mgr = CacheManager(cache_dir=PROJECT_ROOT / ".cache")
        self.repo = DocumentRepository(cache_manager=self.cache_mgr)

    def test_scan_accounts_directory(self):
        accounts_dir = PROJECT_ROOT / "Accounts"
        if accounts_dir.exists():
            result = self.repo.scan_directory(accounts_dir, model_name="gemini-3.5-flash-lite")
            self.assertIn("folders", result)
            self.assertIn("stats", result)
            self.assertIn("pricing", result)
            self.assertTrue(isinstance(result["folders"], list))

    def test_nonexistent_document_info(self):
        fake_pdf = PROJECT_ROOT / "Accounts" / "GhostFolder" / "Ghost.pdf"
        doc_info = self.repo.get_document_info(fake_pdf)
        self.assertEqual(doc_info.name, "Ghost.pdf")
        self.assertIsNotNone(doc_info.error)

if __name__ == "__main__":
    unittest.main()
