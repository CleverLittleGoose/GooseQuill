import re
import threading
from bisect import bisect_right
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Markers the assembler writes at the head of every page, used to attribute a
# match to the page it was transcribed from.
_PAGE_MARKER_RE = re.compile(r"<!--\s*Page\s+(\d+)\s*-->", re.IGNORECASE)

# How much text to show either side of a hit.
_SNIPPET_RADIUS = 70

# Where consolidated output lives. A consolidation is a copy of text that is
# already in the workspace, so counting it as another document means every hit
# in it is a hit you have already been shown somewhere else.
CONSOLIDATED_DIR_NAME = "Consolidated"


def is_consolidated(path: Path) -> bool:
    """Whether a Markdown file is combiner output rather than a transcript."""
    return CONSOLIDATED_DIR_NAME in Path(path).parts


class SearchService:
    """Full-text search across every converted Markdown document in a workspace.

    The corpus is a few tens of megabytes of local files, so this reads them
    directly rather than maintaining a separate index that could fall out of step
    with what is on disk. Contents are cached against size and mtime, so repeat
    searches over an unchanged workspace do no file I/O at all, and a document
    that gets reconverted is picked up without anything having to invalidate it.
    """

    def __init__(self) -> None:
        # path -> (size, mtime_ns, text, page_offsets, page_numbers)
        self._cache: Dict[str, Tuple[int, int, str, List[int], List[int]]] = {}
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ files

    @staticmethod
    def iter_markdown_files(root_dir: Path, include_consolidated: bool = False) -> List[Path]:
        """Every converted Markdown document beneath a workspace root.

        Consolidated output is left out by default: its contents are a copy of
        documents already being searched, so including it reports the same
        passage two or three times over and pushes the originals down the
        ranking beneath the file that quotes them all.
        """
        root = Path(root_dir)
        if not root.exists():
            return []
        return sorted(
            p
            for p in root.rglob("*.md")
            if p.is_file() and (include_consolidated or not is_consolidated(p))
        )

    def _load(self, path: Path) -> Optional[Tuple[str, List[int], List[int]]]:
        """Read a document and its page boundaries, honouring the cache."""
        try:
            stat = path.stat()
        except OSError:
            return None

        key = str(path)
        with self._lock:
            cached = self._cache.get(key)
            if cached and cached[0] == stat.st_size and cached[1] == stat.st_mtime_ns:
                return cached[2], cached[3], cached[4]

        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

        offsets: List[int] = []
        numbers: List[int] = []
        for match in _PAGE_MARKER_RE.finditer(text):
            offsets.append(match.start())
            numbers.append(int(match.group(1)))

        with self._lock:
            self._cache[key] = (stat.st_size, stat.st_mtime_ns, text, offsets, numbers)
        return text, offsets, numbers

    @staticmethod
    def _page_for_offset(offset: int, page_offsets: List[int], page_numbers: List[int]) -> Optional[int]:
        if not page_offsets:
            return None
        idx = bisect_right(page_offsets, offset) - 1
        if idx < 0:
            return None
        return page_numbers[idx]

    @staticmethod
    def _snippet(text: str, start: int, end: int) -> Dict[str, Any]:
        """A window of text around a hit, with the hit located inside it.

        Offsets are returned rather than pre-built markup so the caller can
        highlight without any HTML being assembled here.
        """
        left = max(0, start - _SNIPPET_RADIUS)
        right = min(len(text), end + _SNIPPET_RADIUS)

        # Avoid cutting mid-word where there is a nearby space to cut at.
        if left > 0:
            space = text.find(" ", left, start)
            if space != -1:
                left = space + 1
        if right < len(text):
            space = text.rfind(" ", end, right)
            if space != -1:
                right = space

        window = text[left:right].replace("\n", " ").strip()
        leading_trim = len(text[left:right]) - len(text[left:right].lstrip())

        return {
            "text": window,
            "match_start": start - left - leading_trim,
            "match_end": end - left - leading_trim,
            "prefix_truncated": left > 0,
            "suffix_truncated": right < len(text),
        }

    # ----------------------------------------------------------------- search

    def search(
        self,
        root_dir: Path,
        query: str,
        match_case: bool = False,
        whole_word: bool = False,
        max_documents: int = 100,
        max_matches_per_document: int = 5,
        offset: int = 0,
        include_consolidated: bool = False,
    ) -> Dict[str, Any]:
        """Find a query across the workspace, grouped by document.

        `offset` walks further down the same ranking rather than re-running a
        different search. Every matching document is found and ranked either
        way — the limit only decides how many are returned — and the contents
        cache means paging through results does no file I/O at all after the
        first page.
        """
        query = (query or "").strip()
        if not query:
            return {
                "query": "",
                "results": [],
                "total_matches": 0,
                "documents_matched": 0,
                "documents_searched": 0,
                "truncated": False,
                "offset": 0,
                "has_more": False,
            }

        pattern_text = re.escape(query)
        if whole_word:
            pattern_text = rf"\b{pattern_text}\b"
        pattern = re.compile(pattern_text, 0 if match_case else re.IGNORECASE)

        files = self.iter_markdown_files(root_dir, include_consolidated=include_consolidated)
        results: List[Dict[str, Any]] = []
        total_matches = 0

        for path in files:
            loaded = self._load(path)
            if loaded is None:
                continue
            text, page_offsets, page_numbers = loaded

            matches: List[Dict[str, Any]] = []
            count = 0
            for match in pattern.finditer(text):
                count += 1
                if len(matches) < max_matches_per_document:
                    snippet = self._snippet(text, match.start(), match.end())
                    snippet["page"] = self._page_for_offset(match.start(), page_offsets, page_numbers)
                    matches.append(snippet)

            if count == 0:
                continue

            total_matches += count
            results.append(
                {
                    "name": path.name,
                    "stem": path.stem,
                    "markdown_path": str(path),
                    # The scan lives in <folder>/Markdown/<stem>.md; the PDF the
                    # viewer opens sits one level up.
                    "pdf_path": str(path.parent.parent / f"{path.stem}.pdf"),
                    "folder": path.parent.parent.name,
                    "match_count": count,
                    "matches": matches,
                }
            )

        # Most hits first: the document that talks about it most is the one
        # someone searching for it usually wants.
        results.sort(key=lambda r: (-r["match_count"], r["folder"].lower(), r["name"].lower()))

        start = max(0, offset)
        page = results[start : start + max_documents]

        return {
            "query": query,
            "results": page,
            "total_matches": total_matches,
            "documents_matched": len(results),
            "documents_searched": len(files),
            # Kept for callers that only ask "is there more than I was given".
            "truncated": len(results) > max_documents,
            "offset": start,
            "has_more": start + len(page) < len(results),
        }
