#!/usr/bin/env python3
"""
GooseQuill Unified Command-Line Interface (CLI).
Provides unified subcommands for document conversion, markdown consolidation, and server management.

Usage:
  python cli.py convert [--folders ...] [--model ...] [--file ...]
  python cli.py combine [--folder ...] [--files ...] [--output ...]
  python cli.py batch plan <root> [--model ...]
  python cli.py batch run [--plan ID] [--watch]
  python cli.py serve [--host 0.0.0.0] [--port 8000]
"""

import sys
import time
import json
import argparse
from pathlib import Path
from typing import List

PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.models import PricingRegistry
from goosequill.models.document import PROMPT_PRESETS
from goosequill.services.batch_planner import DEFAULT_MAX_ENQUEUED_TOKENS
from goosequill.services.search_service import (
    CONSOLIDATED_DIR_NAME,
    LIGHTWEIGHT_DIR_NAME,
    is_consolidated,
    is_lightweight,
)
from goosequill.services import (
    ConversionEngine,
    PDFRenderer,
    DocumentRepository,
    MarkdownCombinerService,
    BoilerplateDetector,
)

DEFAULT_ACCOUNTS_DIR = PROJECT_ROOT / "Accounts" if (PROJECT_ROOT / "Accounts").exists() else (PROJECT_ROOT / "documents")


def run_convert(args):
    """Execute batch PDF conversion command."""
    from tqdm import tqdm

    try:
        engine = ConversionEngine(
            model_name=args.model,
            concurrency=args.concurrency
        )
    except Exception as e:
        print(f"Error initializing GooseQuill conversion engine: {e}", file=sys.stderr)
        sys.exit(1)

    pdf_files: List[Path] = []
    if args.file:
        p = Path(args.file)
        if p.exists() and p.suffix.lower() == ".pdf":
            pdf_files.append(p)
        else:
            print(f"Specified file not found: {args.file}", file=sys.stderr)
            sys.exit(1)
    else:
        target_folders = args.folders or [DEFAULT_ACCOUNTS_DIR]
        for folder_item in target_folders:
            folder_path = Path(folder_item)
            if folder_path.exists():
                if folder_path.is_dir():
                    # If folder contains subdirectories with PDFs, discover them
                    sub_pdfs = sorted(folder_path.glob("**/*.pdf"))
                    pdf_files.extend([p for p in sub_pdfs if "Markdown" not in p.parts])
            else:
                print(f"Warning: Folder does not exist: {folder_item}", file=sys.stderr)

    # Deduplicate
    pdf_files = list(dict.fromkeys(pdf_files))

    if not pdf_files:
        print("No PDF files found to convert.", file=sys.stderr)
        sys.exit(0)

    print(f"\n========================================================")
    print(f" 📄 GooseQuill — Universal Document Conversion")
    print(f" Found {len(pdf_files)} PDF file(s) to convert")
    print(f" Model: {args.model}")
    print(f" Parallel Concurrency: {args.concurrency} pages/doc")
    print(f" Cache Mode: {'Force Refresh' if args.force else 'Use Cache & Resume'}")
    if args.limit_pages:
        print(f" Page limit: First {args.limit_pages} pages per document")
    print(f"========================================================\n")

    for idx, pdf in enumerate(pdf_files, 1):
        print(f"\n[{idx}/{len(pdf_files)}] Processing: {pdf.parent.name} / {pdf.name}")
        try:
            total_p = PDFRenderer.get_page_count(pdf)
        except Exception:
            total_p = 1

        with tqdm(total=total_p, desc=f"Converting {pdf.stem[:30]}", unit="page") as pbar:
            def on_progress(p_info):
                pbar.update(1)

            try:
                saved_path = engine.convert_document(
                    pdf_path=pdf,
                    force_reprocess=args.force,
                    limit_pages=args.limit_pages,
                    concurrency=args.concurrency,
                    progress_callback=on_progress
                )
                print(f" Saved: {saved_path}")
            except Exception as e:
                print(f" Error processing {pdf.name}: {e}", file=sys.stderr)

    print("\n✨ All conversions completed successfully!\n")


