import os
import sys
import unittest
from unittest import mock
import tempfile
import shutil
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.boilerplate_detector import BoilerplateDetector
from goosequill.services.search_service import LIGHTWEIGHT_DIR_NAME, is_lightweight


class TestBoilerplateDetector(unittest.TestCase):
    """Unit tests for BoilerplateDetector service and deflation pipeline."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="goosequill_deflate_test_")
        self.temp_path = Path(self.temp_dir).resolve()

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_strip_scaffolding(self):
        """Verify page headers, footers, page markers, and stamps are cleanly removed."""
        raw = (
            "TUESDAY\n"
            "A7\n"
            "*AEB0S03V*\n"
            "20/05/2024\n"
            "COMPANIES HOUSE\n"
            "# Acme Corp - Annual Report 2024\n\n"
            "<!-- Page 1 -->\n"
            "## Page 1\n\n"
            "Acme Corp Limited\n"
            "Annual Report and financial statements\n"
            "Registered number 01234567\n"
            "52 weeks ended 28 December 2024\n\n"
            "## Strategic Report\n"
            "The company had a strong year.\n\n"
            "---\n\n"
            "Registered number 01234567 / 52 weeks ended 28 December 2024 | 1\n\n"
            "---\n"
            "---\n\n"
            "<!-- Page 2 -->\n"
            "## Page 2\n\n"
            "Acme Corp Limited\n"
            "Annual Report and financial statements\n"
            "Registered number 01234567\n"
            "52 weeks ended 28 December 2024\n\n"
            "## Directors' Report\n"
            "Dividends of £10m paid.\n"
        )
        cleaned = BoilerplateDetector.strip_scaffolding(raw)

        self.assertNotIn("COMPANIES HOUSE", cleaned)
        self.assertNotIn("*AEB0S03V*", cleaned)
        self.assertNotIn("<!-- Page 1 -->", cleaned)
        self.assertNotIn("## Page 1", cleaned)
        self.assertNotIn("<!-- Page 2 -->", cleaned)
        self.assertNotIn("## Page 2", cleaned)
        self.assertNotIn("Registered number 01234567 / 52 weeks ended 28 December 2024 | 1", cleaned)
        self.assertIn("The company had a strong year.", cleaned)
        self.assertIn("Dividends of £10m paid.", cleaned)

    def test_split_into_sections(self):
        """Verify markdown content splits cleanly along heading boundaries."""
        content = (
            "# Document Title\n\n"
            "Preamble text\n\n"
            "## Strategic Report\n"
            "Strategic content here.\n\n"
            "### Business performance\n"
            "KPIs and profits.\n\n"
            "## Balance Sheet\n\n"
            "| Asset | 2024 |\n|---|---:|\n| Cash | 100 |\n"
        )
        sections = BoilerplateDetector._split_into_sections(content)
        self.assertEqual(len(sections), 4)

        self.assertEqual(sections[0]["heading"], "Document Title")
        self.assertFalse(sections[0]["has_table"])

        self.assertEqual(sections[1]["heading"], "Strategic Report")
        self.assertFalse(sections[1]["has_table"])

        self.assertEqual(sections[2]["heading"], "Business performance")
        self.assertFalse(sections[2]["has_table"])

        self.assertEqual(sections[3]["heading"], "Balance Sheet")
        self.assertTrue(sections[3]["has_table"])

    def test_normalization(self):
        """Verify entity-specific tokens (dates, amounts, company names) are masked."""
        names = {"Acme Corp Limited", "Acme Corp"}
        text1 = "Acme Corp Limited made a profit of £1,234,567 in the year ended 28 December 2024."
        text2 = "Beta Holdings made a profit of £9,999,999 in the year ended 31 December 2023."

        norm1 = BoilerplateDetector._normalize(text1, company_names=names)
        self.assertIn("{company}", norm1)
        self.assertIn("{amount}", norm1)
        self.assertIn("{date}", norm1)

    def test_protected_sections(self):
        """Verify critical sections are protected and responsibilities statement is marked boilerplate."""
        # 1. Going concern note -> MUST BE PROTECTED
        self.assertTrue(
            BoilerplateDetector._is_protected(
                "Going concern",
                "The financial statements have not been prepared on a going concern basis."
            )
        )

        # 2. Business performance -> MUST BE PROTECTED
        self.assertTrue(
            BoilerplateDetector._is_protected(
                "Business performance",
                "The results show a profit before tax of £500k."
            )
        )

        # 3. Directors list with appointments -> MUST BE PROTECTED
        self.assertTrue(
            BoilerplateDetector._is_protected(
                "Directors",
                "The directors who held office were: J Smith (appointed 1 Jan 2024), A Jones."
            )
        )

        # 4. Statement of Directors' Responsibilities -> MUST NOT BE PROTECTED (it is boilerplate)
        self.assertFalse(
            BoilerplateDetector._is_protected(
                "Statement of Directors' Responsibilities in respect of the Strategic Report, the Directors' Report and the financial statements",
                "The Directors are responsible for preparing the financial statements in accordance with applicable law and regulations."
            )
        )

    def test_deflate_pipeline_with_mock_files(self):
        """Verify full deflation across multiple files, preserving unique data and removing boilerplate."""
        company_dir = self.temp_path / "Acme Theme Parks Limited" / "Markdown"
        company_dir.mkdir(parents=True)

        boilerplate_duty_block = (
            "The Directors are responsible for preparing the Strategic Report, "
            "the Directors' Report and the financial statements in accordance with applicable law and regulations. "
            "Company law requires the Directors to prepare financial statements for each financial year. "
            "Under that law the Directors have elected to prepare the financial statements in accordance with "
            "applicable United Kingdom accounting standards and applicable law. "
            "In preparing these financial statements, the Directors are required to select suitable accounting policies "
            "and then apply them consistently, make judgements and estimates that are reasonable and prudent, "
            "and state whether applicable UK accounting standards have been followed."
        )

        doc_2023 = company_dir / "Acme Theme Parks Limited - Annual Report 2023.md"
        doc_2023.write_text(
            "# Acme Theme Parks Limited - Annual Report 2023\n\n"
            "## Strategic Report\n\n"
            "### Business performance\n"
            "Profit before tax was £5,000,000.\n\n"
            "## Directors' Report\n\n"
            "### Directors\n"
            "* J Smith\n* A Brown\n\n"
            "## Statement of Directors' Responsibilities\n\n"
            f"{boilerplate_duty_block}\n\n"
            "## Balance sheet\n\n"
            "| Item | 2023 (£) |\n|---|---:|\n| Net Assets | 50,000,000 |\n",
            encoding="utf-8"
        )

        doc_2024 = company_dir / "Acme Theme Parks Limited - Annual Report 2024.md"
        doc_2024.write_text(
            "# Acme Theme Parks Limited - Annual Report 2024\n\n"
            "## Strategic Report\n\n"
            "### Business performance\n"
            "Profit before tax was £6,200,000.\n\n"
            "## Directors' Report\n\n"
            "### Directors\n"
            "* J Smith\n* A Brown\n* C Davies (appointed 1 Feb 2024)\n\n"
            "## Statement of Directors' Responsibilities\n\n"
            f"{boilerplate_duty_block}\n\n"
            "## Balance sheet\n\n"
            "| Item | 2024 (£) |\n|---|---:|\n| Net Assets | 56,200,000 |\n",
            encoding="utf-8"
        )

        doc_2025 = company_dir / "Acme Theme Parks Limited - Annual Report 2025.md"
        doc_2025.write_text(
            "# Acme Theme Parks Limited - Annual Report 2025\n\n"
            "## Strategic Report\n\n"
            "### Business performance\n"
            "Profit before tax was £7,100,000.\n\n"
            "## Directors' Report\n\n"
            "### Directors\n"
            "* J Smith\n* C Davies\n\n"
            "## Statement of Directors' Responsibilities\n\n"
            f"{boilerplate_duty_block}\n\n"
            "## Balance sheet\n\n"
            "| Item | 2025 (£) |\n|---|---:|\n| Net Assets | 63,300,000 |\n",
            encoding="utf-8"
        )

        # Run deflation on the 3 files
        results = BoilerplateDetector.deflate_corpus(
            root_dir=self.temp_path,
            mode="algorithmic",
            threshold=3,
        )

        self.assertEqual(results["files_deflated"], 3)
        self.assertGreater(results["total_reduction_pct"], 0)

        # Verify lightweight files created in Lightweight/
        lite_dir = self.temp_path / "Acme Theme Parks Limited" / LIGHTWEIGHT_DIR_NAME
        self.assertTrue(lite_dir.exists())

        lite_2024 = lite_dir / "Acme Theme Parks Limited - Annual Report 2024.md"
        self.assertTrue(lite_2024.exists())
        self.assertTrue(is_lightweight(lite_2024))

        lite_content = lite_2024.read_text(encoding="utf-8")

        # The duty block is one company restating itself, so the earliest filing
        # keeps it in full and the later ones point back at that copy.
        self.assertNotIn("select suitable accounting policies and then apply them consistently", lite_content)
        self.assertIn("[DEFLATED — Statement of Directors' Responsibilities", lite_content)
        self.assertIn("Acme Theme Parks Limited - Annual Report 2023.md", lite_content)

        canonical = (lite_dir / "Acme Theme Parks Limited - Annual Report 2023.md").read_text(encoding="utf-8")
        self.assertIn("select suitable accounting policies", canonical)

        # Verify critical narrative, directors list, and balance sheet table were PRESERVED
        self.assertIn("Business performance", lite_content)
        self.assertIn("Profit before tax was £6,200,000.", lite_content)
        self.assertIn("C Davies (appointed 1 Feb 2024)", lite_content)
        self.assertIn("Net Assets", lite_content)
        self.assertIn("56,200,000", lite_content)

        # Verify report generation
        report = BoilerplateDetector.generate_report(results)
        self.assertIn("Corpus Summary", report)
        # One company, so nothing here is boilerplate — it is that company
        # restating itself, and the report says so in those terms.
        self.assertIn("Passages a Company Restated", report)
        self.assertNotIn("Boilerplate Patterns Detected", report)


    # ── Regressions ────────────────────────────────────────────────────────

    def _write(self, entity: str, name: str, body: str) -> Path:
        d = self.temp_path / entity / "Markdown"
        d.mkdir(parents=True, exist_ok=True)
        f = d / name
        f.write_text(body, encoding="utf-8")
        return f

    def test_page_heading_does_not_swallow_the_page(self):
        """Text under a 'Page N' heading is scaffolding's neighbour, not scaffolding."""
        sections = BoilerplateDetector._split_into_sections(
            "# Report\n\n### Page 4\n\nDividends of £41,000,000 were paid to the parent.\n\n"
            "## Next\n\nOther text.\n"
        )
        joined = "".join(s["body"] for s in sections)
        self.assertIn("£41,000,000", joined)
        self.assertNotIn("Page 4", [s["heading"] for s in sections])

    def test_a_lone_document_is_not_boilerplate_to_itself(self):
        """One filing has no repetition to observe, so only scaffolding goes."""
        unique = "Interest rate risk on the group's external borrowings is monitored by the board. " * 12
        doc = self._write("Acme Limited", "Acme Limited - Annual Report 2024.md",
                          f"# Acme Limited\n\n## Principal risks\n\n{unique}\n")
        results = BoilerplateDetector.deflate_files(file_paths=[doc], root_dir=self.temp_path)
        self.assertTrue(results["corpus_too_small"])
        lite = (self.temp_path / "Acme Limited" / LIGHTWEIGHT_DIR_NAME /
                "Acme Limited - Annual Report 2024.md").read_text(encoding="utf-8")
        self.assertIn("Interest rate risk on the group's external borrowings", lite)

    def test_repetition_is_counted_in_companies_not_filings(self):
        """Three filings by one company are one company's habit, not a standard."""
        block = ("The group's treasury policy is set by the board and reviewed annually "
                 "against the facilities then in place, having regard to covenant headroom. " * 6)
        files = [
            self._write("Acme Limited", f"Acme Limited - Annual Report {y}.md",
                        f"# Acme Limited {y}\n\n## Treasury policy\n\n{block}\n")
            for y in (2022, 2023, 2024)
        ]
        scan = BoilerplateDetector.scan_files(files, threshold=3)
        fp = next(iter(scan["fingerprints"].values()))
        self.assertEqual(len(fp["files"]), 3)
        self.assertEqual(len(fp["entities"]), 1)
        self.assertFalse(BoilerplateDetector._is_boilerplate(fp, threshold=3))

    def test_peer_group_catches_a_shared_template(self):
        """Two shells from the same stack sharing wording is template boilerplate."""
        block = ("The Company has taken advantage of the exemption conferred by section 400 "
                 "of the Companies Act and has not prepared consolidated accounts. " * 6)
        files = [
            self._write("Pinion Alpha Limited", "Pinion Alpha Limited - Annual Report 2023.md",
                        f"# Pinion Alpha\n\n## Basis of preparation\n\n{block}\n"),
            self._write("Pinion Beta Limited", "Pinion Beta Limited - Annual Report 2023.md",
                        f"# Pinion Beta\n\n## Basis of preparation\n\n{block}\n"),
        ]
        scan = BoilerplateDetector.scan_files(files, threshold=5, peer_threshold=2)
        fp = next(iter(scan["fingerprints"].values()))
        self.assertEqual(len(fp["entities"]), 2)
        # Too few companies for the corpus-wide bar, but both are Pinion entities.
        self.assertTrue(BoilerplateDetector._is_boilerplate(fp, threshold=5, peer_threshold=2))

    def test_the_ownership_chain_is_protected(self):
        """Controlling-party notes name the parent — the whole point of the corpus."""
        self.assertTrue(BoilerplateDetector._is_protected(
            "16. Controlling party",
            "The immediate parent undertaking is Quill Midco Limited. The ultimate "
            "controlling party is Quill JVCO Limited, registered in England."
        ))

    def test_a_figure_the_kept_copy_lacks_is_never_removed(self):
        """A passage carrying its own number is not boilerplate, however it hashes."""
        stem = ("The Company has taken advantage of the exemption conferred by section 400 "
                "of the Companies Act and has not prepared consolidated accounts. " * 6)
        files = [
            self._write("Pinion Alpha Limited", "Pinion Alpha Limited - Annual Report 2023.md",
                        f"# Pinion Alpha\n\n## Basis of preparation\n\n{stem}\n"),
            self._write("Pinion Beta Limited", "Pinion Beta Limited - Annual Report 2023.md",
                        f"# Pinion Beta\n\n## Basis of preparation\n\n{stem}\n"),
            self._write("Pinion Gamma Limited", "Pinion Gamma Limited - Annual Report 2023.md",
                        f"# Pinion Gamma\n\n## Basis of preparation\n\n{stem} A dividend of £41,300,000 was paid.\n"),
        ]
        BoilerplateDetector.deflate_files(file_paths=files, root_dir=self.temp_path, threshold=2)
        lite = (self.temp_path / "Pinion Gamma Limited" / LIGHTWEIGHT_DIR_NAME /
                "Pinion Gamma Limited - Annual Report 2023.md").read_text(encoding="utf-8")
        self.assertIn("£41,300,000", lite)

    def test_safe_mode_removes_nothing_when_the_classifier_is_unreachable(self):
        """Safe mode is the verified mode, so an unverified run removes no prose."""
        block = ("The Directors are responsible for preparing the financial statements in "
                 "accordance with applicable law and regulations, and for such internal "
                 "control as they determine is necessary. " * 6)
        files = [
            self._write(f"Company {n} Limited", f"Company {n} Limited - Annual Report 2023.md",
                        f"# Company {n}\n\n## Directors' responsibilities statement\n\n{block}\n")
            for n in ("Alpha", "Beta", "Gamma")
        ]
        with mock.patch(
            "goosequill.services.genai_factory.build_client",
            side_effect=RuntimeError("no API key"),
        ):
            results = BoilerplateDetector.deflate_files(
                file_paths=files, root_dir=self.temp_path, mode="safe", threshold=3,
            )
        self.assertFalse(results["verification"]["available"])
        self.assertEqual(sum(len(fr["sections_removed"]) for fr in results["file_results"]), 0)

        report = BoilerplateDetector.generate_report(results)
        self.assertIn("Not verified", report)

    def test_pointers_name_a_filing_the_reader_will_have(self):
        """A note pointing outside the set you deflated points nowhere."""
        block = ("The Company has taken advantage of the exemption conferred by section 400 "
                 "of the Companies Act and has not prepared consolidated accounts. " * 6)
        outside = self._write("Aardvark Limited", "Aardvark Limited - Annual Report 2023.md",
                              f"# Aardvark\n\n## Basis of preparation\n\n{block}\n")
        inside = [
            self._write("Pinion Alpha Limited", "Pinion Alpha Limited - Annual Report 2023.md",
                        f"# Pinion Alpha\n\n## Basis of preparation\n\n{block}\n"),
            self._write("Pinion Beta Limited", "Pinion Beta Limited - Annual Report 2023.md",
                        f"# Pinion Beta\n\n## Basis of preparation\n\n{block}\n"),
        ]
        # Aardvark sorts first, so it is the scan's canonical copy — but it is
        # not one of the files being written.
        BoilerplateDetector.deflate_files(
            file_paths=inside, reference_paths=[outside] + inside,
            root_dir=self.temp_path, threshold=2,
        )
        lite = (self.temp_path / "Pinion Beta Limited" / LIGHTWEIGHT_DIR_NAME /
                "Pinion Beta Limited - Annual Report 2023.md").read_text(encoding="utf-8")
        self.assertIn("[DEFLATED", lite)
        self.assertIn("Pinion Alpha Limited - Annual Report 2023.md", lite)
        self.assertNotIn("Aardvark", lite)

        # And the filing it names really does still carry the text.
        canonical = (self.temp_path / "Pinion Alpha Limited" / LIGHTWEIGHT_DIR_NAME /
                     "Pinion Alpha Limited - Annual Report 2023.md").read_text(encoding="utf-8")
        self.assertIn("exemption conferred by section 400", canonical)

    def test_report_is_written_clear_of_the_search_index(self):
        """A report at the corpus root competes with the filings it describes."""
        path = BoilerplateDetector.save_report(self.temp_path, "# Report\n")
        self.assertTrue(is_lightweight(path))


if __name__ == "__main__":
    unittest.main()
