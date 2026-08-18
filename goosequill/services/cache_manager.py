import json
import time
from pathlib import Path
from typing import Optional, Dict, Any

class CacheManager:
    """Manages disk-based caching for rendered markdown pages and job status."""

    def __init__(self, cache_dir: Optional[Path] = None):
        self.cache_dir = Path(cache_dir) if cache_dir else Path(".cache")
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def get_page_cache_path(self, pdf_path: Path, page_num: int) -> Path:
        """Calculate cache file path for a specific PDF page: .cache/<folder>/<pdf_stem>/page_XXX.md"""
        p = Path(pdf_path)
        folder_hash = p.parent.name
        doc_cache_dir = self.cache_dir / folder_hash / p.stem
        doc_cache_dir.mkdir(parents=True, exist_ok=True)
        return doc_cache_dir / f"page_{page_num:03d}.md"

    def is_page_cached(self, pdf_path: Path, page_num: int) -> bool:
        """Check if a page has already been OCR-converted and cached."""
        return self.get_page_cache_path(pdf_path, page_num).exists()

    def read_page_cache(self, pdf_path: Path, page_num: int) -> Optional[str]:
        """Read cached markdown string for a page if present."""
        path = self.get_page_cache_path(pdf_path, page_num)
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return f.read()
            except Exception:
                return None
        return None

    def write_page_cache(self, pdf_path: Path, page_num: int, content: str) -> Path:
        """Write markdown string to the page cache file."""
        path = self.get_page_cache_path(pdf_path, page_num)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path

    def count_cached_pages(self, pdf_path: Path, total_pages: int) -> int:
        """Count how many pages of a document are already present in cache."""
        cached = 0
        for i in range(1, total_pages + 1):
            if self.is_page_cached(pdf_path, i):
                cached += 1
        return cached

    def write_job_status(self, data: Dict[str, Any]):
        """Persist live job status for cross-process synchronization."""
        try:
            status_path = self.cache_dir / "job_status.json"
            data["timestamp"] = time.time()
            with open(status_path, "w", encoding="utf-8") as f:
                json.dump(data, f)
        except Exception:
            pass

    def read_job_status(self) -> Optional[Dict[str, Any]]:
        """Read the latest persisted job status from .cache/job_status.json."""
        status_path = self.cache_dir / "job_status.json"
        if status_path.exists():
            try:
                with open(status_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return None
        return None
