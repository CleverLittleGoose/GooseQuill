import logging
from pathlib import Path
from typing import Optional, Callable, Dict, Any, List
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..models.document import DEFAULT_SYSTEM_PROMPT, PRESET_PROMPT_ID, DocumentInfo
from ..models.job import JobProgress
from .pdf_renderer import PDFRenderer
from .cache_manager import CacheManager
from .ocr_client import GeminiOCRClient
from .markdown_assembler import MarkdownAssembler

logger = logging.getLogger(__name__)

class ConversionEngine:
    """Orchestrates parallel multi-threaded PDF OCR document conversion."""

    def __init__(
        self,
        ocr_client: Optional[GeminiOCRClient] = None,
        cache_manager: Optional[CacheManager] = None,
        pdf_renderer: Optional[PDFRenderer] = None,
        markdown_assembler: Optional[MarkdownAssembler] = None,
        model_name: str = "gemini-3.1-flash-lite",
        system_prompt: Optional[str] = None,
        concurrency: int = 5
    ):
        self.cache_manager = cache_manager or CacheManager()
        self.pdf_renderer = pdf_renderer or PDFRenderer()
        self.markdown_assembler = markdown_assembler or MarkdownAssembler()
        self.ocr_client = ocr_client or GeminiOCRClient(
            model_name=model_name,
            system_prompt=system_prompt
        )
        self.concurrency = max(1, min(concurrency, 10))
        self._cancel_requested = False

    @property
    def model_name(self) -> str:
        return self.ocr_client.model_name

    def cancel(self):
        """Signal all active worker threads to halt immediately."""
        self._cancel_requested = True
        self.cache_manager.write_job_status({"is_running": False, "status": "cancelled"})

    def reset_cancel(self):
        """Reset the cancellation token for a new conversion run."""
        self._cancel_requested = False

    def is_cancelled(self) -> bool:
        return self._cancel_requested

    def _process_single_page(
        self,
        pdf_path: Path,
        page_idx: int,
        total_pages: int,
        img_bytes: bytes,
        force_reprocess: bool,
        status_cb: Optional[Callable[[str], None]]
    ) -> tuple[int, str]:
        if self._cancel_requested:
            raise InterruptedError("Cancelled")

        page_num = page_idx + 1

        if not force_reprocess and self.cache_manager.is_page_cached(pdf_path, page_num, self.model_name):
            cached_text = self.cache_manager.read_page_cache(pdf_path, page_num, self.model_name)
            if cached_text is not None:
                logger.info(f"[{pdf_path.name}] Page {page_num}/{total_pages} loaded from cache")
                return page_idx, cached_text

        logger.info(f"[{pdf_path.name}] OCRing Page {page_num}/{total_pages} via {self.model_name}...")
        prompt_used = PRESET_PROMPT_ID

        def note_prompt(prompt_id: str) -> None:
            nonlocal prompt_used
            prompt_used = prompt_id

        try:
            page_text = self.ocr_client.ocr_page_image(
                img_bytes=img_bytes,
                status_callback=status_cb,
                cancel_check=self.is_cancelled,
                prompt_callback=note_prompt
            )
        except Exception as page_err:
            logger.error(f"Error on Page {page_num} of {pdf_path.name}: {page_err}")
            # Deliberately not cached. This note used to be written to the page
            # file, where it counted as a conversion — the page was the right
            # size, so every later run skipped it and the hole never healed.
            # Leaving it uncached is what lets a retry find the page again.
            return page_idx, f"> **[Note: Page {page_num} could not be converted: {page_err}]**"

        # Only recorded when it is not the ordinary preset: the stamp is there
        # to mark a page that needed special handling, so absence should mean
        # an unremarkable conversion rather than an unanswered question.
        self.cache_manager.write_page_cache(
            pdf_path, page_num, page_text, self.model_name,
            prompt=None if prompt_used == PRESET_PROMPT_ID else prompt_used
        )
        return page_idx, page_text

    def convert_document(
        self,
        pdf_path: Path,
        output_dir: Optional[Path] = None,
        force_reprocess: bool = False,
        limit_pages: Optional[int] = None,
        concurrency: Optional[int] = None,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
    ) -> Path:
        """Convert an entire PDF into a multi-page Markdown document with parallel page workers."""
        self.reset_cancel()
        p = Path(pdf_path)
        if not p.exists():
            raise FileNotFoundError(f"PDF file not found: {p}")

        workers = concurrency or self.concurrency
        total_pages = self.pdf_renderer.get_page_count(p)
        if limit_pages and limit_pages < total_pages:
            total_pages = limit_pages

        out_dir = Path(output_dir) if output_dir else (p.parent / "Markdown")
        out_dir.mkdir(parents=True, exist_ok=True)
        final_md_path = out_dir / f"{p.stem}.md"

        logger.info(f"Pre-rendering {total_pages} page images for {p.name}...")
        page_images = self.pdf_renderer.render_all_pages(p, dpi=200, limit=total_pages)

        page_results: List[Optional[str]] = [None] * total_pages
        completed_count = 0

        def make_status_cb(page_num: int):
            def status_cb(msg: str):
                if progress_callback:
                    progress_callback({
                        "file_name": p.name,
                        "file_path": str(p),
                        "current_page": completed_count,
                        "total_pages": total_pages,
                        "percent": round((completed_count / total_pages) * 100, 1) if total_pages else 0.0,
                        "status": "warning",
                        "warning_message": msg
                    })
            return status_cb

        logger.info(f"Converting {p.name} with concurrency={workers}...")

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(
                    self._process_single_page,
                    p,
                    idx,
                    total_pages,
                    page_images[idx],
                    force_reprocess,
                    make_status_cb(idx + 1)
                ): idx
                for idx in range(total_pages)
            }

            for future in as_completed(futures):
                if self._cancel_requested:
                    executor.shutdown(wait=False, cancel_futures=True)
                    break
                try:
                    page_idx, page_text = future.result()
                    page_results[page_idx] = page_text
                    completed_count += 1

                    progress_data = {
                        "is_running": True,
                        "current_file": p.name,
                        "current_folder": p.parent.name,
                        "current_page": completed_count,
                        "total_pages": total_pages,
                        "percent": round((completed_count / total_pages) * 100, 1),
                        "status": "processing" if completed_count < total_pages else "completed",
                        "warning_message": None
                    }
                    self.cache_manager.write_job_status(progress_data)

                    if progress_callback:
                        progress_callback(progress_data)
                except Exception as exc:
                    logger.error(f"Page execution generated an exception: {exc}")

        if self._cancel_requested:
            self.cache_manager.write_job_status({"is_running": False, "status": "cancelled"})
            return final_md_path

        full_md_content = self.markdown_assembler.assemble_document(
            stem=p.stem,
            source_name=p.name,
            model_name=self.model_name,
            total_pages=total_pages,
            page_results=page_results
        )

        self.markdown_assembler.save_document(final_md_path, full_md_content)
        logger.info(f"Completed {p.name} -> {final_md_path}")

        self.cache_manager.write_job_status({
            "is_running": False,
            "current_file": p.name,
            "status": "completed",
            "percent": 100.0
        })

        return final_md_path
