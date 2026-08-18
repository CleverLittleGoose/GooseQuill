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
        
        Returns:
            Dict containing:
            - content: Full consolidated markdown string
            - total_documents: int
            - total_pages: int
            - total_words: int
            - total_chars: int
            - documents: List of processed document details
        """
        raw_docs: List[Dict[str, Any]] = []

        for p_str in file_paths:
            md_path = cls.resolve_markdown_path(p_str)
            if not md_path:
                continue

            try:
                with open(md_path, "r", encoding="utf-8") as f:
                    raw_content = f.read()

                stem = md_path.stem
                pages_count = cls.count_pages_in_markdown(raw_content)
                folder_name = md_path.parent.parent.name if md_path.parent.name == "Markdown" else md_path.parent.name

                raw_docs.append({
                    "path": str(md_path),
                    "filename": md_path.name,
                    "stem": stem,
                    "title": stem,
                    "folder": folder_name,
                    "pages": pages_count,
                    "raw_content": raw_content
                })
            except Exception:
                continue

        if not raw_docs:
            raise ValueError("No valid or readable Markdown files found from the provided paths.")

        # Apply Sorting
        sorted_docs = cls.sort_documents(raw_docs, sort_mode=sort_mode)

        # Compute aggregate metrics
        total_documents = len(sorted_docs)
        total_pages = sum(d["pages"] for d in sorted_docs)

        # Determine master title if not provided
        if not master_title or not master_title.strip():
            folders = set(d["folder"] for d in sorted_docs if d["folder"])
            if len(folders) == 1 and list(folders)[0] and list(folders)[0] not in ("Accounts", "documents", "PDFs"):
                master_title = f"Consolidated Accounts & Filings — {list(folders)[0]}"
            else:
                master_title = f"Consolidated Markdown Document ({total_documents} Documents)"

        doc_parts: List[str] = []

        # 1. Master Document Header
        doc_parts.append(f"# {master_title}\n")
        doc_parts.append(f"> **Consolidated Archive**: {total_documents} Document(s)  \n> **Total Pages**: {total_pages} pages  \n> **Generated via**: GooseQuill on {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")

        # 2. Table of Contents
        if include_toc:
            doc_parts.append("## 📋 Table of Contents\n")
            doc_parts.append("| # | Document | Year / Period | Pages | Section Link |")
            doc_parts.append("| :-: | :--- | :-: | :-: | :--- |")

            for idx, doc in enumerate(sorted_docs, 1):
                doc_title = doc["title"]
                year = cls.extract_year_from_name(doc_title)
                year_str = str(year) if year != 9999 else "—"
                section_heading = f"{idx}. {doc_title}"
                anchor = cls.generate_slug(section_heading)
                doc_parts.append(
                    f"| {idx} | {doc_title} | {year_str} | {doc['pages']} pgs | [View Section &rarr;](#{anchor}) |"
                )
            doc_parts.append("\n---\n")

        # 3. Document Sections
        for idx, doc in enumerate(sorted_docs, 1):
            doc_title = doc["title"]
            section_heading = f"{idx}. {doc_title}"
            
            # Document Section Header
            doc_parts.append(f"\n# {section_heading}\n")

            if include_source_meta:
                doc_parts.append(f"> 📄 **Source**: `{doc['filename']}`  ")
                doc_parts.append(f"> 📂 **Folder**: `{doc['folder']}` | **Pages**: {doc['pages']} pages  \n")

            # Content
            if strip_original_headers:
                content_to_insert = cls.clean_individual_markdown(doc["raw_content"])
            else:
                content_to_insert = doc["raw_content"]

            doc_parts.append(content_to_insert.strip())
            doc_parts.append("\n\n---\n")

        full_content = "\n".join(doc_parts).strip() + "\n"

        words_count = len(full_content.split())
        chars_count = len(full_content)

        return {
            "title": master_title,
            "content": full_content,
            "total_documents": total_documents,
            "total_pages": total_pages,
            "total_words": words_count,
            "total_chars": chars_count,
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

    @staticmethod
    def save_combined_document(output_path: str | Path, content: str) -> Path:
        """Write consolidated content to disk, creating any missing parent folders."""
        p = Path(output_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        return p
