import shutil
import tempfile
import unittest
from pathlib import Path

from goosequill.services.search_service import SearchService


class TestSearchService(unittest.TestCase):
    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.service = SearchService()

        acme = self.test_dir / "Acme Holdings Limited" / "Markdown"
        acme.mkdir(parents=True)
        (acme / "Acme Holdings Limited - Annual Report 2025.md").write_text(
            "# Acme Holdings Limited\n"
            "\n"
            "<!-- Page 1 -->\n"
            "## Page 1\n"
            "\n"
            "Revenue for the year was £4.2 million.\n"
            "\n"
            "<!-- Page 2 -->\n"
            "## Page 2\n"
            "\n"
            "The dividend was held flat. A further dividend is not proposed.\n",
            encoding="utf-8",
        )

        beta = self.test_dir / "Beta Trading PLC" / "Markdown"
        beta.mkdir(parents=True)
        (beta / "Beta Trading PLC - Annual Report 2025.md").write_text(
            "# Beta Trading PLC\n"
            "\n"
            "<!-- Page 1 -->\n"
            "## Page 1\n"
            "\n"
            "No distribution was made.\n",
            encoding="utf-8",
        )

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_finds_matches_and_counts_them(self):
        result = self.service.search(self.test_dir, "dividend")
        self.assertEqual(result["documents_matched"], 1)
        self.assertEqual(result["total_matches"], 2)
        self.assertEqual(result["documents_searched"], 2)
        self.assertEqual(result["results"][0]["folder"], "Acme Holdings Limited")

    def test_attributes_matches_to_their_page(self):
        result = self.service.search(self.test_dir, "Revenue")
        match = result["results"][0]["matches"][0]
        self.assertEqual(match["page"], 1)

        result = self.service.search(self.test_dir, "held flat")
        match = result["results"][0]["matches"][0]
        self.assertEqual(match["page"], 2)

    def test_snippet_locates_the_match_within_itself(self):
        result = self.service.search(self.test_dir, "£4.2 million")
        match = result["results"][0]["matches"][0]
        located = match["text"][match["match_start"]:match["match_end"]]
        self.assertEqual(located, "£4.2 million")

    def test_case_sensitivity(self):
        self.assertEqual(self.service.search(self.test_dir, "REVENUE")["total_matches"], 1)
        self.assertEqual(
            self.service.search(self.test_dir, "REVENUE", match_case=True)["total_matches"], 0
        )

    def test_whole_word(self):
        # "distribution" must not be found when searching for "distribut"
        self.assertEqual(self.service.search(self.test_dir, "distribut")["total_matches"], 1)
        self.assertEqual(
            self.service.search(self.test_dir, "distribut", whole_word=True)["total_matches"], 0
        )

    def test_query_is_treated_as_literal_text(self):
        """A regex metacharacter must match itself, not act as a pattern."""
        self.assertEqual(self.service.search(self.test_dir, "£4.2")["total_matches"], 1)
        self.assertEqual(self.service.search(self.test_dir, "£4x2")["total_matches"], 0)
        self.assertEqual(self.service.search(self.test_dir, ".*")["total_matches"], 0)

    def test_empty_query_returns_nothing(self):
        result = self.service.search(self.test_dir, "   ")
        self.assertEqual(result["results"], [])
        self.assertEqual(result["total_matches"], 0)

    def test_resolves_the_pdf_beside_the_markdown_folder(self):
        result = self.service.search(self.test_dir, "Revenue")
        entry = result["results"][0]
        self.assertTrue(entry["pdf_path"].endswith("Acme Holdings Limited - Annual Report 2025.pdf"))
        self.assertNotIn("Markdown", Path(entry["pdf_path"]).parent.name)

    def test_per_document_match_cap_does_not_affect_the_count(self):
        result = self.service.search(self.test_dir, "dividend", max_matches_per_document=1)
        entry = result["results"][0]
        self.assertEqual(len(entry["matches"]), 1)
        self.assertEqual(entry["match_count"], 2)

    def test_reconverted_document_is_picked_up(self):
        """The cache keys on size and mtime, so rewriting a file must be seen."""
        self.assertEqual(self.service.search(self.test_dir, "sustainability")["total_matches"], 0)

        target = self.test_dir / "Beta Trading PLC" / "Markdown" / "Beta Trading PLC - Annual Report 2025.md"
        target.write_text(
            "<!-- Page 1 -->\n## Page 1\n\nOur sustainability report follows.\n", encoding="utf-8"
        )

        self.assertEqual(self.service.search(self.test_dir, "sustainability")["total_matches"], 1)

    def test_missing_root_is_not_an_error(self):
        result = self.service.search(self.test_dir / "nope", "anything")
        self.assertEqual(result["results"], [])
        self.assertEqual(result["documents_searched"], 0)


if __name__ == "__main__":
    unittest.main()
