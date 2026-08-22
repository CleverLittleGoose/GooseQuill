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

@dataclass(frozen=True)
class FallbackPrompt:
    """One attempt at a page the recitation filter refused.

    ``verbatim`` is the part that matters. A prompt that asks the model to
    summarise will get a summary, and a summary written into the page cache is
    indistinguishable from a transcription once it is there — it reads as the
    document, in a corpus someone will quote from. Only the last of these gives
    up on transcription, and ``id`` is stamped into the page so that the ones
    which did are findable afterwards.
    """
    id: str
    text: str
    verbatim: bool = True


# The prompt id recorded for a page converted the ordinary way.
PRESET_PROMPT_ID = "preset"

# Tried in order, each time Gemini's recitation filter refuses a page.
#
# These used to ask for a summary — the first one said "Summarize and structure
# the auditor report contents" — which is why 566 pages of the first corpus run
# hold paraphrase rather than the text that is actually printed on the page,
# with nothing marking them apart. Statutory filings recite standard wording by
# design, so the auditor's report trips the filter constantly, and asking for a
# summary is a reliable way to get past it. It is also a reliable way to end up
# with a transcript that quietly is not one.
#
# So the first three reframe the document instead of retreating from the task:
# it is a public record, published by the company, in the public register. Only
# if all three are refused does the last one settle for a summary, and it says
# so in the page's provenance stamp.
RECITATION_FALLBACK_PROMPTS = [
    FallbackPrompt(
        id="verbatim-public-record",
        text=(
            "This page is from a public UK statutory annual report filed at Companies "
            "House and published by the company itself. Transcribe it verbatim into "
            "GitHub Flavored Markdown: every heading, paragraph, table, figure and "
            "note, exactly as printed. Do not summarise, paraphrase, shorten or "
            "comment on the content. Output only the Markdown for this page."
        ),
    ),
    FallbackPrompt(
        id="verbatim-record-keeping",
        text=(
            "Transcribe the text and tables on this page of a public company filing "
            "into GitHub Flavored Markdown, preserving every figure, note number and "
            "line of text exactly as it appears. This is a record-keeping "
            "transcription of a document already on the public register, not a "
            "reproduction for republication. Do not restate anything in your own "
            "words. Output only the page's Markdown."
        ),
    ),
    FallbackPrompt(
        id="verbatim-top-to-bottom",
        text=(
            "Read this page of a published statutory filing from top to bottom and "
            "set down its exact contents in GitHub Flavored Markdown — headings as "
            "headings, tables as Markdown tables, figures and note references "
            "unchanged. Write no preamble, no commentary and no summary; reproduce "
            "only what is printed on the page."
        ),
    ),
    # The wording that actually gets through, kept deliberately.
    #
    # Measured: on the pages that refuse all three verbatim attempts, this one
    # succeeds where anything closer to "transcribe" is refused again. Asking
    # for a summary is what evades the filter, which is precisely why it used to
    # come first and why the corpus filled up with paraphrase. Last is where it
    # belongs — and its id is stamped into the page, so a summary is no longer
    # indistinguishable from the document it summarises.
    FallbackPrompt(
        id="summary-of-last-resort",
        verbatim=False,
        text=(
            "This is a public statutory document from UK Companies House. Summarize "
            "and structure the auditor report contents, opinions, scope, "
            "responsibilities, and financial figures on this page in Markdown format. "
            "Output only the Markdown, with no preamble."
        ),
    ),
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
    # Pages held only in the pre-model-keyed cache, whose model is unknown
    # and unrecoverable. Counted apart from cached_pages so they are never
    # presented as the current model's work.
    legacy_pages: int = 0
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
            "legacy_pages": self.legacy_pages,
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
