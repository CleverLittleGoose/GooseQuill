import os
import json
import re
import time
import base64
import fcntl
import logging
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import List, Dict, Any, Optional, Callable
from dotenv import load_dotenv
from google import genai
from .genai_factory import build_client, resolve_api_key
from google.genai import types

from ..models.job import BatchJobRecord
from ..models.document import PRESET_PROMPT_ID
from ..models.pricing import PricingRegistry
from .pdf_renderer import PDFRenderer
from .cache_manager import CacheManager, atomic_write_text
from .markdown_assembler import MarkdownAssembler

logger = logging.getLogger(__name__)

class BatchService:
    """Encapsulates Gemini File API and Batch API submission, status tracking, and result aggregation.

    Batch jobs are Gemini Developer API only. The batch flow uploads a JSONL
    payload through the File API, and that API raises on Vertex AI, where batch
    input has to be staged in Cloud Storage instead. Rather than let an SDK
    error surface halfway through preparing a payload, every batch entry point
    checks the backend first — see _require_batch_support.
    """

    # The Gemini File API refuses an input file over 2 GB. Stop below that:
    # the estimate that gets us there is an average, and the cost of stopping a
    # little early is one extra job, while the cost of stopping late is a
    # rejected upload after every page has been rendered.
    MAX_BATCH_FILE_BYTES = 1_800_000_000
    # How far Google's creation time may sit before a job id's own timestamp and
    # still be the same submission. It should never be negative at all — the id
    # is minted first — but clocks drift, so allow a little.
    RECOVERY_CLOCK_SKEW = 120.0

    # Measured across a sample of 200 DPI scans of UK statutory accounts: PNG
    # pages averaged ~315 KB, which is ~420 KB once base64-encoded into JSONL.
    ESTIMATED_BYTES_PER_PAGE = 420_000

    TERMINAL_STATES = (
        "JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED",
        "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED",
    )

    BATCH_UNSUPPORTED_ON_VERTEX = (
        "Batch jobs are not available on Vertex AI. The batch flow uploads its "
        "payload through the Gemini File API, which Vertex does not offer — it "
        "stages batch input in Cloud Storage instead, which GooseQuill does not "
        "implement. Convert these documents normally instead (the cost is the "
        "standard rate rather than the 50% batch rate), or switch to a Gemini "
        "API key by removing GOOSEQUILL_USE_VERTEX from your .env. Note that "
        "the Gemini API is a global endpoint, so switching gives up the regional "
        "processing that Vertex is presumably why you chose it."
    )

    def __init__(
        self,
        api_key: Optional[str] = None,
        cache_manager: Optional[CacheManager] = None,
        pdf_renderer: Optional[PDFRenderer] = None,
        markdown_assembler: Optional[MarkdownAssembler] = None
    ):
        load_dotenv()
        self.client, self.backend = build_client(api_key)
        self.api_key = None if self.backend.vertex else resolve_api_key(api_key)
        self.cache_manager = cache_manager or CacheManager()
        self.pdf_renderer = pdf_renderer or PDFRenderer()
        self.markdown_assembler = markdown_assembler or MarkdownAssembler()

        self.batch_dir = self.cache_manager.cache_dir / "batches"
        self.batch_dir.mkdir(parents=True, exist_ok=True)
        self.metadata_file = self.cache_manager.cache_dir / "batch_jobs.json"
        
        # 30-second memory cache to prevent spamming Google Gemini API
        self._cached_jobs: Optional[List[Dict[str, Any]]] = None
        self._last_poll_time: float = 0.0

    # ------------------------------------------------------------------
    # Job metadata
    # ------------------------------------------------------------------
    #
    # A job record is the only route back to work already submitted. Lose the
    # gemini_job_name and the job keeps running, keeps costing money, and can
    # never be collected. Two processes write this file — the web app polling
    # for status and the CLI submitting the next folder — so every change is
    # made under a lock, against a fresh read of the disk, and committed by
    # atomic rename. Read-modify-write without those three is how a poll
    # silently drops a job that was submitted a moment earlier.

    @contextmanager
    def _job_store_lock(self, timeout: float = 10.0):
        """Serialise read-modify-write on the job store across processes."""
        lock_path = self.metadata_file.with_name(self.metadata_file.name + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(lock_path, "a+")
        deadline = time.time() + timeout
        try:
            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.time() >= deadline:
                        raise TimeoutError(
                            f"Could not lock the batch job store within {timeout:g}s "
                            f"({lock_path}). Another GooseQuill process may be stuck."
                        )
                    time.sleep(0.05)
            yield
        finally:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            handle.close()

    def _read_jobs_unlocked(self) -> List[Dict[str, Any]]:
        """Read the job store, preserving anything it cannot parse."""
        if not self.metadata_file.exists():
            return []
        try:
            with open(self.metadata_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError:
            # Returning [] here and letting the next save overwrite would turn a
            # damaged file into the permanent loss of every job record. Move it
            # aside instead, so a human can still read the job names out of it.
            quarantine = self.metadata_file.with_name(
                f"{self.metadata_file.name}.corrupt-{time.strftime('%Y%m%d_%H%M%S')}"
            )
            try:
                self.metadata_file.rename(quarantine)
            except OSError:
                pass
            logger.error(
                "Batch job store was unreadable and has been preserved at %s. "
                "Any jobs already submitted are still running at Google and can "
                "be recovered from that file.", quarantine
            )
            return []
        except OSError as e:
            # Never report "no jobs" because of a transient read failure — that
            # reads as "nothing is running" when 38 jobs may be in flight.
            raise RuntimeError(f"Could not read the batch job store: {e}") from e
        return data if isinstance(data, list) else []

    def _load_jobs(self) -> List[Dict[str, Any]]:
        with self._job_store_lock():
            return self._read_jobs_unlocked()

    def _update_jobs(self, mutate: Callable[[List[Dict[str, Any]]], None]) -> List[Dict[str, Any]]:
        """Apply a change under lock, against whatever is on disk right now."""
        with self._job_store_lock():
            jobs = self._read_jobs_unlocked()
            mutate(jobs)
            atomic_write_text(self.metadata_file, json.dumps(jobs, indent=2))
            self._cached_jobs = jobs
            return jobs

    def _too_large_message(self, pages: int, planned: int) -> str:
        limit_gb = self.MAX_BATCH_FILE_BYTES / 1e9
        return (
            f"This selection is too large for one batch job: {planned} pages "
            f"would exceed the {limit_gb:.1f} GB payload limit"
            + (f" (reached at page {pages})" if pages < planned else "")
            + ". Submit it as several smaller jobs — one per company folder is "
            "usually well within the limit — or use `goosequill batch submit`, "
            "which splits and queues them for you."
        )

    def _check_payload_size(self, planned_pages: int) -> None:
        """Refuse an oversized selection before anything is rendered."""
        estimated = planned_pages * self.ESTIMATED_BYTES_PER_PAGE
        if estimated > self.MAX_BATCH_FILE_BYTES:
            raise ValueError(self._too_large_message(planned_pages, planned_pages))

    def max_pages_per_job(self) -> int:
        """How many average pages fit in one job, for callers doing the splitting."""
        return int(self.MAX_BATCH_FILE_BYTES // self.ESTIMATED_BYTES_PER_PAGE)

    def _require_batch_support(self) -> None:
        """Refuse batch work on a backend that cannot do it, before any work."""
        if self.backend.vertex:
            raise ValueError(self.BATCH_UNSUPPORTED_ON_VERTEX)

    def create_batch_job(
        self,
        pdf_paths: List[str],
        model_name: str = PricingRegistry.DEFAULT_MODEL,
        system_prompt: str = "",
        display_name: Optional[str] = None,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        skip_cached: bool = True,
        prompt_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Render every page not already converted by this model, and submit it.

        Pages this model has already produced are left out of the payload.
        Batch used to resubmit them regardless, which on a corpus-sized run
        means paying a second time for work already sitting in the cache.
        Collection fills those pages back in from the cache, so the assembled
        document is complete either way. Pass ``skip_cached=False`` to force
        a genuine reconversion.
        """
        self._require_batch_support()
        timestamp_str = time.strftime("%Y%m%d_%H%M%S")
        job_id = f"batch_{timestamp_str}"
        disp_name = display_name or f"PDF_Markdown_Batch_{timestamp_str}"

        jsonl_path = self.batch_dir / f"{job_id}.jsonl"
        mapping_path = self.batch_dir / f"{job_id}_mapping.json"

        valid_paths = [Path(p) for p in pdf_paths if Path(p).exists()]

        # Work out what actually needs converting before rendering a single
        # page. Rendering first and discovering the payload is too large only
        # after gigabytes are on disk is the expensive way to learn it.
        plan: List[tuple] = []          # (doc_idx, path, page_num)
        skipped_cached = 0
        for doc_idx, path in enumerate(valid_paths):
            for page_num in range(1, self.pdf_renderer.get_page_count(path) + 1):
                if skip_cached and self.cache_manager.is_page_cached(path, page_num, model_name):
                    skipped_cached += 1
                    continue
                plan.append((doc_idx, path, page_num))

        if not plan:
            raise ValueError(
                f"Nothing to submit: all {skipped_cached} pages across "
                f"{len(valid_paths)} document(s) have already been converted by "
                f"{model_name}. Pass skip_cached=False to convert them again."
            )

        self._check_payload_size(len(plan))

        total_pages_all = len(plan)
        key_mapping: Dict[str, Dict[str, Any]] = {}
        total_requests = 0
        current_rendered_page = 0

        logger.info(
            "Generating Batch JSONL for %d documents: %d pages to convert, "
            "%d already cached for %s.",
            len(valid_paths), len(plan), skipped_cached, model_name
        )

        page_counts = {path: self.pdf_renderer.get_page_count(path) for path in valid_paths}

        with open(jsonl_path, "w", encoding="utf-8") as jsonl_file:
            for doc_idx, path, page_num in plan:
                current_rendered_page += 1
                req_key = f"doc{doc_idx:03d}_p{page_num:03d}"

                key_mapping[req_key] = {
                    "pdf_path": str(path),
                    "doc_name": path.name,
                    "folder": path.parent.name,
                    "page_num": page_num,
                    "total_pages": page_counts[path],
                    "stem": path.stem
                }

                # Render page image
                img_bytes = self.pdf_renderer.render_page_from_path(path, page_num, dpi=200)
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

                # The estimate that cleared _check_payload_size assumes an
                # average page. A corpus of unusually heavy scans can still
                # overrun, so stop at the real boundary rather than uploading a
                # file the File API will reject.
                if jsonl_file.tell() > self.MAX_BATCH_FILE_BYTES:
                    jsonl_file.close()
                    jsonl_path.unlink(missing_ok=True)
                    raise ValueError(self._too_large_message(current_rendered_page, len(plan)))

                if progress_callback:
                    progress_callback({
                        "phase": "rendering",
                        "doc_name": path.name,
                        "current_page": current_rendered_page,
                        "total_pages": total_pages_all,
                        "percent": round((current_rendered_page / total_pages_all) * 75, 1),
                        "status": f"Rendering {path.name} — Page {page_num}/{page_counts[path]} (200 DPI PNG)..."
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
            "mapping_file": str(mapping_path),
            # Which prompt this job asked with. A retry pass uses a recitation
            # fallback rather than the preset, and the pages it produces are
            # stamped with it so they can be told apart later.
            "prompt_id": prompt_id or PRESET_PROMPT_ID,
        }

        self._update_jobs(lambda jobs: jobs.insert(0, job_info))

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

        # Poll Google outside the lock — a slow network call must not hold the
        # store shut against another process trying to record a submission.
        # What comes back is a set of patches, applied afterwards by job id, so
        # jobs added while we were polling survive rather than being overwritten
        # by our stale snapshot.
        patches: Dict[str, Dict[str, Any]] = {}
        for job in self._load_jobs():
            if job.get("is_completed") or not job.get("gemini_job_name"):
                continue
            try:
                remote_job = self.client.batches.get(name=job["gemini_job_name"])
                state_name = remote_job.state.name if hasattr(remote_job.state, "name") else str(remote_job.state)
                patch: Dict[str, Any] = {"status": state_name}
                if getattr(remote_job, "dest", None):
                    patch["dest_file_name"] = getattr(remote_job.dest, "file_name", None)
                if getattr(remote_job, "error", None):
                    patch["error"] = str(remote_job.error)

                if state_name in self.TERMINAL_STATES:
                    patch["is_completed"] = True
                    if state_name == "JOB_STATE_SUCCEEDED":
                        patch["completed_at"] = time.time()
                patches[job["id"]] = patch
            except Exception as e:
                logger.warning(f"Error checking job {job.get('gemini_job_name')}: {e}")

        if patches:
            def _apply(current: List[Dict[str, Any]]) -> None:
                for job in current:
                    patch = patches.get(job.get("id"))
                    if patch:
                        job.update(patch)
            jobs = self._update_jobs(_apply)
        else:
            jobs = self._load_jobs()
            self._cached_jobs = jobs

        self._last_poll_time = now
        return jobs

    @staticmethod
    def job_id_submitted_at(job_id: str) -> Optional[float]:
        """The submission time encoded in a job id, as epoch seconds.

        Ids are minted from the local clock at submission — `batch_20260822_133838`
        — and that timestamp is the only thing separating one pass of a group
        from the next when both carry the same display name at Google.
        """
        match = re.fullmatch(r"batch_(\d{8})_(\d{6})", job_id or "")
        if not match:
            return None
        try:
            return time.mktime(time.strptime(match.group(1) + match.group(2), "%Y%m%d%H%M%S"))
        except (ValueError, OverflowError):
            return None

    def recover_job(self, job_id: str, display_name: str) -> Optional[Dict[str, Any]]:
        """Rebuild a job record that has gone missing from the local store.

        The store is a cache of where the work is; Google is where the work
        actually lives. So a lost record is not lost work — the batch is still
        at Google, and the mapping file that says which page each request came
        from is still on disk. Everything needed to finish the job survives.

        Without this, a plan whose record went missing waits at "submitted" for
        ever while the results sit there finished and paid for, and no amount
        of re-running will move it, because re-running looks up the same absent
        id and finds the same nothing.

        Returns the rebuilt record, or None if the job genuinely cannot be
        recovered. Raises if Google could not be reached — that is not the same
        answer, and the caller must not treat it as one.
        """
        jobs = self._load_jobs()
        existing = next((j for j in jobs if j.get("id") == job_id), None)
        if existing:
            return existing

        mapping_path = self.batch_dir / f"{job_id}_mapping.json"
        if not mapping_path.exists():
            # The mapping says which document and page each request key belongs
            # to. Without it the results are an unordered pile of Markdown that
            # cannot be filed, so finding the batch would not help.
            logger.error(
                "Cannot recover job %s: its mapping file %s is gone, so results "
                "could not be matched back to pages even if the batch were found.",
                job_id, mapping_path
            )
            return None

        # A batch already pointed at by some other record is not ours: retry
        # passes of the same group all carry the same display name.
        claimed = {j.get("gemini_job_name") for j in jobs if j.get("gemini_job_name")}
        submitted_at = self.job_id_submitted_at(job_id)

        candidates = []
        for batch in self.client.batches.list(config={"page_size": 100}):
            if (getattr(batch, "display_name", None) or "") != display_name:
                continue
            if batch.name in claimed:
                continue

            created = getattr(batch, "create_time", None)
            created_at = created.timestamp() if created is not None else None
            if submitted_at and created_at and created_at < submitted_at - self.RECOVERY_CLOCK_SKEW:
                # Created before this id existed, so it belongs to an earlier pass.
                continue
            candidates.append((created_at if created_at is not None else 0.0, batch))

        if not candidates:
            logger.error(
                "Cannot recover job %s: no unclaimed batch named %r at Google.",
                job_id, display_name
            )
            return None

        # The earliest batch created after the id was minted is the one that id
        # produced. Anything later belongs to a pass that came after it.
        candidates.sort(key=lambda pair: pair[0])
        created_at, batch = candidates[0]

        mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
        pdf_paths = list(dict.fromkeys(info["pdf_path"] for info in mapping.values()))
        state = batch.state.name if hasattr(batch.state, "name") else str(batch.state)
        model = (getattr(batch, "model", None) or "").replace("models/", "")

        record = {
            "id": job_id,
            "gemini_job_name": batch.name,
            "display_name": display_name,
            "model": model or PricingRegistry.DEFAULT_MODEL,
            # Only ever used at submission time, and that has already happened.
            "uploaded_file": None,
            "total_documents": len(pdf_paths),
            "total_requests": len(mapping),
            "submitted_at": submitted_at or created_at or time.time(),
            "status": state,
            "is_completed": state in self.TERMINAL_STATES,
            "dest_file_name": getattr(getattr(batch, "dest", None), "file_name", None),
            "pdf_paths": pdf_paths,
            "mapping_file": str(mapping_path),
            # Kept so it is obvious this record was reconstructed rather than
            # written at submission, if anyone ever reads the store by hand.
            "recovered_at": time.time(),
        }

        def _insert(current: List[Dict[str, Any]]) -> None:
            # Another process may have recovered it while we were asking Google.
            if not any(j.get("id") == job_id for j in current):
                current.insert(0, record)

        self._update_jobs(_insert)
        logger.warning(
            "Recovered lost record for job %s (%r) from Google: %s, %d requests.",
            job_id, display_name, state, len(mapping)
        )
        return record

    def collect_job_results(self, job_id: str) -> Dict[str, Any]:
        """Download batch results and assemble final Markdown files."""
        # Collecting reaches the same File API the submission used.
        self._require_batch_support()
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
        blocked: List[Dict[str, Any]] = []
        # Needed before the parse loop below, which caches each page under
        # the model that produced it.
        model_used = target_job.get("model", PricingRegistry.DEFAULT_MODEL)
        # None for an ordinary conversion, so the stamp marks only the pages
        # that a recitation fallback had to rescue.
        prompt_used = target_job.get("prompt_id") or None
        if prompt_used == PRESET_PROMPT_ID:
            prompt_used = None

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
                finish_reason = None
                resp = record.get("response")
                if resp and "candidates" in resp and len(resp["candidates"]) > 0:
                    candidate = resp["candidates"][0]
                    finish_reason = candidate.get("finishReason")
                    parts = candidate.get("content", {}).get("parts", [])
                    for part in parts:
                        if "text" in part:
                            text_content += part["text"]

                text_content = text_content.strip()
                if text_content:
                    doc_pages[pdf_path][page_num] = text_content
                    self.cache_manager.write_page_cache(
                        Path(pdf_path), page_num, text_content, model_used,
                        prompt=prompt_used
                    )
                else:
                    # A page with no text is not a conversion. Batch reports the
                    # recitation filter as finishReason RECITATION on an
                    # otherwise successful record — no error, no exception — so
                    # nothing upstream notices unless we look here.
                    blocked.append({
                        "pdf_path": pdf_path,
                        "page_num": page_num,
                        "reason": finish_reason or "EMPTY_RESPONSE",
                    })
            except Exception as e:
                logger.error(f"Error parsing batch result line: {e}")

        # Assemble every document the job was submitted for, not merely those
        # that appear in the results. A document whose pages were all already
        # cached contributes no batch requests at all, and would otherwise be
        # silently left unassembled.
        assembled_files = []
        selected = target_job.get("pdf_paths") or list(doc_pages.keys())
        for pdf_path_str in selected:
            p = Path(pdf_path_str)
            if not p.exists():
                logger.warning("Skipping %s — no longer on disk.", p)
                continue
            pages_dict = doc_pages.get(pdf_path_str, {})
            out_dir = p.parent / "Markdown"
            out_dir.mkdir(parents=True, exist_ok=True)
            final_md_path = out_dir / f"{p.stem}.md"

            meta = doc_meta.get(pdf_path_str)
            total_pages = meta["total_pages"] if meta else self.pdf_renderer.get_page_count(p)

            # Pages left out of the payload because they were already converted
            # come back from the cache. So do pages an individual request
            # failed on, if an earlier run happened to get them.
            ordered_pages = []
            recovered = 0
            for pn in range(1, total_pages + 1):
                text = pages_dict.get(pn)
                if text is None:
                    text = self.cache_manager.read_page_cache(p, pn, model_used)
                    if text is not None:
                        recovered += 1
                if text is None:
                    text = f"> **[Page {pn} conversion missing]**"
                ordered_pages.append(text)
            if recovered:
                logger.info("%s: %d page(s) taken from cache rather than this batch.", p.name, recovered)
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

        def _record_collection(current: List[Dict[str, Any]]) -> None:
            for job in current:
                if job.get("id") == job_id:
                    job["is_collected"] = True
                    job["assembled_files"] = assembled_files
        self._update_jobs(_record_collection)

        if blocked:
            reasons = Counter(b["reason"] for b in blocked)
            logger.warning(
                "%d page(s) returned no text (%s). They are deliberately left "
                "uncached so a retry pass can pick them up.",
                len(blocked), ", ".join(f"{r}x{n}" for r, n in reasons.items())
            )

        return {
            "status": "success",
            "job_id": job_id,
            "assembled_files_count": len(assembled_files),
            "files": assembled_files,
            "blocked": blocked,
        }
