"""Disk-backed cache for converted pages, keyed by the model that produced them.

A page of Markdown is not just a function of the PDF page — it is a function of
the PDF page *and the model that read it*. Two models transcribe the same
statement differently, and a corpus assembled from a mixture of both is worth
much less than one assembled from either, because you can no longer say which
model produced any given figure.

So the cache path carries the model:

    .cache/models/<model>/<folder>/<pdf_stem>/page_XXX.md

and each page file opens with a provenance comment recording the model and the
time it was written. The comment is an HTML comment rather than YAML
frontmatter deliberately: if one ever escapes into assembled output it is
invisible in rendered Markdown, whereas stray frontmatter renders as a block of
junk at the top of the document.

**Legacy pages.** Caches written before the model was part of the path live at

    .cache/<folder>/<pdf_stem>/page_XXX.md

with no record of what produced them. That provenance is not recoverable — the
model only ever appeared in the *assembled* document, not the page cache. Those
files are never moved or deleted, and they are never read unless a caller asks
for them by passing ``allow_legacy=True``. Callers that do should report them
as unknown-provenance rather than folding them in with the rest.

Note that ``get_page_cache_path`` does not create directories. Creating a
directory as a side effect of *asking whether a page exists* litters the cache
with empty folders for every page ever considered.
"""

import json
import os
import re
import time
from pathlib import Path
from typing import Optional, Dict, Any, Set

# Recorded at the head of every page written under the model-keyed layout.
_PROVENANCE_RE = re.compile(r"\A<!--\s*goosequill:.*?-->[ \t]*\r?\n?", re.DOTALL)

# Model names are already path-safe, but they arrive from an API request, so a
# stray separator must not be able to walk out of the cache directory.
_UNSAFE_IN_NAME = re.compile(r"[^A-Za-z0-9._-]")
_PAGE_FILE = re.compile(r"page_(\d+)\.md\Z")


