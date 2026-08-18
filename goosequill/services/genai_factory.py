"""Construct the Google GenAI client for whichever backend is configured.

GooseQuill talks to Gemini through one of two backends, and the choice is a
data-residency decision rather than a performance one.

**Gemini Developer API** (the default) — an API key and nothing else. Requests
go to Google's global endpoint, so you do not choose where your documents are
processed.

**Vertex AI on a residency endpoint** — an API key plus a Google Cloud project,
addressed through a hostname that carries a processing commitment for a
territory. The default here is the EU multi-region,
`https://aiplatform.eu.rep.googleapis.com`, which keeps processing inside the
EEA.

Two details about that endpoint are easy to get wrong and expensive to
discover late:

* **It must be the *multi-region*, not a single region.** Note the hostname
  shape — `.rep.`, rather than a `{region}-` prefix. Several Flash-Lite models
  are served in the US and EU multi-regions only, with no single-region
  availability anywhere, so pinning to `europe-west4` can fail to serve a model
  that `eu` serves fine.
* **Auth is a plain API key.** No service account, no signed assertion. The key
  must belong to the Cloud project named below.

**There is deliberately no fallback from Vertex to the global endpoint.** A
silent fallback would send documents outside the territory you selected while
everything appeared to work, which is precisely the failure a residency
endpoint is chosen to prevent. A misconfiguration raises instead.

The rest of the codebase never branches on which backend is in use. It asks
here for a client and gets one.
"""

import os
import logging
from dataclasses import dataclass
from typing import Optional

from dotenv import load_dotenv
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

_TRUTHY = {"1", "true", "yes", "on"}

# Google's EU multi-region residency endpoint. Overridable for other
# territories — `https://aiplatform.us.rep.googleapis.com` is the US
# equivalent — but the EEA one is the default because it is the reason this
# backend exists.
DEFAULT_VERTEX_HOST = "https://aiplatform.eu.rep.googleapis.com"
DEFAULT_VERTEX_LOCATION = "eu"

_MISSING_PROJECT = (
    "Vertex AI is enabled but no project is set. Add GOOGLE_CLOUD_PROJECT to "
    "your .env — the project ID (like 'gen-lang-client-0123456789'), not its "
    "display name. The API key you use must belong to that project."
)
_MISSING_KEY = (
    "No API key found. Set PDF_MARKDOWN_KEY, GEMINI_API_KEY or GOOGLE_API_KEY "
    "in .env or the environment."
)
_MISSING_VERTEX_KEY = (
    "Vertex AI is enabled but no API key was found. Set VERTEX_API_KEY (or "
    "PDF_MARKDOWN_KEY / GEMINI_API_KEY / GOOGLE_API_KEY) to a key belonging to "
    "the project in GOOGLE_CLOUD_PROJECT. GooseQuill will not fall back to the "
    "global endpoint, because that would move your documents out of the "
    "territory you selected without telling you."
)


@dataclass(frozen=True)
class BackendInfo:
    """Which backend is in use, in a form safe to show a user or log.

    Deliberately carries no credential: an API key must never reach the UI, a
    log line, or an API response.
    """
    vertex: bool
    project: Optional[str] = None
    location: Optional[str] = None
    host: Optional[str] = None

    @property
    def label(self) -> str:
        if self.vertex:
            return f"Vertex AI — {self.location} ({self.project})"
        return "Gemini Developer API (global endpoint)"

    @property
    def region_is_pinned(self) -> bool:
        """True when processing is confined to a territory the user selected."""
        return self.vertex and bool(self.location)

    @property
    def residency_note(self) -> str:
        if self.vertex:
            return (f"Documents are processed in the {self.location} "
                    f"multi-region, via {self.host}.")
        return ("Documents are processed on Google's global endpoint, which "
                "makes no commitment about where.")

    def to_dict(self) -> dict:
        return {
            "backend": "vertex" if self.vertex else "gemini_api",
            "label": self.label,
            "project": self.project,
            "location": self.location,
            "host": self.host,
            "region_pinned": self.region_is_pinned,
            "residency_note": self.residency_note,
        }


def vertex_enabled() -> bool:
    """Is Vertex AI selected? Accepts our own flag or Google's standard one."""
    load_dotenv()
    for var in ("GOOSEQUILL_USE_VERTEX", "GOOGLE_GENAI_USE_VERTEXAI"):
        if os.environ.get(var, "").strip().lower() in _TRUTHY:
            return True
    return False


def resolve_api_key(explicit: Optional[str] = None, vertex: bool = False) -> Optional[str]:
    """Find the API key, in the order the README documents.

    VERTEX_API_KEY comes first in Vertex mode so a project-scoped key can sit
    alongside an unrelated Gemini API key without either shadowing the other.
    """
    load_dotenv()
    names = ("PDF_MARKDOWN_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY")
    if vertex:
        names = ("VERTEX_API_KEY",) + names
    if explicit:
        return explicit
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def build_client(api_key: Optional[str] = None) -> tuple[genai.Client, BackendInfo]:
    """Build a client for the configured backend, with its description.

    Raises ValueError with an actionable message rather than letting the SDK
    fail later, or worse, succeed against the wrong endpoint.
    """
    load_dotenv()

    if vertex_enabled():
        project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
        if not project:
            raise ValueError(_MISSING_PROJECT)

        location = os.environ.get("GOOGLE_CLOUD_LOCATION", "").strip() \
            or DEFAULT_VERTEX_LOCATION
        host = os.environ.get("GOOSEQUILL_VERTEX_HOST", "").strip() \
            or DEFAULT_VERTEX_HOST

        key = resolve_api_key(api_key, vertex=True)
        if not key:
            raise ValueError(_MISSING_VERTEX_KEY)

        client = genai.Client(
            vertexai=True,
            api_key=key,
            project=project,
            location=location,
            http_options=types.HttpOptions(base_url=host),
        )
        info = BackendInfo(vertex=True, project=project, location=location,
                           host=host)
        logger.info("Using %s", info.label)
        return client, info

    key = resolve_api_key(api_key)
    if not key:
        raise ValueError(_MISSING_KEY)
    client = genai.Client(api_key=key)
    info = BackendInfo(vertex=False)
    logger.info("Using %s", info.label)
    return client, info


def describe_backend() -> dict:
    """Describe the configured backend without building a client or touching a
    credential.

    Used by the UI and the /api/backend endpoint. It lives here so there is one
    definition of what "which backend" means — a second copy in the web layer
    would drift the moment a default changed.
    """
    load_dotenv()
    if not vertex_enabled():
        return BackendInfo(vertex=False).to_dict()
    return BackendInfo(
        vertex=True,
        project=os.environ.get("GOOGLE_CLOUD_PROJECT") or None,
        location=os.environ.get("GOOGLE_CLOUD_LOCATION") or DEFAULT_VERTEX_LOCATION,
        host=os.environ.get("GOOSEQUILL_VERTEX_HOST") or DEFAULT_VERTEX_HOST,
    ).to_dict()
