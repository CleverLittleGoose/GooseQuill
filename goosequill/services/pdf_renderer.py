import io
from pathlib import Path
from typing import List, Optional

import pypdfium2 as pdfium

# PDF pages are described in points; PDFium renders at a scale factor relative
# to that, so a requested DPI becomes a simple ratio against 72pt-per-inch.
POINTS_PER_INCH = 72.0


class PDFRenderer:
    """Encapsulates PDF document rendering and rasterization via PDFium."""

    @staticmethod
    def _open(pdf_path: Path) -> pdfium.PdfDocument:
        """Open a PDF, raising a clear error if it is missing."""
        p = Path(pdf_path)
        if not p.exists():
            raise FileNotFoundError(f"PDF file not found: {p}")
        return pdfium.PdfDocument(str(p))

    @staticmethod
    def _to_png_bytes(page: pdfium.PdfPage, dpi: int) -> bytes:
        """Rasterize a single page to PNG bytes at the requested DPI."""
        bitmap = page.render(scale=dpi / POINTS_PER_INCH)
        buffer = io.BytesIO()
        bitmap.to_pil().save(buffer, format="PNG")
        return buffer.getvalue()

    @staticmethod
    def get_page_count(pdf_path: Path) -> int:
        """Get the total number of pages in a PDF file."""
        doc = PDFRenderer._open(pdf_path)
        try:
            return len(doc)
        finally:
            doc.close()

    @staticmethod
    def render_page_image(doc: pdfium.PdfDocument, page_idx: int, dpi: int = 200) -> bytes:
        """Render a single page from an already-open document to PNG bytes."""
        return PDFRenderer._to_png_bytes(doc[page_idx], dpi)

    @staticmethod
    def render_page_from_path(pdf_path: Path, page_num: int, dpi: int = 200) -> bytes:
        """Render a single 1-indexed page from a PDF file path."""
        doc = PDFRenderer._open(pdf_path)
        try:
            page_idx = max(0, page_num - 1)
            if page_idx >= len(doc):
                page_idx = len(doc) - 1
            return PDFRenderer._to_png_bytes(doc[page_idx], dpi)
        finally:
            doc.close()

    @staticmethod
    def render_all_pages(pdf_path: Path, dpi: int = 200, limit: Optional[int] = None) -> List[bytes]:
        """Pre-render all pages of a PDF into a list of PNG byte buffers."""
        doc = PDFRenderer._open(pdf_path)
        try:
            total_pages = len(doc)
            if limit and limit < total_pages:
                total_pages = limit
            return [PDFRenderer._to_png_bytes(doc[i], dpi) for i in range(total_pages)]
        finally:
            doc.close()
