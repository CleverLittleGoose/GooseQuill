import os
import sys
import unittest
import tempfile
import shutil
from pathlib import Path
from starlette.testclient import TestClient

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.markdown_combiner import MarkdownCombinerService
import app as app_module
from app import app

class TestMarkdownCombiner(unittest.TestCase):
    """Unit tests for MarkdownCombinerService and related endpoints/CLI."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="goosequill_combiner_test_")
        self.temp_path = Path(self.temp_dir).resolve()

        # The API confines all file access to the active documents root, so point
        # that root at this test's sandbox for the duration of the test.
        self._original_root = app_module.BASE_ACCOUNTS_DIR
        app_module.BASE_ACCOUNTS_DIR = self.temp_path

        # Create sample markdown documents with various years and headers
        self.doc1 = self.temp_path / "Acme Corp - Annual Report 2019.md"
        self.doc1.write_text(
            "# Acme Corp - Annual Report 2019\n\n"
            "> Source Document: `Acme Corp - Annual Report 2019.pdf`  \n"
            "> Total Pages: 2  \n\n"
            "---\n\n"
            "<!-- Page 1 -->\n## Page 1\n\nBalance Sheet 2019: £100m\n\n---\n\n"
            "<!-- Page 2 -->\n## Page 2\n\nProfit & Loss 2019: £20m\n",
            encoding="utf-8"
        )

        self.doc2 = self.temp_path / "Acme Corp - Annual Report 2020.md"
        self.doc2.write_text(
            "# Acme Corp - Annual Report 2020\n\n"
            "> Source Document: `Acme Corp - Annual Report 2020.pdf`  \n"
            "> Total Pages: 2  \n\n"
            "---\n\n"
            "<!-- Page 1 -->\n## Page 1\n\nBalance Sheet 2020: £120m\n\n---\n\n"
            "<!-- Page 2 -->\n## Page 2\n\nProfit & Loss 2020: £25m\n",
            encoding="utf-8"
        )

        self.doc3 = self.temp_path / "Acme Corp - Annual Report 2021.md"
        self.doc3.write_text(
            "# Acme Corp - Annual Report 2021\n\n"
            "> Source Document: `Acme Corp - Annual Report 2021.pdf`  \n"
            "> Total Pages: 1  \n\n"
            "---\n\n"
            "<!-- Page 1 -->\n## Page 1\n\nBalance Sheet 2021: £150m\n",
            encoding="utf-8"
        )

        self.client = TestClient(app)

    def tearDown(self):
        app_module.BASE_ACCOUNTS_DIR = self._original_root
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_extract_year(self):
        """Verify 4-digit year extraction from various filenames."""
        self.assertEqual(MarkdownCombinerService.extract_year_from_name("Report 2019.md"), 2019)
        self.assertEqual(MarkdownCombinerService.extract_year_from_name("Company_Accounts_2024_Final.pdf"), 2024)
        self.assertEqual(MarkdownCombinerService.extract_year_from_name("Mortgage or Charge 1.pdf"), 9999)

    def test_slug_generation(self):
        """Verify markdown anchor slug formatting."""
        self.assertEqual(
            MarkdownCombinerService.generate_slug("1. Acme Corp - Annual Report 2019"),
            "1-acme-corp---annual-report-2019"
        )
        self.assertEqual(
            MarkdownCombinerService.generate_slug("Section #3: Balance & Cash!"),
            "section-3-balance-cash"
        )

    def test_chronological_sorting(self):
        """Verify chronological sorting handles out-of-order document lists."""
        items = [
            {"title": "Annual Report 2021", "year": 2021},
            {"title": "Annual Report 2019", "year": 2019},
            {"title": "Annual Report 2020", "year": 2020},
        ]
        sorted_asc = MarkdownCombinerService.sort_documents(items, sort_mode="chronological_asc")
        self.assertEqual([x["title"] for x in sorted_asc], ["Annual Report 2019", "Annual Report 2020", "Annual Report 2021"])

        sorted_desc = MarkdownCombinerService.sort_documents(items, sort_mode="chronological_desc")
        self.assertEqual([x["title"] for x in sorted_desc], ["Annual Report 2021", "Annual Report 2020", "Annual Report 2019"])

    def test_combine_documents_with_toc(self):
        """Verify full document combination with TOC and metadata banners."""
        files = [self.doc3, self.doc1, self.doc2] # Out of order
        result = MarkdownCombinerService.combine(
            file_paths=files,
            master_title="Acme Corp Consolidated Accounts",
            include_toc=True,
            include_source_meta=True,
            strip_original_headers=True,
            sort_mode="chronological_asc"
        )

        self.assertEqual(result["total_documents"], 3)
        self.assertEqual(result["total_pages"], 5)
        self.assertIn("# Acme Corp Consolidated Accounts", result["content"])
        self.assertIn("## 📋 Table of Contents", result["content"])
        self.assertIn("[View Section &rarr;](#1-acme-corp---annual-report-2019)", result["content"])
        self.assertIn("# 1. Acme Corp - Annual Report 2019", result["content"])
        self.assertIn("# 2. Acme Corp - Annual Report 2020", result["content"])
        self.assertIn("# 3. Acme Corp - Annual Report 2021", result["content"])
        self.assertIn("Balance Sheet 2019: £100m", result["content"])
        self.assertIn("<!-- Page 1 -->", result["content"])

    def test_clean_individual_markdown(self):
        """Verify redundant standalone headers are cleanly stripped."""
        raw = (
            "# My Document Stem\n\n"
            "> Source: `file.pdf`  \n"
            "> Converted with Gemini  \n\n"
            "---\n\n"
            "## Page 1\n\nPage 1 body content."
        )
        cleaned = MarkdownCombinerService.clean_individual_markdown(raw)
        self.assertFalse(cleaned.startswith("# My Document Stem"))
        self.assertTrue(cleaned.startswith("## Page 1"))

    def test_save_combined_document(self):
        """Verify file persistence to disk."""
        out_path = self.temp_path / "Sub" / "Consolidated.md"
        saved = MarkdownCombinerService.save_combined_document(out_path, "# Master Consolidated")
        self.assertTrue(saved.exists())
        self.assertEqual(saved.read_text(encoding="utf-8"), "# Master Consolidated")

    def test_api_rejects_paths_outside_root(self):
        """Paths outside the active documents root must be refused, not served."""
        outside = Path(tempfile.mkdtemp(prefix="goosequill_outside_")) / "secret.md"
        outside.write_text("# Not yours", encoding="utf-8")
        try:
            res = self.client.get("/api/markdown", params={"path": str(outside)})
            self.assertEqual(res.status_code, 403)

            res = self.client.post(
                "/api/markdown",
                json={"file_path": str(outside), "content": "overwritten"}
            )
            self.assertEqual(res.status_code, 403)
            self.assertEqual(outside.read_text(encoding="utf-8"), "# Not yours")

            res = self.client.post("/api/combine_markdown", json={
                "files": [str(outside)],
                "save_to_disk": False,
            })
            self.assertEqual(res.status_code, 403)
        finally:
            shutil.rmtree(outside.parent, ignore_errors=True)

    def test_api_rejects_traversal_in_folder_names(self):
        """Folder and filename fields must not be able to escape the root."""
        res = self.client.post("/api/create_folder", json={"folder_name": "../escaped"})
        self.assertEqual(res.status_code, 400)

        res = self.client.post("/api/combine_markdown", json={
            "files": [str(self.doc1)],
            "output_filename": "../escaped.md",
            "save_to_disk": True,
        })
        self.assertEqual(res.status_code, 400)

    def test_api_combine_markdown_endpoint(self):
        """Verify POST /api/combine_markdown endpoint."""
        payload = {
            "files": [str(self.doc1), str(self.doc2)],
            "master_title": "API Test Consolidated",
            "output_filename": "API_Consolidated.md",
            "include_toc": True,
            "save_to_disk": False,
            "sort_mode": "chronological_asc"
        }
        res = self.client.post("/api/combine_markdown", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["total_documents"], 2)
        self.assertIn("Table of Contents", data["content"])

    def test_api_converted_markdowns_endpoint(self):
        """Verify GET /api/converted_markdowns returns list."""
        res = self.client.get("/api/converted_markdowns")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("files", data)

if __name__ == "__main__":
    unittest.main()
