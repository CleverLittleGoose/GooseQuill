import logging
from pathlib import Path
from typing import List, Dict, Any, Optional
from ..models.document import DocumentInfo, FolderInfo, PROMPT_PRESETS, DEFAULT_SYSTEM_PROMPT
from ..models.pricing import CostEstimate, PricingRegistry
from .pdf_renderer import PDFRenderer
from .cache_manager import CacheManager
from .cost_calculator import CostCalculator

logger = logging.getLogger(__name__)

class DocumentRepository:
    """Discovers, indexes, and queries accounts folders and PDF documents."""

    def __init__(self, cache_manager: Optional[CacheManager] = None):
        self.cache_manager = cache_manager or CacheManager()

    def _get_active_batch_map(self) -> Dict[str, Dict[str, Any]]:
        """Read .cache/batch_jobs.json to index active and running batch jobs by PDF path."""
        metadata_file = self.cache_manager.cache_dir / "batch_jobs.json"
        if not metadata_file.exists():
            return {}
        try:
            import json
            with open(metadata_file, "r", encoding="utf-8") as f:
                jobs = json.load(f)
            
            active_map: Dict[str, Dict[str, Any]] = {}
            for job in jobs:
                status = job.get("status", "")
                is_completed = job.get("is_completed", False)
                if status in ("JOB_STATE_PENDING", "JOB_STATE_RUNNING") and not is_completed:
                    for p in job.get("pdf_paths", []):
                        try:
                            resolved_p = str(Path(p).resolve())
                            active_map[resolved_p] = {
                                "status": status,
                                "job_id": job.get("id"),
                                "display_name": job.get("display_name")
                            }
                        except Exception:
                            pass
            return active_map
        except Exception as e:
            logger.warning(f"Could not load active batch mappings: {e}")
            return {}

    def get_document_info(
        self,
        pdf_path: Path,
        model_name: str = "gemini-3.1-flash-lite",
        active_batch_map: Optional[Dict[str, Dict[str, Any]]] = None
    ) -> DocumentInfo:
        """Inspect a single PDF file and compute page counts, cache status, and token cost estimate."""
        p = Path(pdf_path)
        if not p.exists():
            return DocumentInfo(
                name=p.name,
                stem=p.stem,
                path=str(p),
                folder=p.parent.name,
                file_size=0,
                error="File does not exist"
            )

        try:
            total_pages = PDFRenderer.get_page_count(p)
            cached_pages = self.cache_manager.count_cached_pages(p, total_pages)

            out_dir = p.parent / "Markdown"
            out_file = out_dir / f"{p.stem}.md"
            converted = out_file.exists()
            out_size = out_file.stat().st_size if converted else 0

            cost_estimate = CostCalculator.calculate_cost_for_pages(model_name, total_pages)

            batch_info = (active_batch_map or {}).get(str(p.resolve()))
            batch_status = batch_info.get("status") if batch_info else None
            batch_job_id = batch_info.get("job_id") if batch_info else None

            return DocumentInfo(
                name=p.name,
                stem=p.stem,
                path=str(p),
                folder=p.parent.name,
                file_size=p.stat().st_size,
                total_pages=total_pages,
                cached_pages=cached_pages,
                is_converted=converted,
                output_path=str(out_file) if converted else None,
                output_size=out_size,
                cost_estimate=cost_estimate,
                batch_status=batch_status,
                batch_job_id=batch_job_id
            )
        except Exception as e:
            logger.warning(f"Error reading document info for {p}: {e}")
            return DocumentInfo(
                name=p.name,
                stem=p.stem,
                path=str(p),
                folder=p.parent.name,
                file_size=p.stat().st_size if p.exists() else 0,
                error=str(e)
            )

    def scan_directory(self, root_dir: Path, model_name: str = "gemini-3.1-flash-lite") -> Dict[str, Any]:
        """Scan a root directory for all subfolders and PDF files, computing aggregate stats."""
        root = Path(root_dir)
        root.mkdir(parents=True, exist_ok=True)

        active_batch_map = self._get_active_batch_map()
        folders: List[FolderInfo] = []
        all_page_counts: List[int] = []

        # 1. Check if root folder itself contains PDFs
        root_pdfs = sorted(root.glob("*.pdf"))
        if root_pdfs:
            root_docs = []
            for pdf_file in root_pdfs:
                doc_info = self.get_document_info(pdf_file, model_name, active_batch_map)
                root_docs.append(doc_info)
                if doc_info.total_pages:
                    all_page_counts.append(doc_info.total_pages)
            folders.append(FolderInfo(
                name="General / Root",
                path=str(root),
                documents=root_docs
            ))

        # 2. Discover all subdirectories
        for folder in sorted(root.iterdir()):
            if folder.is_dir() and not folder.name.startswith(".") and folder.name != "Markdown":
                pdf_list = []
                for pdf_file in sorted(folder.glob("*.pdf")):
                    doc_info = self.get_document_info(pdf_file, model_name, active_batch_map)
                    pdf_list.append(doc_info)
                    if doc_info.total_pages:
                        all_page_counts.append(doc_info.total_pages)

                folders.append(FolderInfo(
                    name=folder.name,
                    path=str(folder),
                    documents=pdf_list
                ))

        aggregate_costs = CostCalculator.calculate_aggregate_costs(all_page_counts, model_name)

        return {
            "root_directory": str(root),
            "folders": [f.to_dict() for f in folders],
            "presets": {k: v.to_dict() for k, v in PROMPT_PRESETS.items()},
            "default_prompt": DEFAULT_SYSTEM_PROMPT,
            "pricing": PricingRegistry.get_all_raw(),
            "stats": {
                "est_input_tokens": aggregate_costs.input_tokens,
                "est_output_tokens": aggregate_costs.output_tokens,
                "est_total_tokens": aggregate_costs.total_tokens,
                "est_total_cost_usd": aggregate_costs.cost_standard_usd,
                "est_cost_standard_usd": aggregate_costs.cost_standard_usd,
                "est_cost_batch_usd": aggregate_costs.cost_batch_usd
            }
        }

    def create_folder(self, root_dir: Path, folder_name: str) -> Path:
        """Create a new subdirectory inside the root directory."""
        clean_name = folder_name.strip()
        if not clean_name:
            raise ValueError("Folder name cannot be empty.")
        new_path = Path(root_dir) / clean_name
        new_path.mkdir(parents=True, exist_ok=True)
        return new_path

    def get_converted_markdowns(self, root_dir: Path) -> List[Dict[str, Any]]:
        """Discover all converted markdown files across all folders in a root directory."""
        root = Path(root_dir)
        results: List[Dict[str, Any]] = []
        if not root.exists():
            return results

        for item in sorted(root.rglob("*.md")):
            if item.name.endswith("_Index.md") or item.name.startswith("."):
                continue
            try:
                rel = item.relative_to(root)
                if rel.parent.name == "Markdown":
                    folder = str(rel.parent.parent) if str(rel.parent.parent) != "." else "General / Root"
                else:
                    folder = str(rel.parent) if str(rel.parent) != "." else "General / Root"
            except Exception:
                folder = item.parent.parent.name if item.parent.name == "Markdown" else item.parent.name

            results.append({
                "name": item.name,
                "stem": item.stem,
                "path": str(item),
                "folder": folder,
                "size": item.stat().st_size
            })
        return results

