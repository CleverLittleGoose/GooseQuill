import time
import logging
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)

@dataclass
class JobProgress:
    file_name: str
    file_path: str
    current_page: int
    total_pages: int
    percent: float
    status: str = "processing"
    warning_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class JobState:
    is_running: bool = False
    current_file: str = ""
    current_folder: str = ""
    current_page: int = 0
    total_pages: int = 0
    percent: float = 0.0
    files_done: int = 0
    total_files: int = 0
    logs: List[str] = field(default_factory=list)
    errors: List[Dict[str, Any]] = field(default_factory=list)
    warning_message: Optional[str] = None
    error: Optional[str] = None

    def add_log(self, msg: str):
        self.logs.append(msg)
        if len(self.logs) > 150:
            self.logs = self.logs[-150:]

    def add_error(self, file_name: str, page: Optional[int], message: str):
        err_entry = {
            "file_name": file_name,
            "page": page,
            "message": message,
            "time": time.strftime("%H:%M:%S")
        }
        self.errors.append(err_entry)
        self.add_log(f"[ERROR] {file_name} (Page {page or 'N/A'}): {message}")

    def reset(self, total_files: int = 0):
        self.is_running = True
        self.current_file = ""
        self.current_folder = ""
        self.current_page = 0
        self.total_pages = 0
        self.percent = 0.0
        self.files_done = 0
        self.total_files = total_files
        self.warning_message = None
        self.error = None

    def finish(self):
        self.is_running = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "is_running": self.is_running,
            "current_file": self.current_file,
            "current_folder": self.current_folder,
            "current_page": self.current_page,
            "total_pages": self.total_pages,
            "percent": self.percent,
            "files_done": self.files_done,
            "total_files": self.total_files,
            "logs": self.logs,
            "errors": self.errors,
            "warning_message": self.warning_message,
            "error": self.error
        }

@dataclass
class BatchJobRecord:
    id: str
    gemini_job_name: str
    display_name: str
    model: str
    uploaded_file: str
    total_documents: int
    total_requests: int
    submitted_at: float
    status: str = "JOB_STATE_PENDING"
    completed_at: Optional[float] = None
    output_file: Optional[str] = None
    error_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
