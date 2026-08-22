import os
import re
import sys
import json
import hashlib
import time
import shutil
import subprocess
import threading
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, Request, UploadFile, File, Form, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel

from goosequill import __version__
from goosequill.models import (
    DEFAULT_SYSTEM_PROMPT,
    PROMPT_PRESETS,
    PricingRegistry,
    JobState,
    JobProgress
)

from goosequill.services.genai_factory import describe_backend
from goosequill.services.batch_planner import BatchPlanner, DEFAULT_MAX_ENQUEUED_TOKENS
from goosequill.services import folder_picker
from goosequill.services import (
    PDFRenderer,
    CacheManager,
    CostCalculator,
    GeminiOCRClient,
    MarkdownAssembler,
    DocumentRepository,
    ConversionEngine,
    BatchService,
    MarkdownCombinerService,
    PricingSyncService,
    SearchService,
    BoilerplateDetector
)
from goosequill.services.search_service import (
    CONSOLIDATED_DIR_NAME,
    LIGHTWEIGHT_DIR_NAME,
    is_consolidated,
    is_lightweight,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


class _QuietAssetAccessLogs(logging.Filter):
    """Drop successful access-log lines for the endpoints that fire constantly.

    Scrolling one 214-page document asks for a page image per thumbnail and per
    preview, so a minute of ordinary reading buried anything worth seeing under
    hundreds of near-identical 200 OK lines. Failures still come through — a
    404 or a 500 on these routes is exactly what you would want to be told
    about — and GOOSEQUILL_VERBOSE_ACCESS=1 brings all of them back.
    """

    NOISY_PATHS = ("/api/page_image", "/favicon.ico", "/style.css", "/vendor/", "/js/")

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not isinstance(args, tuple) or len(args) < 5:
            return True
        path, status = args[2], args[4]
        try:
            if int(status) >= 400:
                return True
        except (TypeError, ValueError):
            return True
        return not any(str(path).startswith(prefix) for prefix in self.NOISY_PATHS)


if os.environ.get("GOOSEQUILL_VERBOSE_ACCESS", "0") != "1":
    logging.getLogger("uvicorn.access").addFilter(_QuietAssetAccessLogs())
logger = logging.getLogger("app")

class EndpointFilter(logging.Filter):
    """Filter out high-frequency background polling endpoints from terminal logs."""
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "/api/job_status" in msg or "/api/batch/jobs" in msg:
            return False
        return True

# Attach filter to Uvicorn access loggers
logging.getLogger("uvicorn.access").addFilter(EndpointFilter())

app = FastAPI(title="GooseQuill — Universal PDF to Markdown")

# Rendered page images are immutable for a given file+page+dpi, so they set
# their own long-lived caching headers. Everything else stays uncacheable.
_SELF_CACHING_PATHS = ("/api/page_image",)


@app.middleware("http")
async def add_no_cache_header(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(_SELF_CACHING_PATHS):
        return response
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    # The head alone, not the whole quill: at 16px the feather is a smudge,
    # while the head still reads. Browsers ask for this path whatever the
    # document says, so it is served here as well as linked in the page.
    mark = WEB_DIR / "brand" / "goosequill-head.svg"
    if mark.is_file():
        return FileResponse(mark, media_type="image/svg+xml")
    return Response(status_code=404)

@app.get("/.well-known/appspecific/com.chrome.devtools.json", include_in_schema=False)
def chrome_devtools_probe():
    return Response(status_code=204)

@app.get("/vendor/purify.min.js.map", include_in_schema=False)
def purify_sourcemap():
    return Response(content="{}", media_type="application/json")

# Dynamic project paths
PROJECT_ROOT = Path(__file__).resolve().parent
BASE_ACCOUNTS_DIR = PROJECT_ROOT / "Accounts" if (PROJECT_ROOT / "Accounts").exists() else (PROJECT_ROOT / "documents")
CACHE_DIR = PROJECT_ROOT / ".cache"
WEB_DIR = PROJECT_ROOT / "web"

# A fresh clone has neither folder; create the default workspace so the app
# has somewhere to put documents on first run.
BASE_ACCOUNTS_DIR.mkdir(parents=True, exist_ok=True)

def _resolve_within_root(raw_path: str) -> Path:
    """Resolve a client-supplied path and confirm it stays inside the active root.

    Every filesystem path that arrives over the API passes through here. Without it
    the server would happily read or write anywhere the host user can reach.
    """
    try:
        candidate = Path(raw_path).expanduser().resolve()
    except (OSError, RuntimeError):
        raise HTTPException(status_code=400, detail="Invalid path.")

    root = BASE_ACCOUNTS_DIR.resolve()
    if candidate != root and root not in candidate.parents:
        raise HTTPException(status_code=403, detail="Path is outside the active documents folder.")
    return candidate


def _safe_component(name: str, label: str = "Name") -> str:
    """Validate a single user-supplied folder or file name (no separators, no traversal)."""
    clean = (name or "").strip().strip("/\\")
    if not clean:
        raise HTTPException(status_code=400, detail=f"{label} cannot be empty.")
    if "/" in clean or "\\" in clean or clean in (".", "..") or clean.startswith("."):
        raise HTTPException(status_code=400, detail=f"{label} contains invalid characters.")
    return clean


# Load persistent pricing overrides if cached
PricingRegistry.load_overrides(CACHE_DIR / "pricing_overrides.json")

# Shared singletons
cache_manager = CacheManager(cache_dir=CACHE_DIR)
doc_repository = DocumentRepository(cache_manager=cache_manager)
pdf_renderer = PDFRenderer()
markdown_assembler = MarkdownAssembler()
search_service = SearchService()
job_state = JobState()
active_engine: Optional[ConversionEngine] = None

# Deflation runs on its own state rather than the conversion JobState: it has no
# pages, no per-file cost, and no cancel, and folding it into the conversion
# banner would have the workspace report a conversion that is not happening.
deflate_state: Dict[str, Any] = {
    "is_running": False,
    "phase": "",
    "current_file": "",
    "files_done": 0,
    "total_files": 0,
    "percent": 0.0,
    "error": None,
    "results": None,
    "started_at": None,
    "finished_at": None,
}
deflate_lock = threading.Lock()

# Pydantic Schemas
class ConvertRequest(BaseModel):
    files: List[str]
    model: str = "gemini-3.1-flash-lite"
    system_prompt: Optional[str] = None
    force_reprocess: bool = False
    limit_pages: Optional[int] = None
    concurrency: int = 5

class SaveMarkdownRequest(BaseModel):
    file_path: str
    content: str

class CreateFolderRequest(BaseModel):
    folder_name: str

class SetRootFolderRequest(BaseModel):
    root_path: str

class BrowseFolderRequest(BaseModel):
    # Where the dialog should open. Optional: falls back to the active workspace.
    start_dir: Optional[str] = None

class BatchCreateRequest(BaseModel):
    files: List[str]
    model: str = "gemini-3.1-flash-lite"
    system_prompt: Optional[str] = None
    display_name: Optional[str] = None

class BatchCollectRequest(BaseModel):
    job_id: str

class BatchPlanCreateRequest(BaseModel):
    """A plan over a whole folder, or over named documents for a repair."""
    root: Optional[str] = None
    files: Optional[List[str]] = None
    model: str = PricingRegistry.DEFAULT_MODEL
    preset: str = "financial"
    max_enqueued_tokens: int = DEFAULT_MAX_ENQUEUED_TOKENS
    force: bool = False

class BatchPlanAdvanceRequest(BaseModel):
    only: Optional[str] = None
    max_groups: Optional[int] = None
    retry_blocked: bool = False
    retry_failed: bool = False

class DeflateRequest(BaseModel):
    """A deflation run.

    ``files`` is what gets rewritten. Repetition, though, is a claim about a
    corpus — so unless ``compare_against_selection`` is set, the whole workspace
    is read as the reference against which those files are judged. Deflating six
    filings against only each other would find every shared sentence "repeated
    throughout the corpus we examined", which is not the same statement at all.
    """
    files: List[str]
    mode: str = "algorithmic"
    threshold: int = 3
    peer_threshold: int = 2
    similarity: float = 0.85
    model: str = "gemini-2.5-flash-lite"
    compare_against_selection: bool = False
    write: bool = True

class CombineMarkdownRequest(BaseModel):
    files: List[str]
    master_title: Optional[str] = None
    output_filename: Optional[str] = "Consolidated_Document.md"
    target_folder: Optional[str] = None
    include_toc: bool = True
    include_source_meta: bool = True
    strip_original_headers: bool = True
    sort_mode: str = "custom"
    save_to_disk: bool = True
    # Whether the assembled document comes back in the response. Off for a
    # whole-workspace build, which is written to disk and streamed on request
    # rather than carried through the tab.
    return_content: bool = True


def run_conversion_task(req: ConvertRequest):
    global job_state, active_engine
    try:
        job_state.reset(total_files=len(req.files))
        job_state.add_log(f"Starting conversion for {len(req.files)} file(s) with model: {req.model} (Concurrency: {req.concurrency} pages)")

        engine = ConversionEngine(
            cache_manager=cache_manager,
            pdf_renderer=pdf_renderer,
            markdown_assembler=markdown_assembler,
            model_name=req.model,
            system_prompt=req.system_prompt,
            concurrency=req.concurrency
        )
        active_engine = engine

        for idx, file_path_str in enumerate(req.files):
            if not job_state.is_running or engine.is_cancelled():
                job_state.add_log("Job cancelled.")
                break

            pdf_path = Path(file_path_str)
            if not pdf_path.exists():
                job_state.add_error(pdf_path.name, None, f"File does not exist: {file_path_str}")
                continue

            job_state.current_file = pdf_path.name
            job_state.current_folder = pdf_path.parent.name
            job_state.current_page = 0
            job_state.percent = 0.0

            try:
                job_state.total_pages = pdf_renderer.get_page_count(pdf_path)
            except Exception as e:
                job_state.add_error(pdf_path.name, None, f"Could not read PDF: {e}")
                continue

            job_state.add_log(f"Converting [{idx+1}/{len(req.files)}] {pdf_path.name} ({job_state.total_pages} pages, {req.concurrency}x parallel)...")

            def on_progress(p_info: Dict[str, Any]):
                job_state.current_page = p_info.get("current_page", 0)
                job_state.total_pages = p_info.get("total_pages", job_state.total_pages)
                job_state.percent = p_info.get("percent", 0.0)
                if p_info.get("warning_message"):
                    job_state.warning_message = p_info["warning_message"]
                    job_state.add_log(f"[WARNING] {p_info['warning_message']}")
                else:
                    job_state.warning_message = None

            try:
                engine.convert_document(
                    pdf_path=pdf_path,
                    force_reprocess=req.force_reprocess,
                    limit_pages=req.limit_pages,
                    concurrency=req.concurrency,
                    progress_callback=on_progress
                )
                job_state.files_done += 1
                job_state.add_log(f"Finished {pdf_path.name} -> Markdown saved.")

            except Exception as doc_err:
                logger.exception(f"Error converting {pdf_path.name}")
                job_state.add_error(pdf_path.name, job_state.current_page, str(doc_err))
                if isinstance(doc_err, PermissionError) or "403" in str(doc_err):
                    job_state.error = f"Authentication Failed: {str(doc_err)}"
                    break

        if not job_state.error and len(job_state.errors) > 0:
            job_state.add_log(f"Batch completed with {len(job_state.errors)} error(s).")
        else:
            job_state.add_log("All requested conversions finished.")
    except Exception as e:
        logger.exception("Conversion task error")
        job_state.error = str(e)
        job_state.add_error("General", None, str(e))
    finally:
        job_state.finish()
        active_engine = None


@app.get("/api/test_connection")
def test_connection(model: str = "gemini-3.1-flash-lite"):
    """Test API credentials and connectivity."""
    try:
        client = GeminiOCRClient(model_name=model)
        result = client.test_connection()
        # Which backend answered matters as much as whether it answered: it is
        # the difference between documents staying in a region you chose and
        # going to a global endpoint.
        result["backend"] = client.backend.to_dict()
        return result
    except Exception as e:
        # "No key yet" is where every new user starts; "key rejected" is a
        # fault. They shared an error_type, so the interface had no way to tell
        # a first run from a broken one and showed both in red.
        no_key = "no api key" in str(e).lower()
        return {
            "status": "error",
            "error_type": "NO_KEY" if no_key else "INIT_ERROR",
            "model": model,
            "message": str(e),
            # What the user can still do without a key. Conversion needs Gemini;
            # the Markdown Combiner and the document browser do not.
            "offline_features": ["Markdown Combiner", "Document browser",
                                 "Viewer"] if no_key else [],
            "backend": backend_info()
        }


def backend_info() -> Dict[str, Any]:
    """Describe the configured backend. Defined in the service layer so the
    web layer cannot drift from it."""
    try:
        return describe_backend()
    except Exception:
        return {"backend": "unknown", "label": "unknown", "region_pinned": False}


@app.get("/api/backend")
def get_backend():
    """Report which Gemini backend is configured, whether it is region-pinned,
    and which GooseQuill this is.

    The version rides along because this is the endpoint to reach for when
    someone asks what a given install actually is — answerable with `curl`,
    without opening the interface.
    """
    return {**backend_info(), "version": __version__}

@app.get("/api/documents")
def get_documents(model: str = "gemini-3.1-flash-lite"):
    """List all discoverable folders and PDF files with page counts and detailed token cost estimates."""
    payload = doc_repository.scan_directory(BASE_ACCOUNTS_DIR, model_name=model)
    # Added here rather than in the repository, which scans directories and has
    # no business knowing the application's version. This is the payload the
    # interface loads at startup, so carrying it costs no extra request.
    payload["version"] = __version__
    return payload

@app.get("/api/pricing")
def get_pricing():
    """
    The rate card the interface shows.

    The Economics view used to carry these figures as ten rows of hand-written
    HTML, which meant "Sync Latest Rates" could report success and change
    nothing the reader could see, and a model added to the registry never
    appeared at all. Served from the registry, the table cannot disagree with
    what the estimates are actually costed against.
    """
    return {
        "pricing": PricingRegistry.get_all_raw(),
        "default_model": PricingRegistry.DEFAULT_MODEL,
        # None until someone syncs, which is how the card can say it is showing
        # the rates this release shipped with rather than implying they are current.
        "synced_at": PricingRegistry.synced_at
    }

@app.post("/api/sync_pricing")
def sync_pricing():
    """Fetch official Gemini pricing updates from Google AI documentation and update local registry."""
    service = PricingSyncService(cache_dir=CACHE_DIR)
    result = service.sync_pricing()
    return result

@app.post("/api/create_folder")
def create_folder(req: CreateFolderRequest):
    """Create a new folder in the root documents folder."""
    try:
        clean_name = _safe_component(req.folder_name, "Folder name")
        new_path = doc_repository.create_folder(BASE_ACCOUNTS_DIR, clean_name)
        return {"status": "created", "name": clean_name, "path": str(new_path)}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))

