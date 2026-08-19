import re
import os
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime

class MarkdownCombinerService:
    """Handles consolidation, sorting, TOC generation, and export of multiple converted Markdown files."""

    @staticmethod
    def resolve_markdown_path(file_path: str | Path) -> Optional[Path]:
        """Given a PDF path or MD path, return the existing Markdown file path, or None."""
        p = Path(file_path)
        if p.suffix.lower() == ".md" and p.exists():
            return p
        if p.suffix.lower() == ".pdf":
            md_path = p.parent / "Markdown" / f"{p.stem}.md"
            if md_path.exists():
                return md_path
        # Check if directly in current directory with .md
        direct_md = p.with_suffix(".md")
        if direct_md.exists():
            return direct_md
        return None

    @staticmethod
    def extract_year_from_name(name: str) -> int:
        """Extract a 4-digit year (1900-2099) from a filename or title for chronological sorting."""
        matches = re.findall(r'(?:^|[^\d])(19\d\d|20\d\d)(?:[^\d]|$)', name)
        if matches:
            return int(matches[-1])  # Use last mentioned year
        return 9999  # Place non-dated files at the end in asc sort

    @classmethod
    def sort_documents(
        cls,
        items: List[Dict[str, Any]],
        sort_mode: str = "custom"
    ) -> List[Dict[str, Any]]:
        """Sort document item dictionaries according to the specified mode."""
        if sort_mode == "chronological_asc":
            return sorted(
                items,
                key=lambda x: (cls.extract_year_from_name(x.get("title", "")), x.get("title", "").lower())
            )
        elif sort_mode == "chronological_desc":
            return sorted(
                items,
                key=lambda x: (-cls.extract_year_from_name(x.get("title", "")), x.get("title", "").lower())
            )
        elif sort_mode == "alpha_asc":
            return sorted(items, key=lambda x: x.get("title", "").lower())
        elif sort_mode == "alpha_desc":
            return sorted(items, key=lambda x: x.get("title", "").lower(), reverse=True)
        return items  # "custom" or default preserves list order

    @staticmethod
    def generate_slug(text: str) -> str:
        """Generate a GitHub Flavored Markdown heading anchor slug."""
        slug = text.lower()
        slug = re.sub(r'[^\w\s-]', '', slug)
        slug = re.sub(r'[\s]+', '-', slug)
        return slug.strip('-')

    @staticmethod
    def count_pages_in_markdown(content: str) -> int:
        """Count unique pages demarcated in markdown content."""
        matches = re.findall(r'(?:<!--\s*Page\s*(\d+)\s*-->|(?:\n|^)##\s+Page\s*(\d+))', content, re.IGNORECASE)
        page_nums = set()
        for m in matches:
            num_str = m[0] or m[1]
            if num_str:
                page_nums.add(int(num_str))
        return len(page_nums) if page_nums else 1

    @staticmethod
    def clean_individual_markdown(content: str) -> str:
        """Remove top-level document title and metadata block from standalone markdown to avoid redundancy."""
        if not content:
            return ""

        cleaned = content.strip()
        pattern = re.compile(
            r'^#\s+[^\n]+\n+(?:>\s+[^\n]+\n+)*(?:---\s*\n+)?',
            re.MULTILINE
        )
        cleaned = pattern.sub('', cleaned, count=1).strip()
        return cleaned

    @classmethod
    def _collect(
        cls,
        file_paths: List[str | Path],
        sort_mode: str = "custom"
    ) -> List[Dict[str, Any]]:
        """
        Work out what is going into the document, without keeping any of it.

        Each file is read once here to count its pages and then let go of. The
        content is read again when its section is written. That is two passes
        over the workspace instead of one, and it is the whole point: the table
        of contents has to know every document's page count before the first
        section can be written, and holding every document in memory to satisfy
        that is what put a ceiling on how large a consolidation could be.
        """
        docs: List[Dict[str, Any]] = []

        for p_str in file_paths:
            md_path = cls.resolve_markdown_path(p_str)
            if not md_path:
                continue

            try:
                with open(md_path, "r", encoding="utf-8") as f:
                    raw_content = f.read()
                pages_count = cls.count_pages_in_markdown(raw_content)
            except Exception:
                continue

            stem = md_path.stem
            folder_name = md_path.parent.parent.name if md_path.parent.name == "Markdown" else md_path.parent.name

            docs.append({
                "path": str(md_path),
                "filename": md_path.name,
                "stem": stem,
                "title": stem,
                "folder": folder_name,
                "pages": pages_count
            })

        if not docs:
            raise ValueError("No valid or readable Markdown files found from the provided paths.")

        return cls.sort_documents(docs, sort_mode=sort_mode)

    @classmethod
    def _resolve_title(cls, master_title: Optional[str], sorted_docs: List[Dict[str, Any]]) -> str:
        if master_title and master_title.strip():
            return master_title

        folders = set(d["folder"] for d in sorted_docs if d["folder"])
        if len(folders) == 1 and list(folders)[0] and list(folders)[0] not in ("Accounts", "documents", "PDFs"):
            return f"Consolidated Accounts & Filings — {list(folders)[0]}"
        return f"Consolidated Markdown Document ({len(sorted_docs)} Documents)"

    @classmethod
    def _iter_parts(
        cls,
        sorted_docs: List[Dict[str, Any]],
        master_title: str,
        include_toc: bool,
        include_source_meta: bool,
        strip_original_headers: bool
    ):
        """
        Yield the document a piece at a time, in the order it is written.

        Only one source document is held at once. Everything before the
        sections is derived from the metadata gathered by `_collect`.
        """
        total_documents = len(sorted_docs)
        total_pages = sum(d["pages"] for d in sorted_docs)

        # 1. Master Document Header
        yield f"# {master_title}\n"
        yield (
            f"> **Consolidated Archive**: {total_documents} Document(s)  \n"
            f"> **Total Pages**: {total_pages} pages  \n"
            f"> **Generated via**: GooseQuill on {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"
        )

        # 2. Table of Contents
        if include_toc:
            yield "## 📋 Table of Contents\n"
            yield "| # | Document | Year / Period | Pages | Section Link |"
            yield "| :-: | :--- | :-: | :-: | :--- |"

            for idx, doc in enumerate(sorted_docs, 1):
                doc_title = doc["title"]
                year = cls.extract_year_from_name(doc_title)
                year_str = str(year) if year != 9999 else "—"
                section_heading = f"{idx}. {doc_title}"
                anchor = cls.generate_slug(section_heading)
                yield (
                    f"| {idx} | {doc_title} | {year_str} | {doc['pages']} pgs | [View Section &rarr;](#{anchor}) |"
                )
            yield "\n---\n"

        # 3. Document Sections
        for idx, doc in enumerate(sorted_docs, 1):
            doc_title = doc["title"]
            section_heading = f"{idx}. {doc_title}"

            yield f"\n# {section_heading}\n"

            if include_source_meta:
                yield f"> 📄 **Source**: `{doc['filename']}`  "
                yield f"> 📂 **Folder**: `{doc['folder']}` | **Pages**: {doc['pages']} pages  \n"

            try:
                with open(doc["path"], "r", encoding="utf-8") as f:
                    raw_content = f.read()
            except Exception:
                raw_content = ""

            if strip_original_headers:
                content_to_insert = cls.clean_individual_markdown(raw_content)
            else:
                content_to_insert = raw_content

            yield content_to_insert.strip()
            yield "\n\n---\n"

    @staticmethod
    def _stream_parts(handle, parts) -> Tuple[int, int]:
        """
        Write the parts exactly as `"\n".join(parts).strip() + "\n"` would, and
        report (chars, words), without ever holding the joined document.

        Only the final part can need trimming, so one part of lookahead is all
        it takes to reproduce the trailing `.strip()`.
        """
        total_chars = 0
        total_words = 0
        first = True

        def emit(text: str, last: bool = False) -> None:
            nonlocal total_chars, first
            payload = text if first else "\n" + text
            if first:
                payload = payload.lstrip()
                first = False
            if last:
                payload = payload.rstrip()
            handle.write(payload)
            total_chars += len(payload)

        pending = None
        for part in parts:
            if pending is not None:
                emit(pending)
                total_words += len(pending.split())
            pending = part

        if pending is not None:
            emit(pending, last=True)
            total_words += len(pending.split())

        handle.write("\n")
        total_chars += 1

        return total_chars, total_words

    @staticmethod
    def _summary(master_title: str, sorted_docs: List[Dict[str, Any]], chars: int, words: int) -> Dict[str, Any]:
        return {
            "title": master_title,
            "total_documents": len(sorted_docs),
            "total_pages": sum(d["pages"] for d in sorted_docs),
            "total_words": words,
            "total_chars": chars,
            "documents": [
                {
                    "title": d["title"],
                    "path": d["path"],
                    "folder": d["folder"],
                    "pages": d["pages"]
                }
                for d in sorted_docs
            ]
        }

    @classmethod
    def combine(
        cls,
        file_paths: List[str | Path],
        master_title: Optional[str] = None,
        include_toc: bool = True,
        include_source_meta: bool = True,
        strip_original_headers: bool = True,
        sort_mode: str = "custom"
    ) -> Dict[str, Any]:
        """
        Consolidate multiple markdown files into a single unified markdown document.

        Builds the whole thing in memory, so it is for previews and for outputs
        small enough to be handed straight back. Use `combine_to_file` for a
        consolidation that is going to disk.

        Returns:
            Dict containing:
            - content: Full consolidated markdown string
            - total_documents: int
            - total_pages: int
            - total_words: int
            - total_chars: int
            - documents: List of processed document details
        """
        sorted_docs = cls._collect(file_paths, sort_mode=sort_mode)
        master_title = cls._resolve_title(master_title, sorted_docs)

        parts = list(cls._iter_parts(
            sorted_docs, master_title, include_toc, include_source_meta, strip_original_headers
        ))
        full_content = "\n".join(parts).strip() + "\n"

        summary = cls._summary(master_title, sorted_docs, len(full_content), len(full_content.split()))
        summary["content"] = full_content
        return summary

    @classmethod
    def combine_to_file(
        cls,
        output_path: str | Path,
        file_paths: List[str | Path],
        master_title: Optional[str] = None,
        include_toc: bool = True,
        include_source_meta: bool = True,
        strip_original_headers: bool = True,
        sort_mode: str = "custom"
    ) -> Dict[str, Any]:
        """
        Assemble the consolidation straight onto disk.

        Byte-for-byte what `combine` produces, but the peak cost is one source
        document rather than the finished article three times over — once in the
        documents read up front, once in the list of parts, and once in the
        string they are joined into. A whole-workspace consolidation no longer
        has a size at which it stops working.

        Returns the same summary as `combine`, with `saved_path` in place of
        `content`.
        """
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        sorted_docs = cls._collect(file_paths, sort_mode=sort_mode)
        master_title = cls._resolve_title(master_title, sorted_docs)

        parts = cls._iter_parts(
            sorted_docs, master_title, include_toc, include_source_meta, strip_original_headers
        )

        # A partial file left behind by a failure reads as a finished
        # consolidation, so the write lands on a temporary name and is moved
        # into place only once it is whole.
        staging = out.with_name(out.name + ".partial")
        try:
            with open(staging, "w", encoding="utf-8") as handle:
                chars, words = cls._stream_parts(handle, parts)
            os.replace(staging, out)
        except BaseException:
            staging.unlink(missing_ok=True)
            raise

        summary = cls._summary(master_title, sorted_docs, chars, words)
        summary["saved_path"] = str(out)
        return summary

    @staticmethod
    def save_combined_document(output_path: str | Path, content: str) -> Path:
        """Write consolidated content to disk, creating any missing parent folders."""
        p = Path(output_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        return p