def _combinable(md_infos, args):
    """Drop previous consolidations unless they were explicitly asked for.

    A consolidation contains every document it was made from, so `--all` picking
    them up means each of those documents appears twice and the output grows
    every time it is regenerated. `--files` is left alone: naming a file is
    asking for it.
    """
    include = getattr(args, "include_consolidated", False)
    kept, skipped = [], 0
    for info in md_infos:
        if info.get("is_consolidated") and not include:
            skipped += 1
            continue
        kept.append(Path(info["path"]))

    if skipped:
        print(f" Skipped {skipped} previously consolidated file(s). Use --include-consolidated to keep them.")
    return kept


def run_combine(args):
    """Execute markdown consolidation command."""
    doc_repo = DocumentRepository()
    files_to_combine: List[Path] = []

    if args.files:
        for f_str in args.files:
            p = Path(f_str)
            resolved = MarkdownCombinerService.resolve_markdown_path(p)
            if resolved:
                files_to_combine.append(resolved)
            else:
                print(f"Warning: Could not find markdown for '{f_str}'", file=sys.stderr)
    elif args.folder:
        folder_path = Path(args.folder)
        if not folder_path.is_absolute():
            if (DEFAULT_ACCOUNTS_DIR / args.folder).exists():
                folder_path = DEFAULT_ACCOUNTS_DIR / args.folder
            else:
                folder_path = Path.cwd() / args.folder

        md_infos = doc_repo.get_converted_markdowns(folder_path)
        files_to_combine = _combinable(md_infos, args)
    else:
        # Default / --all
        md_infos = doc_repo.get_converted_markdowns(DEFAULT_ACCOUNTS_DIR)
        files_to_combine = _combinable(md_infos, args)

    if not files_to_combine:
        print("No converted Markdown files found to combine.", file=sys.stderr)
        print("Run conversions first or specify valid --files / --folder.", file=sys.stderr)
        sys.exit(1)

    sort_mapping = {
        "chrono-asc": "chronological_asc",
        "chrono-desc": "chronological_desc",
        "alpha-asc": "alpha_asc",
        "alpha-desc": "alpha_desc",
        "custom": "custom"
    }
    sort_mode = sort_mapping.get(args.sort, "chronological_asc")

    print(f"\n========================================================")
    print(f" 📄 GooseQuill — Markdown Consolidation Pipeline")
    print(f" Discovered {len(files_to_combine)} converted document(s) to combine")
    print(f" Sorting: {args.sort}")
    print(f" Table of Contents: {'Disabled' if args.no_toc else 'Enabled'}")
    print(f" Header Cleaning: {'Disabled' if args.no_clean_headers else 'Enabled'}")
    print(f"========================================================\n")

    try:
        result = MarkdownCombinerService.combine(
            file_paths=files_to_combine,
            master_title=args.title,
            include_toc=not args.no_toc,
            include_source_meta=not args.no_source_meta,
            strip_original_headers=not args.no_clean_headers,
            sort_mode=sort_mode
        )

        output_path_str = args.output
        if not output_path_str:
            if args.folder:
                folder_p = Path(args.folder)
                output_path_str = str(folder_p / CONSOLIDATED_DIR_NAME / f"{folder_p.name}_Consolidated.md")
            else:
                output_path_str = str(DEFAULT_ACCOUNTS_DIR / CONSOLIDATED_DIR_NAME / "Consolidated_Master_Accounts.md")

        out_file = MarkdownCombinerService.save_combined_document(output_path_str, result["content"])

        print(f" Consolidated Document Created Successfully:")
        print(f"   • Title: {result['title']}")
        print(f"   • Documents: {result['total_documents']}")
        print(f"   • Total Pages: {result['total_pages']}")
        print(f"   • Words: {result['total_words']:,}")
        print(f"   • Characters: {result['total_chars']:,}")
        print(f"   • Saved to: {out_file.resolve()}")
        print(f"\n✨ Done!\n")

    except Exception as e:
        print(f"Error combining documents: {e}", file=sys.stderr)
        sys.exit(1)