class CacheManager:
    """Manages disk-based caching for converted markdown pages and job status."""

    MODELS_DIRNAME = "models"

    def __init__(self, cache_dir: Optional[Path] = None):
        self.cache_dir = Path(cache_dir) if cache_dir else Path(".cache")
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Paths
    # ------------------------------------------------------------------

    @staticmethod
    def _safe_model_name(model: str) -> str:
        """Reduce a model name to something that cannot escape the cache dir."""
        cleaned = _UNSAFE_IN_NAME.sub("_", (model or "").strip())
        if not cleaned or cleaned.strip(".") == "":
            raise ValueError(f"Unusable model name for cache path: {model!r}")
        return cleaned

    @staticmethod
    def _provenance_header(model: str, prompt: Optional[str] = None) -> str:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        head = f"<!-- goosequill: model={model} converted={stamp}"
        if prompt:
            # Which prompt produced this page. It matters because a page the
            # recitation filter refused is converted by a different prompt from
            # its neighbours, and one of those prompts settles for a summary —
            # which reads exactly like a transcription once it is on disk.
            head += f" prompt={prompt}"
        return head + " -->\n"

    def _empty_page_size(self, model: str) -> int:
        """Byte length of the shortest page file holding nothing but its stamp.

        A file no larger than this carries no transcription, which is how a page
        written before empty results were rejected is still recognised as a hole
        without reading twelve thousand files to find out.

        This is a floor rather than an exact width, because a stamp naming its
        prompt is longer. That costs nothing: stamp-only files predate the
        prompt field entirely, and no page written since can be empty — an empty
        conversion is refused before it reaches the disk.
        """
        return len(self._provenance_header(model).encode("utf-8"))

    def get_model_cache_dir(self, model: str) -> Path:
        """Root of the cache for one model: .cache/models/<model>/"""
        return self.cache_dir / self.MODELS_DIRNAME / self._safe_model_name(model)

    def get_page_cache_path(self, pdf_path: Path, page_num: int, model: str) -> Path:
        """Path for one page under the model-keyed layout. Creates nothing."""
        p = Path(pdf_path)
        return self.get_model_cache_dir(model) / p.parent.name / p.stem / f"page_{page_num:03d}.md"

    def get_legacy_page_cache_path(self, pdf_path: Path, page_num: int) -> Path:
        """Path for one page under the pre-model-keyed layout. Creates nothing."""
        p = Path(pdf_path)
        return self.cache_dir / p.parent.name / p.stem / f"page_{page_num:03d}.md"

    # ------------------------------------------------------------------
    # Reading
    # ------------------------------------------------------------------

    def is_page_cached(self, pdf_path: Path, page_num: int, model: str,
                       allow_legacy: bool = False) -> bool:
        """Has this page been converted by this model (or, optionally, at all)?

        A file holding only its provenance stamp does not count. Gemini reports
        a page refused by the recitation filter as a successful but empty
        response, and an empty page recorded as converted is a hole that never
        heals — every later run skips it.
        """
        path = self.get_page_cache_path(pdf_path, page_num, model)
        if path.exists() and path.stat().st_size > self._empty_page_size(model):
            return True
        if not allow_legacy:
            return False
        legacy = self.get_legacy_page_cache_path(pdf_path, page_num)
        return legacy.exists() and legacy.stat().st_size > 0

    def is_page_cached_legacy_only(self, pdf_path: Path, page_num: int, model: str) -> bool:
        """True when the only copy of this page is one of unknown provenance."""
        if self.is_page_cached(pdf_path, page_num, model):
            return False
        legacy = self.get_legacy_page_cache_path(pdf_path, page_num)
        return legacy.exists() and legacy.stat().st_size > 0

    def read_page_cache(self, pdf_path: Path, page_num: int, model: str,
                        allow_legacy: bool = False) -> Optional[str]:
        """Read a cached page, with its provenance comment stripped."""
        path = self.get_page_cache_path(pdf_path, page_num, model)
        if not path.exists():
            if not allow_legacy:
                return None
            path = self.get_legacy_page_cache_path(pdf_path, page_num)
            if not path.exists():
                return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return self.strip_provenance(f.read())
        except Exception:
            return None

    def read_page_provenance(self, pdf_path: Path, page_num: int,
                             model: str) -> Optional[Dict[str, str]]:
        """Which model wrote this page, and when. ``None`` if unrecorded."""
        path = self.get_page_cache_path(pdf_path, page_num, model)
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                head = f.read(512)
        except Exception:
            return None
        match = _PROVENANCE_RE.match(head)
        if not match:
            return None
        fields: Dict[str, str] = {}
        for part in match.group(0).split("goosequill:", 1)[-1].replace("-->", "").split():
            if "=" in part:
                key, _, value = part.partition("=")
                fields[key] = value
        return fields or None

    @staticmethod
    def strip_provenance(content: str) -> str:
        """Remove the leading provenance comment, if one is present."""
        if not content:
            return content
        return _PROVENANCE_RE.sub("", content, count=1)

    # ------------------------------------------------------------------
    # Writing
    # ------------------------------------------------------------------

    def write_page_cache(self, pdf_path: Path, page_num: int, content: str,
                         model: str, prompt: Optional[str] = None) -> Optional[Path]:
        """Write a converted page, stamped with what produced it.

        ``prompt`` names the prompt used, so a page converted by a recitation
        fallback can be told apart afterwards from one converted normally.
        Without it a summary and a transcription are the same thing on disk.

        Returns ``None`` without writing when the content is empty. An empty
        page is not a conversion — it is a page the model declined — and
        caching it would mark the page done, so every later run would skip it
        and the hole would never heal. Leaving it uncached is what lets a
        retry find it.
        """
        if not content or not content.strip():
            return None
        path = self.get_page_cache_path(pdf_path, page_num, model)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(
            path,
            self._provenance_header(model, prompt) + self.strip_provenance(content)
        )
        return path

    # ------------------------------------------------------------------
    # Counting
    # ------------------------------------------------------------------

    def cached_page_numbers(self, pdf_path: Path, model: str) -> Set[int]:
        """Which pages of a document this model has converted, in one read.

        Asking page by page costs a stat per page, which is fine for one
        document and not fine for a corpus: counting a 12,000-page plan that
        way took a second and a half before anything could be drawn, on every
        poll. Every page of a document lives in one directory, so read the
        directory once instead.

        Pages holding only their provenance stamp are excluded, exactly as
        is_page_cached excludes them — an empty page is a hole, not a
        conversion, and counting it as done is what makes a hole permanent.
        """
        directory = self.get_page_cache_path(pdf_path, 1, model).parent
        threshold = self._empty_page_size(model)
        found: Set[int] = set()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    match = _PAGE_FILE.fullmatch(entry.name)
                    if not match:
                        continue
                    try:
                        if entry.stat().st_size > threshold:
                            found.add(int(match.group(1)))
                    except OSError:
                        continue
        except (FileNotFoundError, NotADirectoryError, PermissionError):
            pass
        return found

    def count_cached_pages(self, pdf_path: Path, total_pages: int, model: str,
                           allow_legacy: bool = False) -> int:
        """How many pages of a document this model has already converted."""
        if not allow_legacy:
            return sum(1 for n in self.cached_page_numbers(pdf_path, model)
                       if 1 <= n <= total_pages)
        return sum(
            1 for i in range(1, total_pages + 1)
            if self.is_page_cached(pdf_path, i, model, allow_legacy=allow_legacy)
        )

    def count_legacy_only_pages(self, pdf_path: Path, total_pages: int, model: str) -> int:
        """How many pages exist only as unknown-provenance legacy cache."""
        return sum(
            1 for i in range(1, total_pages + 1)
            if self.is_page_cached_legacy_only(pdf_path, i, model)
        )

    # ------------------------------------------------------------------
    # Job status
    # ------------------------------------------------------------------

    def write_job_status(self, data: Dict[str, Any]):
        """Persist live job status for cross-process synchronization."""
        try:
            data["timestamp"] = time.time()
            atomic_write_text(self.cache_dir / "job_status.json", json.dumps(data))
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


def atomic_write_text(path: Path, text: str) -> None:
    """Write via a temporary file and rename, so no reader sees a partial file.

    A half-written cache page is merely wasteful, but a half-written JSON
    metadata file is destructive: the loader cannot parse it, treats the record
    as empty, and the next save writes that emptiness back permanently.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp{os.getpid()}")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
