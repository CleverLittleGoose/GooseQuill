#!/usr/bin/env python3
"""
GooseQuill Unified Command-Line Interface (CLI).
Provides unified subcommands for document conversion, markdown consolidation, and server management.

Usage:
  python cli.py convert [--folders ...] [--model ...] [--file ...]
  python cli.py combine [--folder ...] [--files ...] [--output ...]
  python cli.py serve [--host 0.0.0.0] [--port 8000]
"""

import sys
import argparse
from pathlib import Path
from typing import List

PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.models import PricingRegistry
from goosequill.services import (
    ConversionEngine,
    PDFRenderer,
    DocumentRepository,
    MarkdownCombinerService
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
        files_to_combine = [Path(m["path"]) for m in md_infos]
    else:
        # Default / --all
        md_infos = doc_repo.get_converted_markdowns(DEFAULT_ACCOUNTS_DIR)
        files_to_combine = [Path(m["path"]) for m in md_infos]

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
                output_path_str = str(folder_p / f"{folder_p.name}_Consolidated.md")
            else:
                output_path_str = str(DEFAULT_ACCOUNTS_DIR / "Consolidated_Master_Accounts.md")

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


def run_serve(args):
    """Launch FastAPI Web Server."""
    import uvicorn
    print(f"Starting GooseQuill Web Server on http://{args.host}:{args.port} ...")
    uvicorn.run("app:app", host=args.host, port=args.port, reload=args.reload)


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

    # 3. Serve Subcommand
    serve_parser = subparsers.add_parser("serve", help="Start the FastAPI web server")
    serve_parser.add_argument("--host", default="0.0.0.0", help="Host interface to bind (default: 0.0.0.0)")
    serve_parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    serve_parser.add_argument("--reload", action="store_true", help="Enable auto-reload on code changes")

    args = parser.parse_args()

    if args.command == "convert":
        run_convert(args)
    elif args.command == "combine":
        run_combine(args)
    elif args.command == "serve":
        run_serve(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
