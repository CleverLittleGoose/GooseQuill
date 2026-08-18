import os
import json
import time
import base64
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Callable
from dotenv import load_dotenv
from google import genai
from google.genai import types

from ..models.job import BatchJobRecord
from .pdf_renderer import PDFRenderer
from .cache_manager import CacheManager
from .markdown_assembler import MarkdownAssembler

logger = logging.getLogger(__name__)

class BatchService:
    """Encapsulates Gemini File API and Batch API submission, status tracking, and result aggregation."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        cache_manager: Optional[CacheManager] = None,
        pdf_renderer: Optional[PDFRenderer] = None,
        markdown_assembler: Optional[MarkdownAssembler] = None
    ):
        load_dotenv()
        self.api_key = api_key or os.environ.get("PDF_MARKDOWN_KEY") or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not self.api_key:
            raise ValueError("No Gemini API key found.")

        self.client = genai.Client(api_key=self.api_key)
        self.cache_manager = cache_manager or CacheManager()
        self.pdf_renderer = pdf_renderer or PDFRenderer()
        self.markdown_assembler = markdown_assembler or MarkdownAssembler()

        self.batch_dir = self.cache_manager.cache_dir / "batches"
        self.batch_dir.mkdir(parents=True, exist_ok=True)
        self.metadata_file = self.cache_manager.cache_dir / "batch_jobs.json"
        
        # 30-second memory cache to prevent spamming Google Gemini API
        self._cached_jobs: Optional[List[Dict[str, Any]]] = None
        self._last_poll_time: float = 0.0

    def _load_jobs(self) -> List[Dict[str, Any]]:
        if not self.metadata_file.exists():
            return []
        try:
            with open(self.metadata_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

    def _save_jobs(self, jobs: List[Dict[str, Any]]):
        with open(self.metadata_file, "w", encoding="utf-8") as f:
            json.dump(jobs, f, indent=2)
        self._cached_jobs = jobs

    def create_batch_job(
        self,
        pdf_paths: List[str],
        model_name: str = "gemini-3.1-flash-lite",
        system_prompt: str = "",
        display_name: Optional[str] = None,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
    ) -> Dict[str, Any]:
        """Prepare JSONL for all pages across all selected PDFs and submit Batch API job with live progress."""
        timestamp_str = time.strftime("%Y%m%d_%H%M%S")
        job_id = f"batch_{timestamp_str}"
        disp_name = display_name or f"PDF_Markdown_Batch_{timestamp_str}"

        jsonl_path = self.batch_dir / f"{job_id}.jsonl"
        mapping_path = self.batch_dir / f"{job_id}_mapping.json"

        # Count total pages for accurate progress bar calculation
        valid_paths = [Path(p) for p in pdf_paths if Path(p).exists()]
        total_pages_all = sum(self.pdf_renderer.get_page_count(p) for p in valid_paths)
        if total_pages_all == 0:
            total_pages_all = 1

        key_mapping: Dict[str, Dict[str, Any]] = {}
        total_requests = 0
        current_rendered_page = 0

        logger.info(f"Generating Batch JSONL for {len(valid_paths)} documents ({total_pages_all} total pages)...")

        with open(jsonl_path, "w", encoding="utf-8") as jsonl_file:
            for doc_idx, p in enumerate(valid_paths):
                total_pages = self.pdf_renderer.get_page_count(p)

                for page_idx in range(total_pages):
                    page_num = page_idx + 1
                    current_rendered_page += 1
                    req_key = f"doc{doc_idx:03d}_p{page_num:03d}"

                    key_mapping[req_key] = {
                        "pdf_path": str(p),
                        "doc_name": p.name,
                        "folder": p.parent.name,
                        "page_num": page_num,
                        "total_pages": total_pages,
                        "stem": p.stem
                    }

                    # Render page image
                    img_bytes = self.pdf_renderer.render_page_from_path(p, page_num, dpi=200)
                    b64_data = base64.b64encode(img_bytes).decode("utf-8")

                    request_obj = {
                        "key": req_key,
                        "request": {
                            "contents": [
                                {
                                    "parts": [
                                        {
                                            "inline_data": {
                                                "mime_type": "image/png",
                                                "data": b64_data
                                            }
                                        },
                                        {
                                            "text": system_prompt
                                        }
                                    ]
                                }
                            ]
                        }
                    }

                    jsonl_file.write(json.dumps(request_obj) + "\n")
                    total_requests += 1

                    if progress_callback:
                        progress_callback({
                            "phase": "rendering",
                            "doc_name": p.name,
                            "current_page": current_rendered_page,
                            "total_pages": total_pages_all,
                            "percent": round((current_rendered_page / total_pages_all) * 75, 1),
                            "status": f"Rendering {p.name} — Page {page_num}/{total_pages} (200 DPI PNG)..."
                        })

        with open(mapping_path, "w", encoding="utf-8") as f:
            json.dump(key_mapping, f, indent=2)

        if progress_callback:
            progress_callback({
                "phase": "uploading",
                "current_page": total_pages_all,
                "total_pages": total_pages_all,
                "percent": 82.0,
                "status": f"Uploading {total_requests} pages to Gemini File API..."
            })

        logger.info(f"Uploading {total_requests} requests to Gemini File API...")
        uploaded_file = self.client.files.upload(
            file=str(jsonl_path),
            config=types.UploadFileConfig(
                display_name=disp_name,
                mime_type="jsonl"
            )
        )

        if progress_callback:
            progress_callback({
                "phase": "submitting",
                "current_page": total_pages_all,
                "total_pages": total_pages_all,
                "percent": 94.0,
                "status": f"Submitting Batch API Job to Gemini ({model_name})..."
            })

        logger.info(f"Submitting Batch API job with model: {model_name}...")
        batch_job = self.client.batches.create(
            model=model_name,
            src=uploaded_file.name,
            config={
                "display_name": disp_name
            }
        )

        job_info = {
            "id": job_id,
            "gemini_job_name": batch_job.name,
            "display_name": disp_name,
            "model": model_name,
            "uploaded_file": uploaded_file.name,
            "total_documents": len(pdf_paths),
            "total_requests": total_requests,
            "submitted_at": time.time(),
            "status": "JOB_STATE_PENDING",
            "is_completed": False,
            "pdf_paths": pdf_paths,
            "mapping_file": str(mapping_path)
        }

        jobs = self._load_jobs()
        jobs.insert(0, job_info)
        self._save_jobs(jobs)

        if progress_callback:
            progress_callback({
                "phase": "completed",
                "current_page": total_pages_all,
                "total_pages": total_pages_all,
                "percent": 100.0,
                "status": f"Batch job '{job_id}' submitted successfully!"
            })

        return job_info

    def list_jobs(self, force_refresh: bool = False) -> List[Dict[str, Any]]:
        """List and refresh status of all batch jobs with a 30s cache to avoid excessive API requests."""
        now = time.time()
        if not force_refresh and self._cached_jobs is not None and (now - self._last_poll_time < 30.0):
            return self._cached_jobs

        jobs = self._load_jobs()
        updated = False

        for job in jobs:
            if not job.get("is_completed"):
                try:
                    remote_job = self.client.batches.get(name=job["gemini_job_name"])
                    state_name = remote_job.state.name if hasattr(remote_job.state, "name") else str(remote_job.state)
                    job["status"] = state_name
                    if hasattr(remote_job, "dest") and remote_job.dest:
                        job["dest_file_name"] = getattr(remote_job.dest, "file_name", None)
                    if hasattr(remote_job, "error") and remote_job.error:
                        job["error"] = str(remote_job.error)

                    if state_name in ("JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"):
                        job["is_completed"] = True
                        if state_name == "JOB_STATE_SUCCEEDED":
                            job["completed_at"] = time.time()
                    updated = True
                except Exception as e:
                    logger.warning(f"Error checking job {job.get('gemini_job_name')}: {e}")

        if updated:
            self._save_jobs(jobs)
        else:
            self._cached_jobs = jobs

        self._last_poll_time = now
        return jobs

    def collect_job_results(self, job_id: str) -> Dict[str, Any]:
        """Download batch results and assemble final Markdown files."""
        jobs = self._load_jobs()
        target_job = next((j for j in jobs if j["id"] == job_id), None)
        if not target_job:
            raise ValueError(f"Job {job_id} not found.")

        remote_job = self.client.batches.get(name=target_job["gemini_job_name"])
        state_name = remote_job.state.name if hasattr(remote_job.state, "name") else str(remote_job.state)

        if state_name != "JOB_STATE_SUCCEEDED":
            return {"status": "not_ready", "state": state_name, "message": f"Job is in state: {state_name}"}

        dest_file_name = None
        if hasattr(remote_job, "dest") and remote_job.dest:
            dest_file_name = getattr(remote_job.dest, "file_name", None)

        if not dest_file_name:
            raise ValueError("No destination file name found in completed batch job.")

        logger.info(f"Downloading batch results from {dest_file_name}...")
        file_bytes = self.client.files.download(file=dest_file_name)
        result_text = file_bytes.decode("utf-8")

        mapping_path = Path(target_job["mapping_file"])
        with open(mapping_path, "r", encoding="utf-8") as f:
            mapping = json.load(f)

        doc_pages: Dict[str, Dict[int, str]] = {}
        doc_meta: Dict[str, Dict[str, Any]] = {}

        for line in result_text.splitlines():
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                req_key = record.get("key")
                if not req_key or req_key not in mapping:
                    continue

                info = mapping[req_key]
                pdf_path = info["pdf_path"]
                page_num = info["page_num"]

                if pdf_path not in doc_pages:
                    doc_pages[pdf_path] = {}
                    doc_meta[pdf_path] = info

                text_content = ""
                resp = record.get("response")
                if resp and "candidates" in resp and len(resp["candidates"]) > 0:
                    candidate = resp["candidates"][0]
                    parts = candidate.get("content", {}).get("parts", [])
                    for part in parts:
                        if "text" in part:
                            text_content += part["text"]

                doc_pages[pdf_path][page_num] = text_content.strip()
                self.cache_manager.write_page_cache(Path(pdf_path), page_num, text_content.strip())
            except Exception as e:
                logger.error(f"Error parsing batch result line: {e}")

        # Assemble full Markdown files
        assembled_files = []
        for pdf_path_str, pages_dict in doc_pages.items():
            p = Path(pdf_path_str)
            out_dir = p.parent / "Markdown"
            out_dir.mkdir(parents=True, exist_ok=True)
            final_md_path = out_dir / f"{p.stem}.md"

            total_pages = doc_meta[pdf_path_str]["total_pages"]
            model_used = target_job.get("model", "gemini-3.1-flash-lite")

            ordered_pages = [pages_dict.get(pn, f"> **[Page {pn} conversion missing]**") for pn in range(1, total_pages + 1)]
            full_content = self.markdown_assembler.assemble_document(
                stem=p.stem,
                source_name=p.name,
                model_name=f"Gemini Batch API ({model_used})",
                total_pages=total_pages,
                page_results=ordered_pages
            )

            self.markdown_assembler.save_document(final_md_path, full_content)
            assembled_files.append(str(final_md_path))
            logger.info(f"Assembled Batch Result: {final_md_path}")

        target_job["is_collected"] = True
        target_job["assembled_files"] = assembled_files
        self._save_jobs(jobs)

        return {
            "status": "success",
            "job_id": job_id,
            "assembled_files_count": len(assembled_files),
            "files": assembled_files
        }
