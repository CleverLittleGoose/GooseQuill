import re
import unittest

def parse_markdown_pages(full_markdown: str):
    """Python equivalent of the JavaScript page parser logic."""
    page_regex = re.compile(r"(?:<!--\s*Page\s*(\d+)\s*-->|(?:\n|^)#{1,3}\s*Page\s*(\d+)\b)", re.IGNORECASE)
    raw_matches = []
    
    for m in page_regex.finditer(full_markdown):
        p_str = m.group(1) or m.group(2)
        if p_str:
            raw_matches.append({"page_num": int(p_str), "index": m.start()})
            
    if not raw_matches:
        return {1: full_markdown}
        
    matches = []
    for m in raw_matches:
        if matches and matches[-1]["page_num"] == m["page_num"]:
            continue
        matches.append(m)
        
    pages = {}
    for i, cur in enumerate(matches):
        next_idx = matches[i + 1]["index"] if (i + 1 < len(matches)) else len(full_markdown)
        pages[cur["page_num"]] = full_markdown[cur["index"]:next_idx].strip()
        
    return pages

class TestMarkdownSplitter(unittest.TestCase):
    def test_single_page_doc(self):
        doc = "# Document Title\nThis is a single page document."
        pages = parse_markdown_pages(doc)
        self.assertEqual(len(pages), 1)
        self.assertIn(1, pages)
        self.assertEqual(pages[1], doc)

    def test_multi_page_with_comments_and_headers(self):
        doc = (
            "# Main Doc Header\n"
            "<!-- Page 1 -->\n"
            "## Page 1\n"
            "Content of page 1\n"
            "<!-- Page 2 -->\n"
            "## Page 2\n"
            "Content of page 2\n"
            "<!-- Page 3 -->\n"
            "## Page 3\n"
            "Content of page 3\n"
        )
        pages = parse_markdown_pages(doc)
        self.assertEqual(len(pages), 3)
        self.assertIn(1, pages)
        self.assertIn(2, pages)
        self.assertIn(3, pages)
        self.assertIn("Content of page 1", pages[1])
        self.assertIn("Content of page 2", pages[2])
        self.assertIn("Content of page 3", pages[3])

    def test_headers_only(self):
        doc = (
            "## Page 1\nFirst page text\n"
            "## Page 2\nSecond page text\n"
        )
        pages = parse_markdown_pages(doc)
        self.assertEqual(len(pages), 2)
        self.assertIn(1, pages)
        self.assertIn(2, pages)

if __name__ == "__main__":
    unittest.main()
