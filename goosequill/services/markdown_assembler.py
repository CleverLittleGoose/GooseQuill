import re
from pathlib import Path
from typing import List, Optional, Dict

class MarkdownAssembler:
    """Handles assembly, page partitioning, and persistence of converted Markdown documents."""

    @staticmethod
    def assemble_document(
        stem: str,
        source_name: str,
        model_name: str,
        total_pages: int,
        page_results: List[Optional[str]]
    ) -> str:
        """Combine individual page markdowns into a unified document with standard metadata header."""
        full_content_parts = [
            f"# {stem}\n",
            f"> Source Document: `{source_name}`  ",
            f"> Total Pages: {total_pages}  ",
            f"> Converted with Gemini Model: `{model_name}`  \n",
            "---\n"
        ]

        for idx, page_md in enumerate(page_results):
            page_num = idx + 1
            content = page_md or f"> **[Page {page_num} conversion pending/failed]**"
            full_content_parts.append(f"\n<!-- Page {page_num} -->\n## Page {page_num}\n\n{content}\n\n---\n")

        return "\n".join(full_content_parts)

    @staticmethod
    def split_into_pages(markdown_content: str) -> Dict[int, str]:
        """Split a merged markdown document into page-indexed string chunks using page comment or header delimiters."""
        pages: Dict[int, str] = {}
        if not markdown_content:
            return pages

        # Pattern matches: <!-- Page X --> or ## Page X
        pattern = re.compile(r'(?:<!--\s*Page\s+(\d+)\s*-->|(?:\n|^)##\s+Page\s+(\d+))', re.IGNORECASE)
        splits = list(pattern.finditer(markdown_content))

        if not splits:
            pages[1] = markdown_content.strip()
            return pages

        for i, match in enumerate(splits):
            page_num = int(match.group(1) or match.group(2))
            start_pos = match.end()
            end_pos = splits[i + 1].start() if (i + 1 < len(splits)) else len(markdown_content)
            page_text = markdown_content[start_pos:end_pos].strip()
            # Clean trailing horizontal dividers
            if page_text.endswith("---"):
                page_text = page_text[:-3].strip()
            pages[page_num] = page_text

        return pages

    @staticmethod
    def save_document(output_path: Path, content: str) -> Path:
        """Write content to disk, creating parent directories if necessary."""
        p = Path(output_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        return p

    @staticmethod
    def read_document(file_path: Path) -> str:
        """Read text content from file."""
        p = Path(file_path)
        if not p.exists():
            raise FileNotFoundError(f"Markdown file not found: {p}")
        with open(p, "r", encoding="utf-8") as f:
            return f.read()
