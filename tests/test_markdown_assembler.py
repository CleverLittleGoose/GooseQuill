import sys
from pathlib import Path
import unittest
import shutil

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.markdown_assembler import MarkdownAssembler

class TestMarkdownAssembler(unittest.TestCase):
    def setUp(self):
        self.test_dir = PROJECT_ROOT / ".cache" / "unit_test_md"
        self.test_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        if self.test_dir.exists():
            shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_assemble_document(self):
        pages = ["# Balance Sheet\nAssets: £100", "## Profit and Loss\nRevenue: £500"]
        assembled = MarkdownAssembler.assemble_document(
            stem="Annual_Report_2024",
            source_name="Annual_Report_2024.pdf",
            model_name="gemini-3.5-flash-lite",
            total_pages=2,
            page_results=pages
        )

        self.assertIn("# Annual_Report_2024", assembled)
        self.assertIn("> Source Document: `Annual_Report_2024.pdf`", assembled)
        self.assertIn("<!-- Page 1 -->", assembled)
        self.assertIn("## Page 1", assembled)
        self.assertIn("<!-- Page 2 -->", assembled)
        self.assertIn("## Page 2", assembled)
        self.assertIn("Assets: £100", assembled)
        self.assertIn("Revenue: £500", assembled)

    def test_split_into_pages(self):
        sample_md = """# Sample Report
> Total Pages: 2

---

<!-- Page 1 -->
## Page 1

Content for page one.

---

<!-- Page 2 -->
## Page 2

Content for page two.
"""
        split_dict = MarkdownAssembler.split_into_pages(sample_md)
        self.assertIn(1, split_dict)
        self.assertIn(2, split_dict)
        self.assertIn("Content for page one.", split_dict[1])
        self.assertIn("Content for page two.", split_dict[2])

    def test_clean_page_markdown(self):
        fenced_md = "```markdown\n## Strategic Report\n\nRevenue grew by 15%.\n```"
        cleaned = MarkdownAssembler.clean_page_markdown(fenced_md)
        self.assertEqual(cleaned, "## Strategic Report\n\nRevenue grew by 15%.")

        plain_md = "## Balance Sheet\n\nTotal Assets: £10,000"
        self.assertEqual(MarkdownAssembler.clean_page_markdown(plain_md), plain_md)

        bare_fence = "```\n# Notice of Charge\n\nBody text.\n```"
        self.assertEqual(MarkdownAssembler.clean_page_markdown(bare_fence), "# Notice of Charge\n\nBody text.")

    def test_clean_page_markdown_preserves_pages_with_two_code_blocks(self):
        """A page that merely starts and ends with a fence must not be unwrapped."""
        page = (
            "```\n"
            "NOTICE OF CHARGE\n"
            "```\n"
            "\n"
            "Some real body text of the filing.\n"
            "\n"
            "```\n"
            "SCHEDULE 2\n"
            "```"
        )
        self.assertEqual(MarkdownAssembler.clean_page_markdown(page), page)

    def test_clean_page_markdown_preserves_genuine_code_blocks(self):
        """A fence with a real info string delimits document content, not an LLM wrapper."""
        for src in ("```python\nprint(1)\n```", "```sql\nSELECT 1;\n```"):
            self.assertEqual(MarkdownAssembler.clean_page_markdown(src), src)

    def test_clean_page_markdown_preserves_unbalanced_fence(self):
        """An opening fence with no closing fence is left exactly as transcribed."""
        src = "```\nstuff without a closing fence"
        self.assertEqual(MarkdownAssembler.clean_page_markdown(src), src)

    def test_save_and_read_document(self):
        target_path = self.test_dir / "subdir" / "test.md"
        content = "# Testing Save and Read"
        MarkdownAssembler.save_document(target_path, content)
        
        self.assertTrue(target_path.exists())
        read_back = MarkdownAssembler.read_document(target_path)
        self.assertEqual(read_back, content)

if __name__ == "__main__":
    unittest.main()
