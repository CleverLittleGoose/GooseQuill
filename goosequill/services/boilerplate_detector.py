"""GooseQuill Deflate — Boilerplate detection and removal for company accounts.

Identifies text that is provably repeated across multiple filings and produces
lightweight copies with that text removed.  Every word in the output came from
the original file — this tool only deletes, never generates or paraphrases.

The optional LLM verification step is a classifier (yes / no) that never
contributes content to the output.
"""

import re
import os
import hashlib
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Set, Tuple
from datetime import datetime

from .search_service import (
    LIGHTWEIGHT_DIR_NAME,
    DEFLATE_REPORT_NAME,
    is_consolidated,
    is_lightweight,
)

logger = logging.getLogger(__name__)

# A section shorter than this is never fingerprinted: too little text to tell
# repetition from coincidence, and too little gain to be worth the risk.
MIN_SECTION_WORDS = 40

# The fewest filings a passage must appear in before repetition means anything.
# Below two there is no repetition to observe, and a corpus of one would see
# every section as "appearing in all the filings we looked at" and strip the
# document down to its tables.
MIN_THRESHOLD = 2

# ── Protected keywords ─────────────────────────────────────────────────────
# Sections whose headings or content match these are NEVER stripped.
# These are where critical financial, commercial, and governance signals hide.

PROTECTED_HEADING_KEYWORDS = (
    "going concern",
    "business performance",
    "strategic management",
    "strategic report",
    "principal activity",
    "business environment",
    "key performance indicator",
    "kpi",
    "operating review",
    "financial review",
    "chairman's statement",
    "chief executive",
    "directors",
    "board of directors",
    "directors' remuneration",
    "remuneration of directors",
    "staff numbers and costs",
    "related party",
    "ultimate parent",
    "parent company",
    # The controlling-party note names the immediate parent and the ultimate
    # controlling party — the ownership chain itself, and in a group built from
    # dozens of near-identical shells it is the only thing distinguishing one
    # filing from the next. Normalisation masks company names before hashing,
    # so without this the note reads as the same sentence in every entity and
    # is removed from all of them as boilerplate.
    "controlling party",
    "immediate parent",
    "group undertaking",
    "subsidiary undertaking",
    "joint venture undertaking",
    "subsidiaries",
    "group structure",
    "intercompany",
    "intra-group",
    "investments",
    "debtors",
    "creditors",
    "borrowings",
    "subsequent event",
    "post balance sheet",
    "contingent liab",
    "provisions",
    "key audit matter",
    "emphasis of matter",
    "material uncertainty",
    "basis for opinion",
    "opinion on financial statements",
    "dividend",
)

# Text-level keywords that protect a section even if its heading didn't match
PROTECTED_BODY_KEYWORDS = (
    "going concern",
    "material uncertainty",
    "qualified opinion",
    "emphasis of matter",
    "modified opinion",
    "except for",                # qualified audit opinion wording
    "contingent liab",
    "subsequent event",
    "post balance sheet",
    "exceptional item",
    "prior period adjustment",
    "restatement",
    "key audit matter",
)

# Headings that indicate a primary financial statement — NEVER strip
_FINANCIAL_STATEMENT_KEYWORDS = (
    "statement of comprehensive income",
    "statement of financial position",
    "statement of changes in equity",
    "cash flow statement",
    "statement of cash flows",
    "profit and loss",
    "balance sheet",
    "income statement",
)

# ── Page-scaffolding patterns ──────────────────────────────────────────────
# Structural artefacts with zero analytical content.  Always safe to strip.

# Companies House receipt stamp on cover pages.
_COMPANIES_HOUSE_STAMP_RE = re.compile(
    r'(?:^|\n)'
    r'(?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\s*\n'
    r'[A-Z0-9]+\s*\n'
    r'\*[A-Za-z0-9*]+\*\s*\n'
    r'\d{2}/\d{2}/\d{4}\s*(?:\n#?\d+\s*)?'
    r'(?:\n)?COMPANIES\s+HOUSE\s*'
    r'(?:\n#?\d+)?',
    re.MULTILINE | re.IGNORECASE,
)

# Page markers: <!-- Page N --> optionally followed by ## Page N
_PAGE_MARKER_RE = re.compile(
    r'<!--\s*Page\s+\d+\s*-->\s*\n?'
    r'(?:##\s+Page\s+\d+\s*\n?)?',
    re.IGNORECASE,
)

# Standalone ## Page N (without HTML comment)
_PAGE_HEADING_RE = re.compile(r'^##\s+Page\s+\d+\s*$', re.MULTILINE)

# Page-number footer lines.
# Matches: "Registered number 06127441 / 52 weeks ended 28 December 2024 | 7"
# and:     "Registered number 06127441 / 52 weeks ended 28 December 2024\n7"
_PAGE_FOOTER_RE = re.compile(
    r'^Registered\s+number\s+\d+\s*/\s*\d+\s+weeks?\s+ended\s+[^\n]+?\s*\|\s*\d+\s*$',
    re.MULTILINE | re.IGNORECASE,
)
_PAGE_FOOTER_ALT_RE = re.compile(
    r'^Registered\s+number\s+\d+\s*/\s*\d+\s+weeks?\s+ended\s+[^\n]+$\n\s*\d+\s*$',
    re.MULTILINE | re.IGNORECASE,
)

# Repeated page headers: Company Name / Annual Report / period on every page.
_REPEATED_HEADER_RE = re.compile(
    r'(?:^|\n)'
    r'([A-Z][A-Za-z\s&\',\.\-()]+(?:Limited|Ltd|PLC|SARL|plc|limited))\s*(?:\\?\s*\n|\n)'
    r'(?:Annual\s+[Rr]eport\s+and\s+financial\s+statements|'
    r'Annual\s+report\s+and\s+accounts)\s*(?:\\?\s*\n|\n)'
    r'(?:Registered\s+number\s+\d+\s*(?:\\?\s*\n|\n))?'
    r'\d+\s+weeks?\s+ended\s+\d{1,2}\s+\w+\s+\d{4}\s*',
    re.MULTILINE,
)