@app.get("/api/folder_picker")
def folder_picker_status():
    """Whether this host can show a native folder dialog.

    Asked once when the interface loads, so the Choose Folder button is only
    drawn where pressing it could actually do something.
    """
    return {"available": folder_picker.is_available(), "platform": sys.platform}

@app.post("/api/browse_folder")
def browse_folder(req: BrowseFolderRequest):
    """Open the host's own folder dialog and report what was chosen.

    The browser cannot tell us where a folder lives on disk — no browser will,
    and rightly so. The server can, because it is running on the same machine
    as the person using it. See goosequill/services/folder_picker.py.

    Choosing does not switch anything: the path comes back to the interface,
    which sends it to /api/set_root_folder like any typed path, so validation
    happens in exactly one place.
    """
    start = None
    if req.start_dir:
        candidate = Path(req.start_dir).expanduser()
        if candidate.is_dir():
            start = candidate
    if start is None:
        start = BASE_ACCOUNTS_DIR

    try:
        chosen = folder_picker.choose_folder(start_dir=start)
    except folder_picker.PickerUnavailableError as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail="The folder dialog was left open too long and has been closed.",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    if chosen is None:
        return {"status": "cancelled"}
    return {"status": "selected", "path": chosen}

@app.post("/api/set_root_folder")
def set_root_folder(req: SetRootFolderRequest):
    """Switch the working documents root folder.

    This deliberately accepts any directory the host user can read: choosing a
    workspace is the point of the feature. It is also the app's trust boundary,
    which is why the server binds to loopback only (see __main__).
    """
    global BASE_ACCOUNTS_DIR
    clean_path = req.root_path.strip()
    try:
        p = Path(clean_path).expanduser().resolve()
    except (OSError, RuntimeError):
        raise HTTPException(status_code=400, detail="Invalid path.")

    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory does not exist: {clean_path}")
    BASE_ACCOUNTS_DIR = p
    return {"status": "success", "root_directory": str(BASE_ACCOUNTS_DIR)}

