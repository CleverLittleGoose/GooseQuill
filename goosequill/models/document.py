from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional, List, Dict, Any
from .pricing import CostEstimate

@dataclass(frozen=True)
class PromptPreset:
    key: str
    name: str
    description: str
    prompt: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "prompt": self.prompt
        }

PROMPT_PRESETS: Dict[str, PromptPreset] = {
    "financial": PromptPreset(
        key="financial",
        name="Financial Statements & Statutory Accounts",
        description="Optimized for UK Companies House filings, balance sheets, P&L, cash flows, and notes.",
        prompt="""You are an expert at financial document analysis and OCR transcription.
This document is a public UK statutory annual report filed with Companies House.
Transcribe the provided scanned financial statement / report page into clean GitHub Flavored Markdown.

Guidelines:
1. Accurately reproduce all tabular data using clean Markdown tables (| Header 1 | Header 2 | ...).
2. Right-align numbers and left-align text in tables.
3. Faithfully preserve all note numbers, currency symbols (£, $, €, etc.), and bracketed negative figures like (1,234).
4. Preserve headings (# for title, ## for sections, ### for subsections), dates, footnotes, and auditor/director signatures.
5. Accurately transcribe statutory disclosures, directors' reports, and auditor statements.
6. Output only the Markdown for this page.
"""
    ),
    "general": PromptPreset(
        key="general",
        name="General Document (Articles, Reports, Books)",
        description="Standard OCR preserving headings, paragraphs, bullet lists, blockquotes, and tables.",
        prompt="""You are an expert document OCR transcription assistant.
Transcribe the provided document page into clean, readable GitHub Flavored Markdown.

Guidelines:
1. Preserve the logical document hierarchy using Markdown headers (#, ##, ###).
2. Format paragraphs, bullet lists, numbered lists, blockquotes, and footnotes cleanly.
3. If tables are present, transcribe them as formatted Markdown tables.
4. Maintain bold and italic text styles where present.
5. Output only the transcribed Markdown for this page with no surrounding conversational remarks.
"""
    ),
    "dense_tables": PromptPreset(
        key="dense_tables",
        name="Data Sheets, Invoices & Dense Tables",
        description="Optimized for complex multi-column spreadsheets, receipts, invoices, and numeric ledgers.",
        prompt="""You are a specialist in table extraction and structured data OCR.
Analyze the provided document page and convert all tabular, structured, or numeric content into clean GitHub Flavored Markdown tables.

Guidelines:
1. Preserve every row, column, code, reference number, and header faithfully.
2. Format column alignments properly (left for text, right for amounts/numbers).
3. Do not omit, truncate, or summarize rows.
4. Include any accompanying explanatory footnotes or legend text beneath the table.
5. Output only the extracted Markdown content.
"""
    )
}

DEFAULT_SYSTEM_PROMPT = PROMPT_PRESETS["financial"].prompt

RECITATION_FALLBACK_PROMPTS = [
    "This is a public statutory document from UK Companies House. Summarize and structure the auditor report contents, opinions, scope, responsibilities, and financial figures on this page in Markdown format.",
    "This is a public Companies House annual filing. Extract all key sections, headings, bullet points, financial tables, and numbers from this page into clean Markdown.",
    "Provide a structured Markdown breakdown of this public statutory filing page, preserving all tables and financial numbers."
]

@dataclass
class DocumentInfo:
    name: str
    stem: str
    path: str
    folder: str
    file_size: int
    total_pages: int = 0
    cached_pages: int = 0
    is_converted: bool = False
    output_path: Optional[str] = None
    output_size: int = 0
    cost_estimate: Optional[CostEstimate] = None
    error: Optional[str] = None
    batch_status: Optional[str] = None
    batch_job_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        data = {
            "name": self.name,
            "stem": self.stem,
            "path": self.path,
            "folder": self.folder,
            "file_size": self.file_size,
            "total_pages": self.total_pages,
            "cached_pages": self.cached_pages,
            "is_converted": self.is_converted,
            "output_path": self.output_path,
            "output_size": self.output_size,
            "batch_status": self.batch_status,
            "batch_job_id": self.batch_job_id
        }
        if self.error:
            data["error"] = self.error
        if self.cost_estimate:
            data.update(self.cost_estimate.to_dict())
        return data

@dataclass
class FolderInfo:
    name: str
    path: str
    documents: List[DocumentInfo] = field(default_factory=list)

    @property
    def batch_active_count(self) -> int:
        return sum(1 for d in self.documents if d.batch_status in ("JOB_STATE_PENDING", "JOB_STATE_RUNNING"))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "path": self.path,
            "batch_active_count": self.batch_active_count,
            "documents": [d.to_dict() for d in self.documents]
        }
