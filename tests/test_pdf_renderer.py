import sys
from pathlib import Path
import unittest
import pypdfium2 as pdfium

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.pdf_renderer import PDFRenderer

class TestPDFRenderer(unittest.TestCase):
    def setUp(self):
        # Build a small two-page PDF to render against.
        self.temp_pdf = PROJECT_ROOT / ".cache" / "test_temp_doc.pdf"
        self.temp_pdf.parent.mkdir(parents=True, exist_ok=True)
        
        doc = pdfium.PdfDocument.new()
        for _ in range(2):
            doc.new_page(200, 200)
        doc.save(str(self.temp_pdf))
        doc.close()

    def tearDown(self):
        if self.temp_pdf.exists():
            self.temp_pdf.unlink()

    def test_get_page_count(self):
        count = PDFRenderer.get_page_count(self.temp_pdf)
        self.assertEqual(count, 2)

    def test_render_page_from_path(self):
        img_bytes = PDFRenderer.render_page_from_path(self.temp_pdf, page_num=1, dpi=72)
        self.assertTrue(len(img_bytes) > 0)
        self.assertTrue(img_bytes.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_render_all_pages(self):
        images = PDFRenderer.render_all_pages(self.temp_pdf, dpi=72)
        self.assertEqual(len(images), 2)
        for img in images:
            self.assertTrue(len(img) > 0)

if __name__ == "__main__":
    unittest.main()
