import io
import threading
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pypdfium2 as pdfium

# PDF pages are described in points; PDFium renders at a scale factor relative
# to that, so a requested DPI becomes a simple ratio against 72pt-per-inch.
POINTS_PER_INCH = 72.0

# Global lock to ensure thread safety across concurrent FastAPI worker threads
_PDFIUM_LOCK = threading.RLock()

# Fast in-memory cache for page counts: path -> (file_size, mtime, page_count)
_PAGE_COUNT_CACHE: Dict[str, Tuple[int, float, int]] = {}


class PDFRenderer:
    """Encapsulates PDF document rendering and rasterization via PDFium with thread-safe execution."""

    @staticmethod
    def _open(pdf_path: Path) -> pdfium.PdfDocument:
        """Open a PDF, raising a clear error if it is missing."""
        p = Path(pdf_path)
        if not p.exists():
            raise FileNotFoundError(f"PDF file not found: {p}")
        try:
            # Read binary buffer into memory to prevent file lock contention on external/network drives
            data = p.read_bytes()
            return pdfium.PdfDocument(data)
        except Exception:
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
        """Get the total number of pages in a PDF file with caching and thread-safety."""
        p = Path(pdf_path)
        stat = None
        key = None
        try:
            stat = p.stat()
            key = str(p.resolve())
            cached = _PAGE_COUNT_CACHE.get(key)
            if cached and cached[0] == stat.st_size and cached[1] == stat.st_mtime:
                return cached[2]
        except Exception:
            pass

        with _PDFIUM_LOCK:
            doc = PDFRenderer._open(p)
            try:
                count = len(doc)
                if key and stat:
                    _PAGE_COUNT_CACHE[key] = (stat.st_size, stat.st_mtime, count)
                return count
            finally:
                doc.close()

    @staticmethod
    def render_page_from_path(pdf_path: Path, page_num: int, dpi: int = 200) -> bytes:
        """Render a single 1-indexed page from a PDF file path."""
        with _PDFIUM_LOCK:
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
        with _PDFIUM_LOCK:
            doc = PDFRenderer._open(pdf_path)
            try:
                total_pages = len(doc)
                if limit and limit < total_pages:
                    total_pages = limit
                return [PDFRenderer._to_png_bytes(doc[i], dpi) for i in range(total_pages)]
            finally:
                doc.close()