# A board change recorded against a person: "(appointed 1 Feb 2024)",
# "resigned 3 March 2019", or a bulleted/dashed name carrying either word.
# Deliberately not a bare word match — see ``_is_protected``.
_BOARD_CHANGE_RE = re.compile(
    r'(?:appointed|resigned|retired)\s*(?:on|with\s+effect\s+from|from)?\s*'
    r'\d{1,2}\s+\w+\s+\d{4}'
    r'|'
    r'\(\s*(?:appointed|resigned|retired)\b[^)]*\)'
    r'|'
    r'^\s*[-*\u2022|]\s*[^\n]*\b(?:appointed|resigned|retired)\b',
    re.IGNORECASE | re.MULTILINE,
)

# Runs of 2+ horizontal rules with only whitespace between them.
_EXCESS_RULES_RE = re.compile(r'(\n---\s*\n)(?:\s*---\s*\n)+')

# ── Normalisation patterns (for fingerprint comparison) ────────────────────

_DATE_RE = re.compile(
    r'\d{1,2}\s+(?:January|February|March|April|May|June|July|August|'
    r'September|October|November|December)\s+\d{4}',
    re.IGNORECASE,
)
_YEAR_RE = re.compile(r'\b(19|20)\d{2}\b')
_AMOUNT_RE = re.compile(r'£[\d,]+(?:\.\d+)?(?:\s*(?:000|million|m|bn))?|£nil', re.IGNORECASE)
_REGNUM_RE = re.compile(r'(?:Registered|Registration|Company)\s+number\s*:?\s*\d+', re.IGNORECASE)
_PERCENT_RE = re.compile(r'\d+\.?\d*\s*%')
# Generic numbers that remain after the specific masks.
_NUMBER_RE = re.compile(r'\b\d[\d,]*(?:\.\d+)?\b')


# ═══════════════════════════════════════════════════════════════════════════
#  Public service
# ═══════════════════════════════════════════════════════════════════════════