def run_deflate(args):
    """Execute boilerplate detection and removal."""
    from tqdm import tqdm

    doc_repo = DocumentRepository()
    files_to_deflate: List[Path] = []
    report_root: Path = DEFAULT_ACCOUNTS_DIR

    if args.files:
        for f_str in args.files:
            p = Path(f_str)
            resolved = MarkdownCombinerService.resolve_markdown_path(p)
            if resolved and not is_consolidated(resolved) and not is_lightweight(resolved):
                files_to_deflate.append(resolved)
            else:
                print(f"Warning: Could not find valid markdown for '{f_str}'", file=sys.stderr)
        if files_to_deflate:
            report_root = files_to_deflate[0].parent.parent if files_to_deflate[0].parent.name == "Markdown" else files_to_deflate[0].parent
    elif args.folder:
        folder_path = Path(args.folder)
        if not folder_path.is_absolute():
            if (DEFAULT_ACCOUNTS_DIR / args.folder).exists():
                folder_path = DEFAULT_ACCOUNTS_DIR / args.folder
            else:
                folder_path = Path.cwd() / args.folder

        if not folder_path.exists():
            print(f"Directory does not exist: {folder_path}", file=sys.stderr)
            sys.exit(1)

        report_root = folder_path
        md_infos = doc_repo.get_converted_markdowns(folder_path)
        files_to_deflate = [
            Path(info["path"]) for info in md_infos
            if not info.get("is_consolidated") and not is_lightweight(Path(info["path"]))
        ]
    else:
        # Default / --all
        md_infos = doc_repo.get_converted_markdowns(DEFAULT_ACCOUNTS_DIR)
        files_to_deflate = [
            Path(info["path"]) for info in md_infos
            if not info.get("is_consolidated") and not is_lightweight(Path(info["path"]))
        ]

    # Deduplicate
    files_to_deflate = list(dict.fromkeys(files_to_deflate))

    if not files_to_deflate:
        print("No converted Markdown files found to deflate.", file=sys.stderr)
        print("Run conversions first or specify valid --files / --folder.", file=sys.stderr)
        sys.exit(1)

    mode_label = {
        "safe": "Safe (algorithmic + LLM verification)",
        "algorithmic": "Algorithmic only (no LLM, deterministic)",
        "dry-run": "Dry Run (report only, no files written)",
    }

    print(f"\n========================================================")
    print(f" 📄 GooseQuill — Deflate (Boilerplate Removal)")
    print(f" Target Files: {len(files_to_deflate)} document(s)")
    print(f" Mode: {mode_label.get(args.mode, args.mode)}")
    print(f" Threshold: {args.threshold} companies (or {args.peer_threshold} within a family)")
    print(f" Compared against: {'the whole workspace' if args.compare_against == 'workspace' else 'the selection only'}")
    print(f" Similarity: {args.similarity}")
    if args.mode == "safe":
        print(f" Verification Model: {args.model}")
    print(f" Output Folder: {args.output_dir}/")
    print(f"========================================================\n")

    pbar = None

    def on_progress(info):
        nonlocal pbar
        total = info.get("total_files", 0)
        if pbar is None and total > 0:
            pbar = tqdm(total=total, desc="Deflating", unit="file")
        if pbar:
            pbar.update(1)

    try:
        references = files_to_deflate
        if args.compare_against == "workspace":
            # Repetition is a claim about a corpus. Deflating a handful of
            # filings against only each other would find every shared sentence
            # "repeated throughout the corpus examined", which is a different
            # and much weaker statement.
            references = [
                Path(info["path"])
                for info in doc_repo.get_converted_markdowns(DEFAULT_ACCOUNTS_DIR)
                if not info.get("is_consolidated")
                and not is_lightweight(Path(info["path"]))
                and "Markdown" in Path(info["path"]).parts
            ]

        results = BoilerplateDetector.deflate_files(
            file_paths=files_to_deflate,
            reference_paths=references,
            root_dir=report_root,
            mode=args.mode,
            threshold=args.threshold,
            peer_threshold=args.peer_threshold,
            similarity=args.similarity,
            model=args.model,
            output_dir_name=args.output_dir,
            progress_callback=on_progress,
        )
    except Exception as e:
        print(f"Error during deflation: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        if pbar:
            pbar.close()

    # Print summary.
    orig_kb = results["total_original_bytes"] / 1024
    lite_kb = results["total_lightweight_bytes"] / 1024
    saved_kb = orig_kb - lite_kb

    print(f"\n Results:")
    print(f"   • Files processed:  {results['files_deflated']}")
    print(f"   • Original size:    {orig_kb:,.1f} KB")
    print(f"   • Lightweight size: {lite_kb:,.1f} KB")
    print(f"   • Reduction:        {results['total_reduction_pct']}% ({saved_kb:,.1f} KB saved)")
    print(f"   • Est. tokens saved: ~{results.get('est_tokens_saved', 0):,}")
    print(f"   • Compared across:  {results.get('entities_scanned', 0)} companies")

    if results.get("corpus_too_small"):
        print("\n   ⚠️  Fewer than two companies to compare — page scaffolding only.")

    verification = results.get("verification")
    if args.mode == "safe" and verification and not verification.get("available"):
        print("\n   ⚠️  The classifier could not be reached, and verified mode removes")
        print("       a section only on an explicit verdict. No prose was removed.")

    if args.mode == "dry-run":
        print(f"\n   ⚠️  Dry run — no files were written.")

    # Generate and save report.
    if args.report:
        report = BoilerplateDetector.generate_report(results)
        report_path = BoilerplateDetector.save_report(report_root, report)
        print(f"   • Report saved:     {report_path}")

    print(f"\n✨ Done!\n")


def run_serve(args):
    """Launch FastAPI Web Server."""
    import uvicorn
    print(f"Starting GooseQuill Web Server on http://{args.host}:{args.port} ...")
    uvicorn.run("app:app", host=args.host, port=args.port, reload=args.reload)


def _plan_or_latest(planner, plan_id):
    """Resolve --plan, defaulting to the most recent plan on disk."""
    resolved = plan_id or planner.latest_plan_id()
    if not resolved:
        print("No batch plans yet. Create one with:  goosequill batch plan <folder>")
        return None
    return resolved


def _print_plan_table(planner, plan):
    from goosequill.services.batch_planner import COLLECTED, COMPLETE, FAILED, SUBMITTED

    glyph = {SUBMITTED: "→", COLLECTED: "✓", COMPLETE: "·", FAILED: "✗"}

    # Sent, back, short. A state alone does not say whether the pages arrived:
    # a group can be collected and still be missing a dozen pages the model
    # would not transcribe.
    annotated = planner.annotate(plan)
    print(f"\n{'group':46} {'sent':>6} {'back':>6} {'short':>6}  state")
    print("-" * 88)
    for group in annotated["groups"]:
        mark = glyph.get(group["state"], " ")
        short = f"{group['missing']:6,}" if group["missing"] else f"{'-':>6}"
        line = (f"{group['name'][:46]:46} {group['pages']:6,} {group['converted']:6,} "
                f"{short}  {mark} {group['state']}")
        if group.get("job_id"):
            line += f"  [{group['job_id']}]"
        print(line)
        if group.get("error"):
            print(f"{'':46}        {group['error']}")

    s = planner.summarise(plan)
    print("-" * 88)
    print(f"{s['groups']} groups, {s['total_pages']:,} pages, model {s['model']}")
    print(f"{s['converted_pages']:,} of {s['total_pages']:,} pages transcribed"
          + (f", {s['missing_pages']:,} still missing" if s["missing_pages"] else "")
          + f"   ({s['done_pages']:,} pages in finished groups, {s['percent']}%)")
    print(f"enqueued {s['enqueued_tokens']:,} / {s['max_enqueued_tokens']:,} tokens")
    print(f"estimated batch cost: ${s['estimated_batch_cost_usd']:.2f}")
    if s["counts"].get(FAILED):
        print(f"\n{s['counts'][FAILED]} group(s) failed — `batch run --retry-failed` puts them back.")


def run_batch(args):
    """Plan, submit and collect a corpus-sized batch conversion."""
    from goosequill.services.batch_planner import BatchPlanner

    planner = BatchPlanner()

    if args.batch_command == "plan":
        root = Path(args.root).expanduser()
        files = None
        if args.files_from:
            files = json.loads(Path(args.files_from).read_text())
            print(f"Planning {len(files)} named document(s) ...")
        else:
            print(f"Reading {root} ...")
        plan = planner.create_plan(
            root=root,
            model=args.model,
            preset=args.preset,
            max_enqueued_tokens=args.max_enqueued_tokens,
            skip_cached=not args.force,
            files=files,
        )
        _print_plan_table(planner, plan)
        print(f"\nPlan saved as {plan['id']}. Nothing has been submitted yet.")
        print(f"Start it with:  goosequill batch run --plan {plan['id']} --watch")
        return

    if args.batch_command == "list":
        plans = planner.list_plans()
        if not plans:
            print("No batch plans yet.")
            return
        for plan in plans:
            s = planner.summarise(plan)
            state = "finished" if s["is_finished"] else "in progress"
            print(f"{s['id']}  {s['groups']:3} groups  {s['total_pages']:7,} pages  "
                  f"{s['percent']:5.1f}%  {state}  {s['model']}")
        return

    plan_id = _plan_or_latest(planner, args.plan)
    if not plan_id:
        return

    if args.batch_command == "status":
        _print_plan_table(planner, planner.load_plan(plan_id))
        return

    # run
    def on_event(kind, data):
        group = data.get("group", {})
        if kind == "submitting":
            print(f"  submitting {group['name']} ({group['pages']:,} pages) ...", flush=True)
        elif kind == "submitted":
            print(f"  submitted  {group['name']} → {data['job']['id']} "
                  f"({data['job']['total_requests']:,} requests)")
        elif kind == "collected":
            print(f"  collected  {group['name']} → {data['result']['assembled_files_count']} file(s)")
        elif kind == "complete":
            print(f"  already converted: {group['name']} — nothing to submit")
        elif kind == "retrying":
            reasons = {b["reason"] for b in data.get("blocked", [])}
            print(f"  retrying   {group['name']}: {len(data.get('blocked', []))} page(s) "
                  f"refused ({', '.join(sorted(reasons))}) — pass {group['retry_pass']} with a reworded prompt")
        elif kind == "recovered":
            print(f"  recovered  {group['name']}: the local record for {data['job']['id']} was "
                  f"missing and has been rebuilt from Google ({data['job']['status']})")
        elif kind == "failed":
            print(f"  FAILED     {group['name']}: {group.get('error')}")

    if args.retry_blocked:
        reopened = planner.reopen_blocked(plan_id)
        print(f"Reopened {reopened} group(s) with refused pages." if reopened
              else "No collected group has refused pages outstanding.")

    if args.retry_failed:
        reopened = planner.reopen_failed(plan_id)
        print(f"Reopened {reopened} failed group(s); cached pages will be skipped." if reopened
              else "No group has failed.")

    while True:
        plan = planner.advance(plan_id, on_event=on_event,
                               only=args.only, max_new=args.max_groups)
        summary = planner.summarise(plan)
        print(f"[{time.strftime('%H:%M:%S')}] {summary['done_pages']:,}/{summary['total_pages']:,} pages "
              f"({summary['percent']}%), {summary['enqueued_tokens']:,} tokens enqueued", flush=True)

        if summary["is_finished"]:
            print("\nPlan finished.")
            _print_plan_table(planner, plan)
            return
        if not args.watch:
            print("\nOne pass done. Run again, or add --watch to keep going.")
            return
        time.sleep(args.interval)


def main():
    parser = argparse.ArgumentParser(
        prog="goosequill",
        description="GooseQuill: High-Fidelity PDF to Markdown Pipeline & Document Intelligence"
    )
    subparsers = parser.add_subparsers(dest="command", help="Available subcommands")

    # 1. Convert Subcommand
    convert_parser = subparsers.add_parser("convert", help="Convert PDF documents to Markdown via Gemini OCR")
    convert_parser.add_argument("--folders", nargs="+", default=None, help="Directories containing PDFs to convert")
    convert_parser.add_argument("--file", type=str, default=None, help="Convert a single PDF file")
    convert_parser.add_argument(
        "--model",
        default=PricingRegistry.DEFAULT_MODEL,
        choices=list(PricingRegistry.MODELS.keys()),
        help=f"Gemini model to use (default: {PricingRegistry.DEFAULT_MODEL})"
    )
    convert_parser.add_argument("--force", action="store_true", help="Force re-process cached pages")
    convert_parser.add_argument("--limit-pages", type=int, default=None, help="Limit number of pages per PDF")
    convert_parser.add_argument("--concurrency", type=int, default=5, help="Parallel OCR concurrency (1 to 10)")

    # 2. Combine Subcommand
    combine_parser = subparsers.add_parser("combine", help="Combine multiple converted markdowns into a single consolidated file")
    combine_parser.add_argument("--folder", type=str, default=None, help="Directory containing markdowns to combine")
    combine_parser.add_argument("--files", nargs="+", default=None, help="Specific markdown or PDF files to combine")
    combine_parser.add_argument("--all", action="store_true", help="Combine all converted markdowns in workspace")
    combine_parser.add_argument("--output", "-o", type=str, default=None, help="Destination output path")
    combine_parser.add_argument(
        "--include-consolidated",
        action="store_true",
        help="Also combine previously consolidated files (off by default: they already contain their sources)"
    )
    combine_parser.add_argument("--title", type=str, default=None, help="Master document title")
    combine_parser.add_argument(
        "--sort",
        choices=["chrono-asc", "chrono-desc", "alpha-asc", "alpha-desc", "custom"],
        default="chrono-asc",
        help="Sorting method (default: chrono-asc)"
    )
    combine_parser.add_argument("--no-toc", action="store_true", help="Disable Table of Contents")
    combine_parser.add_argument("--no-clean-headers", action="store_true", help="Do not strip duplicate single-doc headers")
    combine_parser.add_argument("--no-source-meta", action="store_true", help="Omit source metadata callouts")

    # 3. Deflate Subcommand
    deflate_parser = subparsers.add_parser(
        "deflate",
        help="Remove boilerplate text from converted markdowns, producing lightweight copies"
    )
    deflate_parser.add_argument("--folder", type=str, default=None, help="Directory containing markdowns to deflate")
    deflate_parser.add_argument("--files", nargs="+", default=None, help="Specific markdown or PDF files to deflate")
    deflate_parser.add_argument("--all", action="store_true", help="Deflate all converted markdowns in workspace")
    deflate_parser.add_argument(
        "--mode",
        choices=["safe", "algorithmic", "dry-run"],
        default="algorithmic",
        help="safe = algorithmic + LLM verify, algorithmic = no LLM, dry-run = report only (default: algorithmic)"
    )
    deflate_parser.add_argument("--threshold", type=int, default=3, help="Min separate COMPANIES a section must appear at to be flagged (default: 3)")
    deflate_parser.add_argument("--peer-threshold", type=int, default=2, help="Min companies within one format family, as an alternative route to flagging (default: 2)")
    deflate_parser.add_argument("--compare-against", type=str, default="workspace", choices=["workspace", "selection"], help="Corpus repetition is judged against (default: workspace)")
    deflate_parser.add_argument("--similarity", type=float, default=0.85, help="Jaccard similarity threshold for fuzzy matching (default: 0.85)")
    deflate_parser.add_argument(
        "--model",
        default="gemini-2.5-flash-lite",
        choices=list(PricingRegistry.MODELS.keys()),
        help="Gemini model for LLM verification in safe mode (default: gemini-2.5-flash-lite)"
    )
    deflate_parser.add_argument("--report", action="store_true", default=True, help="Generate detailed markdown report (default: on)")
    deflate_parser.add_argument("--no-report", action="store_false", dest="report", help="Disable report generation")
    deflate_parser.add_argument("--output-dir", type=str, default=LIGHTWEIGHT_DIR_NAME, help=f"Output folder name (default: {LIGHTWEIGHT_DIR_NAME})")

    # 4. Batch Subcommand
    batch_parser = subparsers.add_parser(
        "batch",
        help="Convert a whole corpus through the Gemini Batch API (50%% cheaper, resumable)"
    )
    batch_sub = batch_parser.add_subparsers(dest="batch_command", help="Batch actions")

    batch_plan = batch_sub.add_parser("plan", help="Group a corpus into batch jobs, without submitting")
    batch_plan.add_argument("root", type=str, nargs="?", default=".",
                            help="Folder of company sub-folders to convert")
    batch_plan.add_argument("--files-from", type=str, default=None,
                            help="JSON list of specific PDFs to plan, instead of a whole root")
    batch_plan.add_argument(
        "--model",
        default=PricingRegistry.DEFAULT_MODEL,
        choices=list(PricingRegistry.MODELS.keys()),
        help=f"Gemini model to use (default: {PricingRegistry.DEFAULT_MODEL})"
    )
    batch_plan.add_argument("--preset", default="financial", choices=list(PROMPT_PRESETS.keys()),
                            help="Prompt preset (default: financial)")
    batch_plan.add_argument(
        "--max-enqueued-tokens", type=int, default=DEFAULT_MAX_ENQUEUED_TOKENS,
        help=f"Ceiling on tokens enqueued at once. Tier 1 allows 10,000,000; "
             f"the default of {DEFAULT_MAX_ENQUEUED_TOKENS:,} leaves headroom"
    )
    batch_plan.add_argument("--force", action="store_true",
                            help="Reconvert pages this model has already done")

    batch_run = batch_sub.add_parser("run", help="Submit and collect, resuming where it left off")
    batch_run.add_argument("--plan", type=str, default=None, help="Plan ID (default: the most recent)")
    batch_run.add_argument("--watch", action="store_true", help="Keep going until the plan is finished")
    batch_run.add_argument("--interval", type=int, default=300,
                           help="Seconds between passes when watching (default: 300)")
    batch_run.add_argument("--only", type=str, default=None,
                           help="Submit only groups whose name contains this text")
    batch_run.add_argument("--max-groups", type=int, default=None,
                           help="Submit at most this many new groups per pass")
    batch_run.add_argument("--retry-blocked", action="store_true",
                           help="Reopen collected groups that still have pages the "
                                "recitation filter refused, and ask again in different words")
    batch_run.add_argument("--retry-failed", action="store_true",
                           help="Put failed groups back in the queue. Pages already "
                                "converted are skipped, so only what is missing is resent")

    batch_status = batch_sub.add_parser("status", help="Show a plan's progress")
    batch_status.add_argument("--plan", type=str, default=None, help="Plan ID (default: the most recent)")

    batch_sub.add_parser("list", help="List saved plans")

    # 5. Serve Subcommand
    serve_parser = subparsers.add_parser("serve", help="Start the FastAPI web server")
    serve_parser.add_argument("--host", default="0.0.0.0", help="Host interface to bind (default: 0.0.0.0)")
    serve_parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    serve_parser.add_argument("--reload", action="store_true", help="Enable auto-reload on code changes")

    args = parser.parse_args()

    if args.command == "convert":
        run_convert(args)
    elif args.command == "combine":
        run_combine(args)
    elif args.command == "deflate":
        run_deflate(args)
    elif args.command == "batch":
        if not args.batch_command:
            batch_parser.print_help()
        else:
            run_batch(args)
    elif args.command == "serve":
        run_serve(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