@app.post("/api/upload")
def upload_pdf(file: UploadFile = File(...), folder_name: Optional[str] = Form(None)):
    """Upload a PDF file to a specific folder or root."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are allowed.")
    
    if folder_name and folder_name not in ("General / Root", "Root"):
        target_folder = BASE_ACCOUNTS_DIR / _safe_component(folder_name, "Folder name")
    else:
        target_folder = BASE_ACCOUNTS_DIR
    target_folder.mkdir(parents=True, exist_ok=True)
    # Never trust the client-supplied filename: strip any directory component.
    safe_name = _safe_component(Path(file.filename).name, "File name")
    file_path = target_folder / safe_name
    
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    return {"status": "success", "file_name": safe_name, "path": str(file_path)}

@app.post("/api/convert")
def start_conversion(req: ConvertRequest):
    """Start background conversion job."""
    global job_state
    if job_state.is_running:
        raise HTTPException(status_code=400, detail="A conversion job is already running.")

    req.files = [str(_resolve_within_root(f)) for f in req.files]

    thread = threading.Thread(target=run_conversion_task, args=(req,), daemon=True)
    thread.start()
    return {"status": "started", "file_count": len(req.files)}

@app.get("/api/job_status")
def get_job_status():
    """Poll the status of the running background job."""
    global job_state
    if job_state.is_running:
        return job_state.to_dict()

    cached_status = cache_manager.read_job_status()
    if cached_status and cached_status.get("is_running") and (time.time() - cached_status.get("timestamp", 0) < 30):
        return {
            "is_running": True,
            "current_file": cached_status.get("current_file", ""),
            "current_folder": cached_status.get("current_folder", ""),
            "current_page": cached_status.get("current_page", 0),
            "total_pages": cached_status.get("total_pages", 0),
            "percent": cached_status.get("percent", 0.0),
            "files_done": 0,
            "total_files": 1,
            "logs": [f"Process active: {cached_status.get('current_file')}"],
            "errors": [],
            "warning_message": cached_status.get("warning_message"),
            "error": None
        }

    return job_state.to_dict()

@app.post("/api/cancel")
def cancel_conversion():
    """Cancel the active conversion job."""
    global job_state, active_engine
    if active_engine:
        active_engine.cancel()
    job_state.is_running = False
    job_state.add_log("Cancellation requested.")
    cache_manager.write_job_status({"is_running": False, "status": "cancelled"})
    return {"status": "cancelling"}

@app.post("/api/clear_errors")
def clear_errors():
    """Clear error history in job_state."""
    global job_state
    job_state.errors = []
    job_state.error = None
    job_state.warning_message = None
    return {"status": "cleared"}

@app.get("/api/markdown")
def get_markdown(path: str):
    """Get the markdown file content for a given PDF or MD path."""
    p = _resolve_within_root(path)
    if p.suffix.lower() == ".pdf":
        md_path = p.parent / "Markdown" / f"{p.stem}.md"
    else:
        md_path = p

    if md_path.suffix.lower() != ".md":
        raise HTTPException(status_code=400, detail="Only .md files can be read.")
    if not md_path.exists():
        raise HTTPException(status_code=404, detail="Markdown file not found. Convert the document first.")

    content = markdown_assembler.read_document(md_path)
    return {
        "file_name": md_path.name,
        "path": str(md_path),
        "content": content
    }

@app.post("/api/markdown")
def save_markdown(req: SaveMarkdownRequest):
    """Save updated markdown content."""
    p = _resolve_within_root(req.file_path)
    if p.suffix.lower() != ".md":
        raise HTTPException(status_code=400, detail="Only .md files can be written.")
    markdown_assembler.save_document(p, req.content)
    return {"status": "saved", "path": str(p)}

# Bounds for the client's zoom control. Below the floor thumbnails stop being
# legible; above the ceiling a single page costs more to render than it is worth.
MIN_PAGE_DPI = 16
MAX_PAGE_DPI = 400


@app.get("/api/page_image")
def get_page_image(request: Request, path: str, page: int = 1, dpi: int = 150):
    """Render a specific PDF page as a PNG.

    The result depends only on the file's contents, the page and the dpi, so it
    carries a strong ETag and a long max-age. Without them every page turn
    re-rasterised the page server-side — about 90ms and 290KB each time, behind
    a global PDFium lock — and flipping back to a page you had just viewed paid
    the full cost again.
    """
    p = _resolve_within_root(path)
    if p.suffix.lower() != ".pdf":
        raise HTTPException(status_code=400, detail="Only PDF files can be rendered.")
    if not p.exists():
        raise HTTPException(status_code=404, detail="PDF not found")

    dpi = max(MIN_PAGE_DPI, min(int(dpi), MAX_PAGE_DPI))

    try:
        stat = p.stat()
        etag = '"{}"'.format(
            hashlib.sha1(
                f"{p.resolve()}|{stat.st_size}|{stat.st_mtime_ns}|{page}|{dpi}".encode("utf-8")
            ).hexdigest()
        )
    except OSError:
        etag = None

    cache_headers = {"Cache-Control": "private, max-age=86400"}
    if etag:
        cache_headers["ETag"] = etag
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=cache_headers)

    try:
        img_bytes = pdf_renderer.render_page_from_path(p, page, dpi=dpi)
        return Response(content=img_bytes, media_type="image/png", headers=cache_headers)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/batch/jobs")
def get_batch_jobs(force: bool = False):
    """List all submitted Batch API jobs with live status and 30s cache."""
    try:
        bs = BatchService(cache_manager=cache_manager)
        jobs = bs.list_jobs(force_refresh=force)
        return {"jobs": jobs}
    except Exception as e:
        return {"jobs": [], "error": str(e)}

@app.post("/api/batch/create")
def create_batch_job(req: BatchCreateRequest):
    """Submit a batch job for offline processing via Gemini Batch API with live progress tracking."""
    global job_state
    try:
        bs = BatchService(cache_manager=cache_manager)
        req.files = [str(_resolve_within_root(f)) for f in req.files]
        job_state.reset(total_files=len(req.files))
        job_state.current_file = "Preparing Batch Payload..."
        job_state.add_log(f"Starting batch preparation for {len(req.files)} document(s) with model: {req.model}")

        def on_batch_progress(p_info: Dict[str, Any]):
            job_state.current_page = p_info.get("current_page", 0)
            job_state.total_pages = p_info.get("total_pages", job_state.total_pages)
            job_state.percent = p_info.get("percent", 0.0)
            if p_info.get("doc_name"):
                job_state.current_file = p_info["doc_name"]
            if p_info.get("status"):
                job_state.add_log(f"[BATCH] {p_info['status']}")

        job = bs.create_batch_job(
            pdf_paths=req.files,
            model_name=req.model,
            system_prompt=req.system_prompt or DEFAULT_SYSTEM_PROMPT,
            display_name=req.display_name,
            progress_callback=on_batch_progress
        )
        job_state.percent = 100.0
        job_state.add_log(f"Batch job '{job.get('id')}' submitted to Gemini queue successfully (50% discount).")
        return {"status": "submitted", "job": job}
    except HTTPException:
        raise
    except ValueError as e:
        # Unsupported backend or bad configuration: the caller can fix this, so
        # it is a 400. A 500 would suggest GooseQuill had broken.
        job_state.error = str(e)
        job_state.add_error("Batch", None, str(e))
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Batch creation error")
        job_state.error = str(e)
        job_state.add_error("Batch", None, str(e))
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        job_state.finish()

@app.post("/api/batch/collect")
def collect_batch_results(req: BatchCollectRequest):
    """Download results from completed Batch API job and build markdown files."""
    try:
        bs = BatchService(cache_manager=cache_manager)
        result = bs.collect_job_results(req.job_id)
        return result
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Batch collect error")
        raise HTTPException(status_code=500, detail=str(e))


# --- Batch plans -----------------------------------------------------------
#
# A plan is a corpus-sized conversion split into jobs and submitted as the
# account's enqueued-token allowance frees up. The plan file on disk is the
# source of truth, so these endpoints stay thin: create one, read it, and ask
# it to take a step. A step can take minutes — rendering and uploading a
# group — so it runs on a thread and the caller polls the plan.

_advancing: Dict[str, bool] = {}
_advancing_lock = threading.Lock()


def _planner() -> BatchPlanner:
    return BatchPlanner(cache_manager=cache_manager)


@app.get("/api/batch/plans")
def list_batch_plans():
    """Every saved plan, newest first, with its progress."""
    try:
        planner = _planner()
        with _advancing_lock:
            running = dict(_advancing)
        return {"plans": [
            {
                **planner.summarise(plan),
                "advancing": running.get(plan["id"], False),
                # A plan can also be under way in a terminal, which this process
                # cannot see in `_advancing` but can see in the lock file.
                "locked": planner.is_locked(plan["id"]),
            }
            for plan in planner.list_plans()
        ]}
    except Exception as e:
        logger.exception("Listing batch plans failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/batch/plans")
def create_batch_plan(req: BatchPlanCreateRequest):
    """Group a corpus into jobs. Submits nothing — that is what advance is for."""
    try:
        files = None
        if req.files is not None:
            files = [str(_resolve_within_root(f)) for f in req.files]
        root = _resolve_within_root(req.root) if req.root else BASE_ACCOUNTS_DIR.resolve()

        planner = _planner()
        plan = planner.create_plan(
            root=root,
            model=req.model,
            preset=req.preset,
            max_enqueued_tokens=req.max_enqueued_tokens,
            skip_cached=not req.force,
            files=files,
        )
        return {"plan": plan, "summary": planner.summarise(plan)}
    except HTTPException:
        raise
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Creating a batch plan failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/batch/plans/{plan_id}")
def get_batch_plan(plan_id: str):
    """One plan in full, group by group."""
    _safe_component(plan_id, "Plan ID")
    try:
        planner = _planner()
        plan = planner.load_plan(plan_id)
        with _advancing_lock:
            advancing = _advancing.get(plan_id, False)
        return {
            # Annotated, so each group can say how many of its pages actually
            # came back rather than only which state it reached.
            "plan": planner.annotate(plan),
            "summary": planner.summarise(plan),
            "advancing": advancing,
            "locked": planner.is_locked(plan_id),
        }
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("Reading batch plan failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/batch/plans/{plan_id}/advance")
def advance_batch_plan(plan_id: str, req: BatchPlanAdvanceRequest):
    """Take one step: collect what has finished, submit what now fits.

    Returns as soon as the step is under way. The plan file records every
    transition as it happens, so the caller watches progress by re-reading the
    plan rather than holding a request open for the length of an upload.
    """
    _safe_component(plan_id, "Plan ID")
    planner = _planner()
    try:
        planner.load_plan(plan_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    if planner.is_locked(plan_id):
        # Almost always `batch run --watch` in a terminal. Without this the
        # step would start, wait thirty seconds for a lock it is not going to
        # get, and give up somewhere the caller never sees.
        raise HTTPException(
            status_code=409,
            detail="Another process is advancing this plan — most likely `goosequill batch run` in a terminal.",
        )

    with _advancing_lock:
        if _advancing.get(plan_id):
            # Two ticks at once would compete for the same allowance, and the
            # plan lock would simply block one of them for no benefit.
            raise HTTPException(status_code=409, detail="This plan is already advancing.")
        _advancing[plan_id] = True

    def worker():
        try:
            if req.retry_blocked:
                planner.reopen_blocked(plan_id)
            if req.retry_failed:
                planner.reopen_failed(plan_id)
            planner.advance(plan_id, only=req.only, max_new=req.max_groups)
        except Exception:
            logger.exception("Advancing plan %s failed", plan_id)
        finally:
            with _advancing_lock:
                _advancing.pop(plan_id, None)

    threading.Thread(target=worker, daemon=True).start()
    return {"status": "advancing", "plan_id": plan_id}


@app.get("/api/search")
def search_documents(
    q: str,
    match_case: bool = False,
    whole_word: bool = False,
    max_documents: int = 100,
    max_matches_per_document: int = 5,
    offset: int = 0,
    include_consolidated: bool = False,
):
    """Search the text of every converted document in the workspace."""
    if len(q or "") > 500:
        raise HTTPException(status_code=400, detail="Search query is too long.")
    return search_service.search(
        BASE_ACCOUNTS_DIR,
        q,
        match_case=match_case,
        whole_word=whole_word,
        max_documents=max(1, min(max_documents, 500)),
        max_matches_per_document=max(1, min(max_matches_per_document, 25)),
        offset=max(0, offset),
        include_consolidated=include_consolidated,
    )


@app.get("/api/download_markdown")
def download_markdown(path: str):
    """Stream a Markdown file from the workspace as a download.

    Exists so the browser never has to hold a consolidated document in memory
    to save it: the file is on disk, and this hands it to the download manager
    a chunk at a time.
    """
    target = _resolve_within_root(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    if target.suffix.lower() != ".md":
        raise HTTPException(status_code=400, detail="Only Markdown files can be downloaded.")

    return FileResponse(target, media_type="text/markdown", filename=target.name)


@app.get("/api/converted_markdowns")
def get_converted_markdowns():
    """Discover all converted markdown files across all folders in workspace."""
    results = doc_repository.get_converted_markdowns(BASE_ACCOUNTS_DIR)
    return {"files": results}

@app.post("/api/combine_markdown")
def combine_markdown(req: CombineMarkdownRequest):
    """Combine multiple markdown files into a single consolidated document."""
    try:
        if not req.files:
            raise HTTPException(status_code=400, detail="No files provided to combine.")

        safe_files = [str(_resolve_within_root(f)) for f in req.files]

        options = dict(
            master_title=req.master_title,
            include_toc=req.include_toc,
            include_source_meta=req.include_source_meta,
            strip_original_headers=req.strip_original_headers,
            sort_mode=req.sort_mode
        )

        target_path = None
        if req.save_to_disk:
            filename = _safe_component(req.output_filename or "Consolidated_Document.md", "Output filename")
            if not filename.lower().endswith(".md"):
                filename += ".md"

            # Consolidated output goes to its own directory rather than in
            # among the transcripts. Written beside them, a consolidation was
            # indistinguishable from a converted document: it counted towards
            # "converted", it appeared in the list of things to consolidate, and
            # its text — which is a copy of text already in the workspace —
            # matched every search twice. Combining a folder then swept up
            # yesterday's combination of that folder, and the file grew each
            # time it was made.
            if req.target_folder and req.target_folder not in ("Root", "General / Root", "All Folders"):
                folder = _safe_component(req.target_folder, "Target folder")
                dest_dir = BASE_ACCOUNTS_DIR / folder / CONSOLIDATED_DIR_NAME
            else:
                dest_dir = BASE_ACCOUNTS_DIR / CONSOLIDATED_DIR_NAME
            dest_dir.mkdir(parents=True, exist_ok=True)
            target_path = dest_dir / filename

        # A build that is only going to disk never needs the finished document
        # in memory, so it is assembled straight onto it. The caller that wants
        # the text back — a preview, which is capped at a handful of documents —
        # still gets the in-memory build.
        if target_path is not None and not req.return_content:
            result = MarkdownCombinerService.combine_to_file(target_path, file_paths=safe_files, **options)
            saved_path = result["saved_path"]
        else:
            result = MarkdownCombinerService.combine(file_paths=safe_files, **options)
            saved_path = None
            if target_path is not None:
                saved_path = str(MarkdownCombinerService.save_combined_document(target_path, result["content"]))

        response = {
            "status": "success",
            "title": result["title"],
            "total_documents": result["total_documents"],
            "total_pages": result["total_pages"],
            "total_words": result["total_words"],
            "total_chars": result["total_chars"],
            "saved_path": saved_path,
            "documents": result["documents"]
        }

        # A whole-workspace consolidation is tens of megabytes. Sending it back
        # so the browser can hold it as a string, hand it to a textarea and
        # split it again is the work this tool exists to avoid doing in a
        # browser. When it has been written to disk the caller can be told
        # where, and stream it from there if it wants it.
        if req.return_content:
            response["content"] = result["content"]

        return response
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in combine_markdown")
        raise HTTPException(status_code=500, detail=str(e))

# ==============================================================================
# DEFLATE
# ==============================================================================

def _summarise_deflate(results: Dict[str, Any]) -> Dict[str, Any]:
    """The parts of a deflation result the browser has any use for.

    The raw result carries the whole fingerprint library — tens of thousands of
    normalised sections and their word sets. That is the working memory of the
    scan, not an answer, and it must not be serialised across the wire.
    """
    scan = results.get("scan", {})
    fingerprints = scan.get("fingerprints", {})
    threshold = results.get("threshold", 2)
    peer_threshold = results.get("peer_threshold", 2)

    patterns = []
    for fp in fingerprints.values():
        if not BoilerplateDetector._is_boilerplate(fp, threshold, peer_threshold):
            continue
        patterns.append({
            "heading": fp.get("heading") or "(untitled)",
            "companies": len(fp.get("entities", ())),
            "filings": len(fp.get("files", ())),
            "words": fp.get("word_count", 0),
            "verdict": fp.get("llm_verdict"),
            "example": (fp.get("raw_example") or "")[:400],
        })
    patterns.sort(key=lambda p: (p["companies"], p["filings"]), reverse=True)

    restatements: Dict[str, int] = {}
    for fr in results.get("file_results", []):
        for r in fr.get("removals", []):
            if r.get("reason") == "restatement":
                restatements[r["heading"]] = restatements.get(r["heading"], 0) + 1

    return {
        "mode": results.get("mode"),
        "threshold": threshold,
        "peer_threshold": peer_threshold,
        "entities_scanned": results.get("entities_scanned", 0),
        "files_scanned": results.get("files_scanned", 0),
        "files_deflated": results.get("files_deflated", 0),
        "total_original_bytes": results.get("total_original_bytes", 0),
        "total_lightweight_bytes": results.get("total_lightweight_bytes", 0),
        "total_reduction_pct": results.get("total_reduction_pct", 0.0),
        "est_tokens_saved": results.get("est_tokens_saved", 0),
        "corpus_too_small": results.get("corpus_too_small", False),
        "verification": results.get("verification"),
        "patterns": patterns[:200],
        "pattern_count": len(patterns),
        "restatements": [
            {"heading": h, "copies": c}
            for h, c in sorted(restatements.items(), key=lambda x: -x[1])
        ],
        "files": [
            {
                "source": fr["source"],
                "name": Path(fr["source"]).name,
                "entity": BoilerplateDetector.entity_for(Path(fr["source"])),
                "output": fr["output"],
                "original_size": fr["original_size"],
                "lightweight_size": fr["lightweight_size"],
                "reduction_pct": fr["reduction_pct"],
                "sections_removed": len(fr.get("sections_removed", [])),
                "written": fr.get("written", False),
            }
            for fr in results.get("file_results", [])
        ],
    }


def run_deflate_task(req: DeflateRequest, targets: List[Path], references: List[Path]):
    """Scan the reference corpus, then rewrite the selected files."""
    global deflate_state
    try:
        def on_progress(info):
            with deflate_lock:
                deflate_state["phase"] = "deflating"
                deflate_state["current_file"] = info.get("current_file", "")
                deflate_state["files_done"] = info.get("current_index", 0)
                deflate_state["total_files"] = info.get("total_files", 0)
                total = info.get("total_files", 0) or 1
                deflate_state["percent"] = round(100.0 * info.get("current_index", 0) / total, 1)

        with deflate_lock:
            deflate_state["phase"] = "scanning"

        results = BoilerplateDetector.deflate_files(
            file_paths=targets,
            reference_paths=references,
            root_dir=BASE_ACCOUNTS_DIR,
            mode=req.mode if req.write else "dry-run",
            threshold=req.threshold,
            peer_threshold=req.peer_threshold,
            similarity=req.similarity,
            model=req.model,
            progress_callback=on_progress,
        )

        report_path = None
        if req.write and req.mode != "dry-run":
            report_path = str(BoilerplateDetector.save_report(
                BASE_ACCOUNTS_DIR, BoilerplateDetector.generate_report(results)
            ))

        summary = _summarise_deflate(results)
        summary["report_path"] = report_path

        with deflate_lock:
            deflate_state["results"] = summary
            deflate_state["error"] = None
    except Exception as e:
        logger.exception("Deflation failed")
        with deflate_lock:
            deflate_state["error"] = str(e)
            deflate_state["results"] = None
    finally:
        with deflate_lock:
            deflate_state["is_running"] = False
            deflate_state["phase"] = "done"
            deflate_state["percent"] = 100.0
            deflate_state["finished_at"] = time.time()


@app.post("/api/deflate")
def start_deflate(req: DeflateRequest):
    """Begin a deflation run in the background."""
    global deflate_state

    with deflate_lock:
        if deflate_state["is_running"]:
            raise HTTPException(status_code=409, detail="A deflation is already running.")

    if not req.files:
        raise HTTPException(status_code=400, detail="No documents selected to deflate.")

    targets: List[Path] = []
    for raw in req.files:
        path = _resolve_within_root(raw)
        if is_consolidated(path) or is_lightweight(path):
            # Both are copies of transcripts already in the workspace. Deflating
            # one produces a lightweight copy of a copy.
            continue
        if path.suffix.lower() != ".md" or not path.is_file():
            continue
        targets.append(path)

    if not targets:
        raise HTTPException(
            status_code=400,
            detail="None of the selected files are transcripts that can be deflated."
        )

    if req.compare_against_selection:
        references = list(targets)
    else:
        references = [
            Path(info["path"])
            for info in doc_repository.get_converted_markdowns(BASE_ACCOUNTS_DIR)
            if not info.get("is_consolidated")
            and not is_lightweight(Path(info["path"]))
            and "Markdown" in Path(info["path"]).parts
            and not Path(info["path"]).name.endswith("_Index.md")
        ]

    with deflate_lock:
        deflate_state.update({
            "is_running": True,
            "phase": "scanning",
            "current_file": "",
            "files_done": 0,
            "total_files": len(targets),
            "percent": 0.0,
            "error": None,
            "results": None,
            "started_at": time.time(),
            "finished_at": None,
        })

    threading.Thread(
        target=run_deflate_task, args=(req, targets, references), daemon=True
    ).start()

    return {
        "status": "started",
        "targets": len(targets),
        "references": len(references),
    }


@app.get("/api/deflate/status")
def get_deflate_status():
    """Poll the running (or last finished) deflation."""
    with deflate_lock:
        return dict(deflate_state)


@app.get("/api/deflate/candidates")
def get_deflate_candidates():
    """Every transcript that can be deflated, with what it currently costs.

    Sizes are here so the interface can price a selection before running
    anything: the question this view exists to answer is whether a set of
    filings will fit somewhere, and that has to be answerable up front.
    """
    files = []
    for info in doc_repository.get_converted_markdowns(BASE_ACCOUNTS_DIR):
        path = Path(info["path"])
        if info.get("is_consolidated") or is_lightweight(path):
            continue
        # Only actual transcripts. Loose Markdown at the workspace root — notes,
        # extracts, a previous run's report — is not a filing of anything, and
        # offering it here invites a "company" called Accounts.
        if "Markdown" not in path.parts or path.name.endswith("_Index.md"):
            continue
        entity = BoilerplateDetector.entity_for(path)
        lightweight = path.parent.parent / LIGHTWEIGHT_DIR_NAME / path.name
        files.append({
            "path": info["path"],
            "name": info.get("name") or path.name,
            "stem": info.get("stem") or path.stem,
            "entity": entity,
            "peer_group": BoilerplateDetector.peer_group_for(entity),
            "size": info.get("size", 0),
            "deflated_size": lightweight.stat().st_size if lightweight.is_file() else None,
            "deflated_path": str(lightweight) if lightweight.is_file() else None,
        })
    files.sort(key=lambda f: (f["entity"].lower(), f["name"].lower()))
    return {"files": files}


# ==============================================================================
# THE PAGE
# ==============================================================================
#
# index.html was 1,143 lines holding six views and four dialogs, which made it
# the last place in the codebase where everything lived together. The views are
# separate files now, and this stitches them back into one document at request
# time.
#
# Composing on the server rather than fetching partials from the browser keeps
# it a single response — no extra round trips, no flash of a half-built page,
# and nothing for the frontend to know about.

_INCLUDE_RE = re.compile(r'^([ \t]*)<!--#include file="([^"]+)"\s*-->[ \t]*$', re.MULTILINE)

# path -> (mtime_ns, text). Rebuilt when any part of the page changes, so
# editing a view is visible on reload without restarting anything.
_page_cache: Dict[str, Any] = {"signature": None, "html": None}


def _page_parts() -> List[Path]:
    shell = WEB_DIR / "index.html"
    return [shell] + sorted((WEB_DIR / "views").glob("*.html")) + sorted((WEB_DIR / "modals").glob("*.html"))


def _page_signature() -> tuple:
    signature = []
    for part in _page_parts():
        try:
            signature.append((str(part), part.stat().st_mtime_ns))
        except OSError:
            signature.append((str(part), None))
    return tuple(signature)


def compose_index_html() -> str:
    """Build index.html from its shell and the view files it includes."""
    signature = _page_signature()
    if _page_cache["signature"] == signature and _page_cache["html"] is not None:
        return _page_cache["html"]

    shell = (WEB_DIR / "index.html").read_text(encoding="utf-8")

    def replace(match: "re.Match") -> str:
        relative = match.group(2)
        # Includes name files inside web/; nothing else is reachable.
        part = (WEB_DIR / relative).resolve()
        if not str(part).startswith(str(WEB_DIR.resolve())) or not part.is_file():
            logger.error("Unknown include in index.html: %s", relative)
            return f"<!-- missing include: {relative} -->"
        # Spliced verbatim: the parts keep the indentation they were cut with,
        # so the assembled document is the file that was split, not a
        # re-formatted approximation of it. The marker's own indent is ignored.
        return part.read_text(encoding="utf-8").rstrip("\n")

    html = _INCLUDE_RE.sub(replace, shell)
    _page_cache["signature"] = signature
    _page_cache["html"] = html
    return html


@app.get("/", include_in_schema=False)
def index_page():
    return HTMLResponse(compose_index_html())


@app.get("/index.html", include_in_schema=False)
def index_page_explicit():
    return HTMLResponse(compose_index_html())


# Everything else in web/ is served as-is. Mounted last so the routes above win.
WEB_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")

if __name__ == "__main__":
    import uvicorn

    # Loopback by default: the API has no authentication and can read and write
    # inside the documents folder, so it must not be reachable from the network.
    # Override only if you understand that exposure (e.g. behind your own auth proxy).
    host = os.environ.get("GOOSEQUILL_HOST", "127.0.0.1")
    # Deliberately not falling back to $PORT. It is the most collided-on
    # variable there is — Rails, Node, Heroku, direnv all set it — and this app
    # binds loopback and is started by hand, so honouring a stray one would
    # only mean binding somewhere the person running it did not expect, and
    # somewhere launch.sh is not looking. GOOSEQUILL_PORT is the way to move it.
    port = int(os.environ.get("GOOSEQUILL_PORT", "8000"))
    reload_enabled = os.environ.get("GOOSEQUILL_RELOAD", "0") == "1"

    if host not in ("127.0.0.1", "localhost", "::1"):
        logger.warning(
            "Binding to %s exposes an unauthenticated API to your network. "
            "Only do this behind a trusted proxy.", host
        )

    print(f"Starting GooseQuill on http://{host}:{port} ...")
    if reload_enabled:
        print("Auto-reload is on: the server restarts when Python changes. Frontend edits need only a browser refresh.")

    options = {"host": host, "port": port, "reload": reload_enabled}

    if reload_enabled:
        # Watch the Python package and this file — not the working directory,
        # which is uvicorn's default and which here contains the documents
        # folder and the page cache.
        #
        # No reload_includes/excludes: without watchfiles installed uvicorn
        # falls back to StatReload, which ignores them and watches only *.py.
        # That is the behaviour wanted anyway. Frontend files need no reload at
        # all — they are served from disk, and the composed page is cached
        # against its parts' mtimes — so editing a view or a stylesheet shows up
        # on a browser refresh with the server left alone.
        options["reload_dirs"] = [str(PROJECT_ROOT / "goosequill"), str(PROJECT_ROOT)]

    uvicorn.run("app:app", **options)