class BoilerplateDetector:
    """Detect and remove boilerplate from company accounts Markdown files.

    Purely subtractive: every word in the lightweight output came from the
    original transcript.  The optional LLM verification step is a classifier
    that never contributes content.

    Follows the same stateless-utility pattern as ``MarkdownCombinerService``:
    all methods are ``@classmethod`` or ``@staticmethod``.
    """

    # ── Section splitting ──────────────────────────────────────────────────

    @staticmethod
    def _split_into_sections(content: str) -> List[Dict[str, Any]]:
        """Split markdown into sections based on heading boundaries.

        A "section" is a heading line plus all content up to (but not including)
        the next heading of equal or higher level.  Bold-text pseudo-headings
        (``**Statement of ...**``) that start a line are treated as level-2
        headings, since the OCR conversion does not always assign them a ``#``.

        Returns list of dicts:
            heading   – heading text (``None`` for the preamble before any heading)
            level     – 1–6, or 0 for preamble
            body      – full text of the section *including* the heading line
            has_table – whether the body contains a markdown table
        """
        heading_re = re.compile(
            r'^(#{1,6})\s+(.+?)$'          # proper headings
            r'|'
            r'^(\*{2}[^*\n]{10,}\*{2})\s*$',  # bold pseudo-headings (≥ 10 chars)
            re.MULTILINE,
        )

        matches = list(heading_re.finditer(content))
        if not matches:
            return [{
                "heading": None,
                "level": 0,
                "body": content,
                "has_table": bool(re.search(r'^\|.*\|', content, re.MULTILINE)),
            }]

        sections: List[Dict[str, Any]] = []

        # Preamble before first heading.
        if matches[0].start() > 0:
            preamble = content[:matches[0].start()]
            if preamble.strip():
                sections.append({
                    "heading": None,
                    "level": 0,
                    "body": preamble,
                    "has_table": bool(re.search(r'^\|.*\|', preamble, re.MULTILINE)),
                })

        for i, m in enumerate(matches):
            if m.group(1):
                level = len(m.group(1))
                heading = m.group(2).strip().strip('*').strip()
            else:
                level = 2
                heading = m.group(3).strip('*').strip()

            start = m.start()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
            body = content[start:end]

            # A "Page 7" heading is scaffolding, not a section of the report —
            # but the text underneath it is the report. Dropping the match
            # outright dropped that text with it, so the page's content never
            # reached the fingerprint library and, on the deflate pass, never
            # reached the output file. Discard the heading line and hand the
            # rest to whichever real section it belongs to.
            if re.match(r'^Page\s+\d+$', heading, re.IGNORECASE):
                remainder = body[m.end() - start:]
                if not remainder.strip():
                    continue
                if sections:
                    previous = sections[-1]
                    previous["body"] += remainder
                    previous["has_table"] = previous["has_table"] or bool(
                        re.search(r'^\|.*\|', remainder, re.MULTILINE)
                    )
                else:
                    sections.append({
                        "heading": None,
                        "level": 0,
                        "body": remainder,
                        "has_table": bool(re.search(r'^\|.*\|', remainder, re.MULTILINE)),
                    })
                continue

            sections.append({
                "heading": heading,
                "level": level,
                "body": body,
                "has_table": bool(re.search(r'^\|.*\|', body, re.MULTILINE)),
            })

        return sections

    # ── Normalisation ──────────────────────────────────────────────────────

    @staticmethod
    def entity_for(path: Path) -> str:
        """Which company a transcript belongs to.

        Transcripts live at ``<entity>/Markdown/<filing>.md``; anything else
        falls back to the containing directory.
        """
        p = Path(path)
        return p.parent.parent.name if p.parent.name == "Markdown" else p.parent.name

    @staticmethod
    def peer_group_for(entity: str) -> str:
        """Which format family an entity belongs to.

        Filings from the same family are drafted by the same advisers off the
        same template, so their statutory wording matches closely enough to
        recognise. Filings from different families say the same thing in
        different words and never match at all — which is why a group's own
        template boilerplate needs a lower bar than the corpus-wide one.

        The default rule is the leading token of the entity name, which sorts
        a workspace into the stacks it actually has: a group's subsidiaries are
        usually filed under a shared stem (``Example Holdings``, ``Example
        Trading``, and so on). Callers with a better idea can pass an explicit
        mapping.
        """
        token = (entity or "").strip().split()
        return token[0].upper() if token else ""

    @classmethod
    def _group_index(
        cls,
        file_paths: List[Path],
        peer_groups: Optional[Dict[str, str]] = None,
    ) -> Dict[str, str]:
        """entity name -> peer group, for every entity in the given files."""
        index: Dict[str, str] = {}
        for f in file_paths:
            ent = cls.entity_for(f)
            if peer_groups and ent in peer_groups:
                index[ent] = peer_groups[ent]
            else:
                index[ent] = cls.peer_group_for(ent)
        return index

    @staticmethod
    def _is_boilerplate(
        fp: Dict[str, Any],
        threshold: int,
        peer_threshold: int = 2,
    ) -> bool:
        """Whether a fingerprint is repetition across *companies*, not filings.

        Two ways to qualify, both counting distinct entities so that a company
        restating itself year after year never does:

        * seen at ``threshold`` or more separate companies anywhere in the
          corpus — text any company would print; or
        * seen at ``peer_threshold`` or more companies inside one format
          family — template wording shared by a stack of shells, which the
          corpus-wide count misses because no other family words it the same.
        """
        if fp.get("is_protected") or fp.get("is_financial"):
            return False
        if len(fp.get("entities", ())) >= threshold:
            return True
        by_group = fp.get("entities_by_group") or {}
        return any(len(ents) >= peer_threshold for ents in by_group.values())

    @staticmethod
    def _build_company_names(root_dir: Optional[Path] = None, file_paths: Optional[List[Path]] = None) -> Set[str]:
        """Collect company names from directory names."""
        names: Set[str] = set()
        dirs_to_check: Set[Path] = set()

        if root_dir and root_dir.exists():
            for d in root_dir.iterdir():
                if d.is_dir() and not d.name.startswith("."):
                    dirs_to_check.add(d)

        if file_paths:
            for f in file_paths:
                # If path is .../Company Name/Markdown/file.md
                if f.parent.name == "Markdown":
                    dirs_to_check.add(f.parent.parent)
                else:
                    dirs_to_check.add(f.parent)

        for d in dirs_to_check:
            name = d.name
            if name not in ("Accounts", "documents", "Markdown", "Consolidated", LIGHTWEIGHT_DIR_NAME):
                names.add(name)
                for suffix in (" Limited", " Ltd", " PLC", " plc", " SARL"):
                    if name.endswith(suffix):
                        names.add(name[:-len(suffix)])

        return names

    @classmethod
    def _normalize(cls, text: str, company_names: Optional[Set[str]] = None) -> str:
        """Mask entity-specific tokens so structurally identical prose hashes
        the same regardless of which company or year it belongs to.
        """
        normed = text

        if company_names:
            for name in sorted(company_names, key=len, reverse=True):
                normed = normed.replace(name, "{COMPANY}")

        normed = _DATE_RE.sub("{DATE}", normed)
        normed = _AMOUNT_RE.sub("{AMOUNT}", normed)
        normed = _REGNUM_RE.sub("{REGNUM}", normed)
        normed = _PERCENT_RE.sub("{PERCENT}", normed)
        normed = _YEAR_RE.sub("{YEAR}", normed)
        normed = _NUMBER_RE.sub("{NUM}", normed)
        normed = re.sub(r'\s+', ' ', normed).strip().lower()
        return normed

    @staticmethod
    def _money_tokens(text: str) -> Set[str]:
        """Every monetary figure in a passage.

        Normalisation masks amounts so that structurally identical statutory
        prose hashes the same whatever the numbers in it. That is what makes
        cross-company matching work, and it is also how a sentence carrying a
        figure this filing alone reports can be mistaken for one that says
        nothing. Before a passage is removed, its figures are checked against
        the copy being kept; anything new stays.
        """
        return {m.group(0).lower().replace(" ", "") for m in _AMOUNT_RE.finditer(text)}

    @staticmethod
    def _exact_hash(text: str) -> str:
        """Hash of the passage as written, whitespace collapsed.

        Used for same-company de-duplication, which must not go through
        normalisation: consecutive filings of one company differ mainly in
        their numbers, and masking those makes last year's results identical
        to this year's.
        """
        return hashlib.sha256(
            re.sub(r'\s+', ' ', text).strip().encode("utf-8")
        ).hexdigest()[:16]

    @staticmethod
    def _text_hash(text: str) -> str:
        """Stable hash of normalised text."""
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def _jaccard_similarity_sets(
        words_a: Set[str],
        words_b: Set[str],
        similarity: float = 0.85,
    ) -> float:
        """Word-level Jaccard similarity between two precomputed sets.

        ``similarity`` is the threshold the caller is going to compare against.
        It is used only to skip the intersection when the two sets are too
        differently sized to reach it — |A∩B| ≤ min(|A|,|B|) and |A∪B| ≥
        max(|A|,|B|), so the ratio can never beat min/max. The bound was
        previously hardcoded at 0.7, which is sound for the default 0.85 but
        silently returns 0.0 for any caller asking for a looser match.
        """
        if not words_a or not words_b:
            return 0.0
        len_a, len_b = len(words_a), len(words_b)
        min_len, max_len = min(len_a, len_b), max(len_a, len_b)
        if min_len / max_len < similarity:
            return 0.0
        intersection_len = len(words_a & words_b)
        union_len = len_a + len_b - intersection_len
        return intersection_len / union_len if union_len > 0 else 0.0

    # ── Guards ─────────────────────────────────────────────────────────────

    @staticmethod
    def _is_protected(heading: Optional[str], body: str) -> bool:
        """True if the section heading or body contains a protected keyword."""
        if heading:
            h_lower = heading.lower()
            # Statutory responsibilities statement mentions "Strategic Report" in title but is boilerplate
            if "responsibilities" in h_lower and ("director" in h_lower or "statement" in h_lower):
                return False
            if any(kw in h_lower for kw in PROTECTED_HEADING_KEYWORDS):
                return True
        b_lower = body.lower()
        if any(kw in b_lower for kw in PROTECTED_BODY_KEYWORDS):
            return True
        # Board changes are part of the story, so a section that records one is
        # protected. The test used to be the bare presence of "appointed" or
        # "resigned" anywhere in the text, which also protected every auditor's
        # report that opens "we were appointed by the directors" — half a
        # megabyte of pure boilerplate across this corpus. Require the word to
        # be attached to a person: a date beside it, or the list layout a
        # directors' section is written in.
        if _BOARD_CHANGE_RE.search(body):
            return True
        return False

    @staticmethod
    def _is_financial_statement(heading: Optional[str]) -> bool:
        """True if the heading names a primary financial statement."""
        if not heading:
            return False
        lower = heading.lower()
        return any(kw in lower for kw in _FINANCIAL_STATEMENT_KEYWORDS)

    # ── Phase 1: Scan ─────────────────────────────────────────────────────

    @classmethod
    def scan_files(
        cls,
        file_paths: List[Path],
        company_names: Optional[Set[str]] = None,
        threshold: int = 3,
        similarity: float = 0.85,
        peer_threshold: int = 2,
        peer_groups: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Read Markdown transcripts and build a fingerprint library.

        A fingerprint is a normalised section of text, recorded against every
        file, company and format family it was found in. What makes it
        boilerplate is decided later by ``_is_boilerplate`` — the counting that
        matters is of companies, not files.
        """
        if company_names is None:
            company_names = cls._build_company_names(file_paths=file_paths)

        group_of = cls._group_index(file_paths, peer_groups)

        # hash -> fp_info
        fingerprints: Dict[str, Dict[str, Any]] = {}
        # len -> list of (hash, word_set)
        from collections import defaultdict
        known_fps_by_len: Dict[int, List[Tuple[str, Set[str]]]] = defaultdict(list)
        total_sections = 0

        for md_path in file_paths:
            try:
                content = md_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue

            file_id = str(md_path)
            entity = cls.entity_for(md_path)
            group = group_of.get(entity, "")
            # Scaffolding first, exactly as ``deflate_file`` does. The two
            # passes have to read the same text or a section's fingerprint on
            # the way in will not be the fingerprint it presents on the way
            # out: page headers and footers land inside section bodies, so
            # leaving them in moved roughly a third of this corpus's sections
            # far enough from their own library entry to fall below the
            # similarity threshold and never match.
            sections = cls._split_into_sections(cls.strip_scaffolding(content))

            for sec in sections:
                body = sec["body"]
                heading = sec["heading"]

                word_count = len(body.split())
                if word_count < MIN_SECTION_WORDS:
                    continue

                total_sections += 1
                normed = cls._normalize(body, company_names)
                h = cls._text_hash(normed)

                if h in fingerprints:
                    cls._record_occurrence(fingerprints[h], file_id, entity, group, body)
                else:
                    words = set(normed.split())
                    n_words = len(words)
                    merged = False

                    # Only check candidate fingerprints with compatible word counts
                    min_l = int(n_words * similarity)
                    max_l = int(n_words / similarity) + 1

                    for l in range(min_l, max_l + 1):
                        candidates = known_fps_by_len.get(l)
                        if not candidates:
                            continue
                        for existing_h, existing_words in candidates:
                            if cls._jaccard_similarity_sets(words, existing_words, similarity) >= similarity:
                                cls._record_occurrence(fingerprints[existing_h], file_id, entity, group, body)
                                merged = True
                                break
                        if merged:
                            break

                    if not merged:
                        protected = cls._is_protected(heading, body)
                        financial = cls._is_financial_statement(heading)
                        fingerprints[h] = {
                            "normalised": normed,
                            "heading": heading,
                            "raw_example": body[:500],
                            "files": {file_id},
                            "entities": {entity},
                            "entities_by_group": {group: {entity}},
                            # Files are visited in sorted order, so the first
                            # one to carry a passage is a stable choice of
                            # where the surviving copy lives.
                            "canonical_file": file_id,
                            "canonical_money": cls._money_tokens(body),
                            "exact_hashes": {cls._exact_hash(body)},
                            "is_protected": protected,
                            "is_financial": financial,
                            "word_count": word_count,
                            "word_set": words,
                        }
                        known_fps_by_len[n_words].append((h, words))

        candidate_sections = sum(
            1
            for fp in fingerprints.values()
            if cls._is_boilerplate(fp, threshold, peer_threshold)
        )

        return {
            "fingerprints": fingerprints,
            "company_names": company_names,
            "files_scanned": len(file_paths),
            "entities_scanned": len(set(group_of.values() and group_of.keys())),
            "groups_scanned": len(set(group_of.values())),
            "total_sections": total_sections,
            "candidate_sections": candidate_sections,
        }

    @staticmethod
    def _record_occurrence(
        fp: Dict[str, Any],
        file_id: str,
        entity: str,
        group: str,
        body: Optional[str] = None,
    ) -> None:
        """Note another sighting of a fingerprint, by file, company and family."""
        if body is not None:
            fp.setdefault("exact_hashes", set()).add(
                hashlib.sha256(re.sub(r'\s+', ' ', body).strip().encode("utf-8")).hexdigest()[:16]
            )
        fp["files"].add(file_id)
        fp.setdefault("entities", set()).add(entity)
        fp.setdefault("entities_by_group", {}).setdefault(group, set()).add(entity)

    @classmethod
    def scan_corpus(
        cls,
        root_dir: Path,
        threshold: int = 3,
        similarity: float = 0.85,
    ) -> Dict[str, Any]:
        """Discover all markdown files in root_dir and scan."""
        root = Path(root_dir)
        company_names = cls._build_company_names(root_dir=root)
        md_files = sorted(
            p for p in root.rglob("*.md")
            if p.is_file()
            and not is_consolidated(p)
            and not is_lightweight(p)
            and not p.name.endswith("_Index.md")
            and not p.name.startswith(".")
            and "Markdown" in p.parts
        )
        return cls.scan_files(md_files, company_names=company_names, threshold=threshold, similarity=similarity)

    # ── Phase 2: Verify (optional LLM classifier) ─────────────────────────

    @classmethod
    def verify_candidates(
        cls,
        fingerprints: Dict[str, Dict[str, Any]],
        threshold: int = 3,
        model: str = "gemini-2.5-flash-lite",
        peer_threshold: int = 2,
    ) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Any]]:
        """Ask an LLM to classify each candidate: pure boilerplate or not.

        Returns the fingerprints alongside a summary of whether the classifier
        was actually reachable. The caller needs that: in safe mode a section
        is removed only on an explicit BOILERPLATE verdict, so a run where no
        verdict was ever obtained removes nothing at section level, and must
        say so rather than appearing to have verified 1,200 sections.
        """
        from .genai_factory import build_client

        candidates = {
            h: fp
            for h, fp in fingerprints.items()
            if cls._is_boilerplate(fp, threshold, peer_threshold)
        }

        summary: Dict[str, Any] = {
            "available": False,
            "candidates": len(candidates),
            "verified": 0,
            "strip": 0,
            "keep": 0,
            "failed": 0,
            "error": None,
        }

        if not candidates:
            summary["available"] = True
            return fingerprints, summary

        try:
            client, _info = build_client()
        except Exception as e:
            logger.warning("Could not build Gemini client for verification: %s", e)
            summary["error"] = str(e)
            return fingerprints, summary

        summary["available"] = True

        prompt_template = (
            "You are reviewing a section from a UK company's statutory accounts "
            "that has been flagged as potential boilerplate text because it appears "
            "near-identically in {file_count} different company filings.\n\n"
            "SECTION TEXT (first 500 characters):\n"
            "```\n{raw_example}\n```\n\n"
            "SECTION HEADING: {heading}\n\n"
            "Does this section contain ONLY standard statutory, regulatory, or "
            "accounting-policy text that would be identical in any UK company's "
            "accounts?  Or does it contain ANY company-specific financial data, "
            "performance commentary, or unique operational information?\n\n"
            "Respond with exactly one word: BOILERPLATE or KEEP"
        )

        for h, fp in candidates.items():
            prompt = prompt_template.format(
                file_count=len(fp["files"]),
                raw_example=fp["raw_example"],
                heading=fp["heading"] or "(no heading)",
            )
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=prompt,
                )
                answer = (response.text or "").strip().upper()
                fp["llm_verdict"] = "strip" if "BOILERPLATE" in answer else "keep"
                summary["verified"] += 1
                summary[fp["llm_verdict"]] += 1
            except Exception as e:
                logger.warning("LLM verification failed for section '%s': %s",
                               fp.get("heading", "?"), e)
                fp["llm_verdict"] = "keep"  # fail-safe: keep on error
                summary["failed"] += 1

        return fingerprints, summary

    # ── Scaffolding stripper ───────────────────────────────────────────────

    @classmethod
    def strip_scaffolding(cls, content: str) -> str:
        """Remove page-level scaffolding that carries zero analytical content."""
        text = content

        # Companies House receipt stamps.
        text = _COMPANIES_HOUSE_STAMP_RE.sub('\n', text)

        # Page markers (<!-- Page N --> / ## Page N).
        text = _PAGE_MARKER_RE.sub('', text)
        text = _PAGE_HEADING_RE.sub('', text)

        # Repeated page headers (keep only the first occurrence on cover page).
        headers_found = list(_REPEATED_HEADER_RE.finditer(text))
        if len(headers_found) > 1:
            for m in reversed(headers_found[1:]):
                text = text[:m.start()] + '\n' + text[m.end():]

        # Page-number footer lines.
        text = _PAGE_FOOTER_RE.sub('', text)
        text = _PAGE_FOOTER_ALT_RE.sub('', text)

        # Collapse runs of horizontal rules.
        text = _EXCESS_RULES_RE.sub('\n---\n', text)

        # Clean up excessive blank lines.
        text = re.sub(r'\n{4,}', '\n\n\n', text)

        return text.strip() + '\n'

    # ── Phase 3: Deflate ──────────────────────────────────────────────────

    @classmethod
    def deflate_file(
        cls,
        filepath: Path,
        fingerprints: Dict[str, Dict[str, Any]],
        company_names: Optional[Set[str]] = None,
        threshold: int = 3,
        similarity: float = 0.85,
        mode: str = "safe",
        fps_by_len: Optional[Dict[int, List[Tuple[str, Set[str]]]]] = None,
        peer_threshold: int = 2,
        written_paths: Optional[Set[str]] = None,
    ) -> Dict[str, Any]:
        """Produce a lightweight version of a single Markdown file.

        ``written_paths`` is every file this run will write. A passage is only
        replaced by a pointer when a copy of it survives somewhere the reader
        will have; where none does, this file keeps the text and becomes the
        copy the rest point at. That claims the fingerprint for the run, so the
        library passed in is updated as files are processed — the promise being
        kept is one copy per output set, not one per scan.
        """
        try:
            original = filepath.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            raise ValueError(f"Cannot read {filepath}: {e}") from e

        original_size = len(original.encode("utf-8"))

        # Step 1: Always strip page scaffolding.
        content = cls.strip_scaffolding(original)

        # Step 2: Split into sections and check each against fingerprints.
        sections = cls._split_into_sections(content)
        kept_parts: List[str] = []
        sections_removed: List[str] = []
        sections_kept: List[str] = []
        removals: List[Dict[str, str]] = []

        for sec in sections:
            body = sec["body"]
            heading = sec["heading"]
            word_count = len(body.split())

            # Tiny sections: always keep (not worth fingerprinting).
            if word_count < MIN_SECTION_WORDS:
                kept_parts.append(body)
                continue

            # Financial statements: always keep.
            if cls._is_financial_statement(heading):
                kept_parts.append(body)
                sections_kept.append(heading or "(untitled)")
                continue

            # Protected sections: always keep.
            if cls._is_protected(heading, body):
                kept_parts.append(body)
                sections_kept.append(heading or "(untitled)")
                continue

            # Sections with tables: always keep.
            if sec["has_table"]:
                kept_parts.append(body)
                sections_kept.append(heading or "(untitled)")
                continue

            # Check against fingerprints.
            normed = cls._normalize(body, company_names)
            h = cls._text_hash(normed)
            matched_fp = None

            if h in fingerprints:
                matched_fp = fingerprints[h]
            else:
                words = set(normed.split())
                n_words = len(words)
                min_l = int(n_words * similarity)
                max_l = int(n_words / similarity) + 1

                if fps_by_len is not None:
                    for l in range(min_l, max_l + 1):
                        candidates = fps_by_len.get(l)
                        if not candidates:
                            continue
                        for existing_h, existing_words in candidates:
                            if cls._jaccard_similarity_sets(words, existing_words, similarity) >= similarity:
                                matched_fp = fingerprints[existing_h]
                                break
                        if matched_fp:
                            break
                else:
                    for fp_hash, fp in fingerprints.items():
                        fp_words = fp.get("word_set")
                        if fp_words is None:
                            fp_words = set(fp["normalised"].split())
                            fp["word_set"] = fp_words
                        if cls._jaccard_similarity_sets(words, fp_words, similarity) >= similarity:
                            matched_fp = fp
                            break

            label = heading or "(untitled)"
            reason = None

            if matched_fp:
                if cls._is_boilerplate(matched_fp, threshold, peer_threshold):
                    reason = "boilerplate"
                elif (
                    len(matched_fp.get("entities", ())) == 1
                    and len(matched_fp.get("files", ())) >= 2
                    # Same company, later filing: only de-duplicated when the
                    # passage is word-for-word what the kept copy says. A
                    # normalised match is not enough here — consecutive filings
                    # of one company differ precisely in the numbers that
                    # normalisation hides.
                    and cls._exact_hash(body) in matched_fp.get("exact_hashes", ())
                    and len(matched_fp.get("exact_hashes", ())) == 1
                ):
                    reason = "restatement"

            # This file holds the copy everything else points at — either
            # because the scan chose it, or because nothing else being written
            # carries this passage and someone has to keep it.
            if reason:
                canonical_path = matched_fp.get("canonical_file")
                orphaned = (
                    written_paths is not None and canonical_path not in written_paths
                )
                if canonical_path == str(filepath) or orphaned:
                    matched_fp["canonical_file"] = str(filepath)
                    kept_parts.append(body)
                    sections_kept.append(label)
                    continue

            # Safe mode removes a section only when the classifier said so. The
            # test used to be "unless it said keep", which meant a run with no
            # API key — where no verdict exists at all — removed everything the
            # algorithm alone had flagged, while still calling itself the
            # verified mode. Same-company de-duplication is exact and lossless,
            # so it is not the classifier's to rule on.
            if reason == "boilerplate" and mode == "safe" and matched_fp.get("llm_verdict") != "strip":
                reason = None

            # A figure this filing reports and the kept copy does not is, by
            # definition, not boilerplate.
            if reason:
                novel = cls._money_tokens(body) - set(matched_fp.get("canonical_money", ()))
                if novel:
                    reason = None

            if not reason:
                kept_parts.append(body)
                sections_kept.append(label)
                continue

            canonical = Path(matched_fp.get("canonical_file", "")).name or "another filing"
            if reason == "boilerplate":
                where = (
                    f"{len(matched_fp.get('entities', ()))} companies, "
                    f"{len(matched_fp.get('files', ()))} filings"
                )
                note = f"standard statutory text shared by {where}"
            else:
                note = (
                    f"repeated verbatim from an earlier filing by this company "
                    f"({len(matched_fp.get('files', ()))} filings carry it)"
                )
            placeholder = (
                f"\n> [DEFLATED — {label}: {note}. "
                f"Full text kept in `{canonical}`.]\n"
            )
            kept_parts.append(placeholder)
            sections_removed.append(label)
            removals.append({"heading": label, "reason": reason, "canonical": canonical})

        # Concatenated, not joined: section bodies are contiguous slices of the
        # source, so nothing between them is ours to add. Joining on a newline
        # inserted one per section, which made a document with no boilerplate
        # in it come out fractionally larger than the original.
        lightweight = "".join(kept_parts).strip() + "\n"
        lightweight = re.sub(r'\n{4,}', '\n\n\n', lightweight)
        lightweight_size = len(lightweight.encode("utf-8"))

        return {
            "content": lightweight,
            "original_size": original_size,
            "lightweight_size": lightweight_size,
            "reduction_pct": round(
                (1.0 - lightweight_size / original_size) * 100, 1
            ) if original_size > 0 else 0.0,
            "sections_removed": sections_removed,
            "sections_kept": sections_kept,
            "removals": removals,
        }

    # ── Corpus-level pipeline ─────────────────────────────────────────────

    @classmethod
    def deflate_files(
        cls,
        file_paths: List[Path],
        root_dir: Optional[Path] = None,
        mode: str = "algorithmic",
        threshold: int = 3,
        similarity: float = 0.85,
        model: str = "gemini-2.5-flash-lite",
        output_dir_name: str = LIGHTWEIGHT_DIR_NAME,
        progress_callback=None,
        reference_paths: Optional[List[Path]] = None,
        peer_threshold: int = 2,
        peer_groups: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Deflate ``file_paths``, judging repetition against ``reference_paths``.

        Boilerplate is a claim about a corpus, not about a document: text is
        boilerplate because other filings say the same thing. ``reference_paths``
        is the corpus that claim is measured against — every filing in the
        workspace, typically — while ``file_paths`` is the smaller set actually
        rewritten. They default to the same list, which is right for a
        whole-workspace run and wrong for anything narrower: deflating one
        document against itself finds every section repeated across "all the
        filings examined", because there was only ever one.
        """
        references = list(reference_paths) if reference_paths else list(file_paths)
        # Whatever is being written must also be read, or its own sections have
        # nothing to be compared with.
        for f in file_paths:
            if f not in references:
                references.append(f)

        company_names = cls._build_company_names(root_dir=root_dir, file_paths=references)

        # A threshold above the corpus size can never be met, so it is clamped —
        # but never below MIN_THRESHOLD, and a corpus too small to reach even
        # that has no repetition to speak of.
        entities = {cls.entity_for(f) for f in references}
        effective_threshold = max(MIN_THRESHOLD, min(threshold, len(entities)))
        # Repetition is counted in companies. One company's filings, however
        # many, tell you only that it files consistently.
        corpus_too_small = len(entities) < MIN_THRESHOLD and len(references) < MIN_THRESHOLD

        if corpus_too_small:
            logger.info(
                "Only %d file(s) to compare: removing page scaffolding only. "
                "Pass reference_paths to judge against the wider workspace.",
                len(references),
            )
            scan = {
                "fingerprints": {},
                "company_names": company_names,
                "files_scanned": len(references),
                "total_sections": 0,
                "candidate_sections": 0,
            }
        else:
            logger.info("Phase 1: Scanning %d files for repeated sections...", len(references))
            scan = cls.scan_files(
                references,
                company_names=company_names,
                threshold=effective_threshold,
                similarity=similarity,
                peer_threshold=peer_threshold,
                peer_groups=peer_groups,
            )
        fingerprints = scan["fingerprints"]

        if not file_paths:
            return {
                "mode": mode,
                "root": str(root_dir) if root_dir else "custom",
                "threshold": effective_threshold,
                "files_scanned": 0,
                "files_deflated": 0,
                "total_original_bytes": 0,
                "total_lightweight_bytes": 0,
                "total_reduction_pct": 0.0,
                "est_tokens_saved": 0,
                "corpus_too_small": corpus_too_small,
                "verification": None,
                "file_results": [],
                "scan": scan,
            }

        # Phase 2: Verify (safe mode only).
        verification: Optional[Dict[str, Any]] = None
        if mode == "safe":
            logger.info("Phase 2: LLM verification of %d candidate sections...", scan["candidate_sections"])
            fingerprints, verification = cls.verify_candidates(
                fingerprints, threshold=effective_threshold, model=model,
                peer_threshold=peer_threshold,
            )
            if not verification["available"]:
                logger.warning(
                    "Safe mode could not reach the classifier (%s). No section-level "
                    "text will be removed; page scaffolding still will be.",
                    verification.get("error") or "no client",
                )
        else:
            logger.info("Phase 2: Skipped (mode=%s).", mode)

        # Phase 3: Deflate each file.
        file_results: List[Dict[str, Any]] = []
        total_original = 0
        total_lightweight = 0

        # Point each pointer at a copy the reader will actually have.
        #
        # The canonical file is chosen during the scan, from the whole reference
        # corpus — which is right for deciding *whether* something repeats, and
        # wrong for saying where to read it. Deflating one group's filings while
        # judging them against the whole workspace left notes pointing at an
        # unrelated company's filing, which is not in the folder being written.
        # Where a copy exists among the files being written, name that one.
        written_set = {str(f) for f in file_paths}
        for fp in fingerprints.values():
            if fp.get("canonical_file") in written_set:
                continue
            local = sorted(fp.get("files", ()) & written_set)
            if local:
                fp["canonical_file"] = local[0]

        # Build length-bucketed index once for fast fuzzy matching
        from collections import defaultdict
        fps_by_len: Dict[int, List[Tuple[str, Set[str]]]] = defaultdict(list)
        for h, fp in fingerprints.items():
            wset = fp.get("word_set")
            if wset is None:
                wset = set(fp["normalised"].split())
                fp["word_set"] = wset
            fps_by_len[len(wset)].append((h, wset))

        for idx, md_path in enumerate(file_paths):
            if progress_callback:
                progress_callback({
                    "current_file": md_path.name,
                    "current_index": idx + 1,
                    "total_files": len(file_paths),
                })

            try:
                result = cls.deflate_file(
                    md_path,
                    fingerprints,
                    company_names=company_names,
                    threshold=effective_threshold,
                    similarity=similarity,
                    mode=mode,
                    fps_by_len=fps_by_len,
                    peer_threshold=peer_threshold,
                    written_paths=written_set,
                )
            except Exception as e:
                logger.warning("Error deflating %s: %s", md_path, e)
                continue

            total_original += result["original_size"]
            total_lightweight += result["lightweight_size"]

            if md_path.parent.name == "Markdown":
                out_dir = md_path.parent.parent / output_dir_name
            else:
                out_dir = md_path.parent / output_dir_name
            out_path = out_dir / md_path.name

            file_entry = {
                "source": str(md_path),
                "output": str(out_path),
                "original_size": result["original_size"],
                "lightweight_size": result["lightweight_size"],
                "reduction_pct": result["reduction_pct"],
                "sections_removed": result["sections_removed"],
                "sections_kept": result["sections_kept"],
                "removals": result["removals"],
            }

            if mode != "dry-run":
                out_dir.mkdir(parents=True, exist_ok=True)
                staging = out_path.with_name(out_path.name + ".partial")
                try:
                    staging.write_text(result["content"], encoding="utf-8")
                    os.replace(staging, out_path)
                    file_entry["written"] = True
                except BaseException:
                    staging.unlink(missing_ok=True)
                    raise
            else:
                file_entry["written"] = False

            file_results.append(file_entry)

        overall_pct = (
            round((1.0 - total_lightweight / total_original) * 100, 1)
            if total_original > 0
            else 0.0
        )

        return {
            "mode": mode,
            "root": str(root_dir) if root_dir else "custom",
            "threshold": effective_threshold,
            "peer_threshold": peer_threshold,
            "entities_scanned": len(entities),
            "files_scanned": scan["files_scanned"],
            "files_deflated": len(file_results),
            "total_original_bytes": total_original,
            "total_lightweight_bytes": total_lightweight,
            "total_reduction_pct": overall_pct,
            "est_tokens_saved": (total_original - total_lightweight) // 4,
            "corpus_too_small": corpus_too_small,
            "verification": verification,
            "file_results": file_results,
            "scan": scan,
        }

    @classmethod
    def deflate_corpus(
        cls,
        root_dir: Path,
        mode: str = "algorithmic",
        threshold: int = 3,
        similarity: float = 0.85,
        model: str = "gemini-2.5-flash-lite",
        output_dir_name: str = LIGHTWEIGHT_DIR_NAME,
        progress_callback=None,
        peer_threshold: int = 2,
        peer_groups: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Full directory scan and deflation."""
        root = Path(root_dir)
        md_files = sorted(
            p for p in root.rglob("*.md")
            if p.is_file()
            and not is_consolidated(p)
            and not is_lightweight(p)
            and not p.name.endswith("_Index.md")
            and not p.name.startswith(".")
            and "Markdown" in p.parts
        )
        return cls.deflate_files(
            file_paths=md_files,
            root_dir=root,
            mode=mode,
            threshold=threshold,
            similarity=similarity,
            model=model,
            output_dir_name=output_dir_name,
            progress_callback=progress_callback,
            reference_paths=md_files,
            peer_threshold=peer_threshold,
            peer_groups=peer_groups,
        )

    # ── Report generation ─────────────────────────────────────────────────

    @classmethod
    def generate_report(cls, results: Dict[str, Any]) -> str:
        """Produce a human-readable Markdown report of the deflation run."""
        scan = results.get("scan", {})
        fingerprints = scan.get("fingerprints", {})
        # The threshold the run actually used. Hardcoding 3 here let the report
        # list patterns the run had not removed, and omit ones it had.
        threshold = results.get("threshold", MIN_THRESHOLD)
        peer_threshold = results.get("peer_threshold", 2)

        lines: List[str] = []
        lines.append("# GooseQuill Deflate — Boilerplate Removal Report\n")
        lines.append(
            f"> Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}  \n"
            f"> Mode: `{results['mode']}`  \n"
            f"> Target: `{results['root']}`  \n"
            f"> Threshold: appears at {threshold}+ separate companies, "
            f"or {peer_threshold}+ within one format family\n"
        )

        # Anything that stopped this run short of what its mode advertises is
        # said here, at the top, rather than left to be inferred from a low
        # reduction figure.
        if results.get("corpus_too_small"):
            lines.append(
                "\n> **Page scaffolding only.** Fewer than "
                f"{MIN_THRESHOLD} filings were compared, so there was no repetition "
                "to measure and no section-level text was removed.\n"
            )
        verification = results.get("verification")
        if results.get("mode") == "safe" and verification is not None and not verification.get("available"):
            lines.append(
                "\n> **Not verified.** Safe mode could not reach the classifier"
                f"{' (' + str(verification.get('error')) + ')' if verification.get('error') else ''}, "
                "and safe mode removes a section only on an explicit verdict. Page "
                "scaffolding was still removed; no section-level text was.\n"
            )
        elif verification is not None and verification.get("available"):
            lines.append(
                f"\n> Classifier reviewed {verification['verified']} of "
                f"{verification['candidates']} candidates: {verification['strip']} confirmed "
                f"boilerplate, {verification['keep']} kept"
                f"{', ' + str(verification['failed']) + ' failed and kept' if verification.get('failed') else ''}.\n"
            )

        lines.append("---\n")

        lines.append("## Corpus Summary\n")
        lines.append(f"| Metric | Value |")
        lines.append(f"| :--- | ---: |")
        lines.append(f"| Files scanned | {results['files_scanned']} |")
        lines.append(f"| Files deflated | {results['files_deflated']} |")

        orig_kb = results["total_original_bytes"] / 1024
        lite_kb = results["total_lightweight_bytes"] / 1024
        lines.append(f"| Original corpus size | {orig_kb:,.1f} KB |")
        lines.append(f"| Lightweight corpus size | {lite_kb:,.1f} KB |")
        lines.append(f"| **Reduction** | **{results['total_reduction_pct']}%** |")
        lines.append(f"| Est. tokens saved | ~{results.get('est_tokens_saved', 0):,} |")
        lines.append("")

        boilerplate_fps = {
            h: fp
            for h, fp in fingerprints.items()
            if cls._is_boilerplate(fp, threshold, peer_threshold)
        }

        if boilerplate_fps:
            lines.append("## Boilerplate Patterns Detected\n")
            lines.append("| # | Section Heading | Companies | Filings | Words | LLM Verdict |")
            lines.append("| :-: | :--- | ---: | ---: | ---: | :--- |")
            for i, (h, fp) in enumerate(
                sorted(boilerplate_fps.items(),
                       key=lambda x: len(x[1]["files"]),
                       reverse=True),
                1,
            ):
                heading = fp.get("heading") or "(untitled)"
                verdict = fp.get("llm_verdict", "—")
                lines.append(
                    f"| {i} | {heading} | {len(fp.get('entities', ()))} | {len(fp['files'])} | "
                    f"{fp.get('word_count', '?')} | {verdict} |"
                )
            lines.append("")

        restatements: Dict[str, int] = {}
        for fr in results.get("file_results", []):
            for r in fr.get("removals", []):
                if r.get("reason") == "restatement":
                    restatements[r["heading"]] = restatements.get(r["heading"], 0) + 1

        if restatements:
            lines.append("## Passages a Company Restated\n")
            lines.append(
                "Word-for-word repeats of an earlier filing by the same company. "
                "The earliest filing keeps the text in full; the later ones point at it.\n"
            )
            lines.append("| Section Heading | Later copies replaced |")
            lines.append("| :--- | ---: |")
            for heading, count in sorted(restatements.items(), key=lambda x: -x[1]):
                lines.append(f"| {heading} | {count} |")
            lines.append("")

        protected_fps = {
            h: fp
            for h, fp in fingerprints.items()
            if fp.get("is_protected") or fp.get("is_financial")
        }

        if protected_fps:
            lines.append("## Protected Sections (Never Stripped)\n")
            lines.append("| Section Heading | Reason | Files |")
            lines.append("| :--- | :--- | ---: |")
            for h, fp in sorted(protected_fps.items(),
                                key=lambda x: x[1].get("heading", "")):
                heading = fp.get("heading") or "(untitled)"
                reason = []
                if fp.get("is_financial"):
                    reason.append("Financial statement")
                if fp.get("is_protected"):
                    reason.append("Protected keyword")
                lines.append(
                    f"| {heading} | {', '.join(reason)} | {len(fp['files'])} |"
                )
            lines.append("")

        file_results = results.get("file_results", [])
        if file_results:
            lines.append("## Per-File Results\n")
            lines.append("| File | Original | Lightweight | Reduction | Sections Removed |")
            lines.append("| :--- | ---: | ---: | ---: | ---: |")
            for fr in sorted(file_results, key=lambda x: x.get("reduction_pct", 0), reverse=True):
                name = Path(fr["source"]).name
                orig = f"{fr['original_size'] / 1024:.1f} KB"
                lite = f"{fr['lightweight_size'] / 1024:.1f} KB"
                pct = f"{fr['reduction_pct']}%"
                removed = len(fr.get("sections_removed", []))
                lines.append(f"| {name} | {orig} | {lite} | {pct} | {removed} |")
            lines.append("")

        lines.append("---\n")
        lines.append(
            "*Report generated by GooseQuill Deflate. "
            "Original files were not modified.*\n"
        )
        return "\n".join(lines)

    @classmethod
    def save_report(cls, root_dir: Path, report_content: str) -> Path:
        """Write the deflation report beside the lightweight output.

        Not at the corpus root: a ``.md`` file there is indexed by the search
        service and offered by the combiner like any transcript, so every run
        left a report competing with the filings for search hits. Inside the
        lightweight directory it is excluded by the same rule that excludes the
        deflated copies themselves.
        """
        out_dir = Path(root_dir) / LIGHTWEIGHT_DIR_NAME
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / DEFLATE_REPORT_NAME
        staging = out.with_name(out.name + ".partial")
        try:
            staging.write_text(report_content, encoding="utf-8")
            os.replace(staging, out)
        except BaseException:
            staging.unlink(missing_ok=True)
            raise
        return out
