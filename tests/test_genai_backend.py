"""Backend selection: Gemini Developer API vs Vertex AI.

The choice is a data-residency decision, so the failure modes that matter are
the quiet ones — silently falling back to the global endpoint when Vertex was
asked for, or guessing a region the user did not choose.
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.genai_factory import (
    DEFAULT_VERTEX_HOST, BackendInfo, build_client, resolve_api_key,
    vertex_enabled
)
from goosequill.services.batch_service import BatchService

# load_dotenv() would pull the developer's real .env into these tests.
VERTEX_VARS = ("GOOSEQUILL_USE_VERTEX", "GOOGLE_GENAI_USE_VERTEXAI",
               "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
               "GOOSEQUILL_VERTEX_HOST")
KEY_VARS = ("PDF_MARKDOWN_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
            "VERTEX_API_KEY")


def clean_env(**overrides):
    """A patched environment with every backend variable removed first."""
    env = {k: v for k, v in os.environ.items()
           if k not in VERTEX_VARS + KEY_VARS}
    env.update(overrides)
    return mock.patch.dict(os.environ, env, clear=True)


class TestBackendSelection(unittest.TestCase):

    def setUp(self):
        # The factory calls load_dotenv(), which would reintroduce the real .env.
        patcher = mock.patch("goosequill.services.genai_factory.load_dotenv",
                             lambda *a, **k: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_defaults_to_gemini_api(self):
        with clean_env(GEMINI_API_KEY="test-key"):
            self.assertFalse(vertex_enabled())
            _, info = build_client()
            self.assertFalse(info.vertex)
            self.assertFalse(info.region_is_pinned)

    def test_vertex_enabled_by_either_flag(self):
        for flag in ("GOOSEQUILL_USE_VERTEX", "GOOGLE_GENAI_USE_VERTEXAI"):
            for value in ("1", "true", "TRUE", "yes", "on"):
                with clean_env(**{flag: value}):
                    self.assertTrue(vertex_enabled(), f"{flag}={value}")

    def test_vertex_defaults_to_the_eu_multi_region(self):
        """The default must be the EEA endpoint, and the EU *multi-region* —
        several Flash-Lite models have no single-region availability at all."""
        with clean_env(GOOSEQUILL_USE_VERTEX="1",
                       GOOGLE_CLOUD_PROJECT="my-project",
                       VERTEX_API_KEY="k"):
            _, info = build_client()
            self.assertTrue(info.vertex)
            self.assertTrue(info.region_is_pinned)
            self.assertEqual(info.location, "eu")
            self.assertEqual(info.host, DEFAULT_VERTEX_HOST)
            # `.rep.` is the residency endpoint; a `{region}-` prefix is not.
            self.assertIn(".rep.", info.host)

    def test_vertex_builds_the_residency_url(self):
        """The request must actually address the residency host and project."""
        with clean_env(GOOSEQUILL_USE_VERTEX="1",
                       GOOGLE_CLOUD_PROJECT="my-project",
                       VERTEX_API_KEY="k"):
            client, _ = build_client()
            url = client._api_client._build_request(
                "post", "{model}:generateContent", {"model": "m"}, None).url
            self.assertIn("aiplatform.eu.rep.googleapis.com", url)
            self.assertIn("projects/my-project/locations/eu", url)

    def test_vertex_host_and_location_are_overridable(self):
        with clean_env(GOOSEQUILL_USE_VERTEX="1",
                       GOOGLE_CLOUD_PROJECT="my-project",
                       GOOGLE_CLOUD_LOCATION="us",
                       GOOSEQUILL_VERTEX_HOST="https://aiplatform.us.rep.googleapis.com",
                       VERTEX_API_KEY="k"):
            _, info = build_client()
            self.assertEqual(info.location, "us")
            self.assertIn("us.rep", info.host)

    def test_vertex_requires_a_project(self):
        with clean_env(GOOSEQUILL_USE_VERTEX="1", VERTEX_API_KEY="k"):
            with self.assertRaises(ValueError) as ctx:
                build_client()
            self.assertIn("GOOGLE_CLOUD_PROJECT", str(ctx.exception))

    def test_vertex_never_falls_back_to_the_global_endpoint(self):
        """A misconfigured Vertex setup must fail loudly. Falling back would
        move documents out of the chosen territory with nobody noticing."""
        with clean_env(GOOSEQUILL_USE_VERTEX="1", GEMINI_API_KEY="test-key"):
            with self.assertRaises(ValueError) as ctx:
                build_client()
            self.assertIn("GOOGLE_CLOUD_PROJECT", str(ctx.exception))

    def test_vertex_prefers_its_own_key(self):
        """A project-scoped Vertex key must not be shadowed by an unrelated
        Gemini API key sitting in the same .env."""
        with clean_env(GOOSEQUILL_USE_VERTEX="1",
                       GOOGLE_CLOUD_PROJECT="my-project",
                       VERTEX_API_KEY="vertex-key",
                       GEMINI_API_KEY="gemini-key"):
            self.assertEqual(resolve_api_key(vertex=True), "vertex-key")

    def test_missing_key_is_reported_clearly(self):
        with clean_env():
            with self.assertRaises(ValueError) as ctx:
                build_client()
            self.assertIn("PDF_MARKDOWN_KEY", str(ctx.exception))

    def test_key_resolution_order(self):
        with clean_env(PDF_MARKDOWN_KEY="first", GEMINI_API_KEY="second"):
            self.assertEqual(resolve_api_key(), "first")
        with clean_env(GEMINI_API_KEY="second", GOOGLE_API_KEY="third"):
            self.assertEqual(resolve_api_key(), "second")
        with clean_env(GEMINI_API_KEY="second"):
            self.assertEqual(resolve_api_key("explicit"), "explicit")

    def test_backend_info_never_carries_a_credential(self):
        with clean_env(GEMINI_API_KEY="super-secret-key"):
            _, info = build_client()
            serialised = str(info.to_dict()) + info.label
            self.assertNotIn("super-secret-key", serialised)


class TestBatchOnVertex(unittest.TestCase):
    """Batch uses the File API, which Vertex does not offer."""

    def setUp(self):
        patcher = mock.patch("goosequill.services.genai_factory.load_dotenv",
                             lambda *a, **k: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_batch_refuses_early_and_explains(self):
        with clean_env(GOOSEQUILL_USE_VERTEX="1",
                       GOOGLE_CLOUD_PROJECT="my-project",
                       GOOGLE_CLOUD_LOCATION="europe-west4"):
            service = BatchService()
            with self.assertRaises(ValueError) as ctx:
                service.create_batch_job(pdf_paths=["/nonexistent.pdf"])
            msg = str(ctx.exception)
            self.assertIn("not available on Vertex", msg)
            # The message must say what to do, not merely what failed.
            self.assertIn("GOOSEQUILL_USE_VERTEX", msg)

    def test_batch_endpoint_returns_400_not_500(self):
        """An unsupported backend is the caller's to fix, so it must not be
        reported as a server fault."""
        from starlette.testclient import TestClient
        with clean_env(GOOSEQUILL_USE_VERTEX="1",
                       GOOGLE_CLOUD_PROJECT="my-project",
                       VERTEX_API_KEY="k"):
            import app as app_module
            # Path containment runs before the backend guard, so the probe file
            # must sit inside whichever root the app is actually serving.
            root = Path(app_module.BASE_ACCOUNTS_DIR)
            root.mkdir(parents=True, exist_ok=True)
            target = root / "batch_guard_probe.pdf"
            target.write_bytes(b"%PDF-1.4\n")
            try:
                with TestClient(app_module.app) as client:
                    res = client.post("/api/batch/create",
                                      json={"files": [str(target.resolve())]})
                self.assertEqual(res.status_code, 400)
                self.assertIn("not available on Vertex", res.json()["detail"])
            finally:
                target.unlink(missing_ok=True)

    def test_batch_allowed_on_gemini_api(self):
        with clean_env(GEMINI_API_KEY="test-key"):
            service = BatchService()
            service._require_batch_support()  # must not raise


if __name__ == "__main__":
    unittest.main()


class TestFirstRunWithoutAKey(unittest.TestCase):
    """A missing key is where every new user starts, and most of the app works
    without one. It must not present as a fault."""

    def setUp(self):
        patcher = mock.patch("goosequill.services.genai_factory.load_dotenv",
                             lambda *a, **k: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        # ocr_client calls load_dotenv itself, which would reload a real .env
        # and hand the test a working key.
        patcher2 = mock.patch("goosequill.services.ocr_client.load_dotenv",
                              lambda *a, **k: None)
        patcher2.start()
        self.addCleanup(patcher2.stop)

    def test_missing_key_is_reported_as_a_state_not_a_fault(self):
        from starlette.testclient import TestClient
        import app as app_module
        with clean_env():
            with TestClient(app_module.app) as client:
                data = client.get("/api/test_connection").json()
        self.assertEqual(data["error_type"], "NO_KEY")
        # The interface uses this to say what the user can still do.
        self.assertIn("Markdown Combiner", data["offline_features"])

    def test_the_combiner_endpoints_work_without_a_key(self):
        """The whole point: someone who only wants to combine markdown should
        never need a key."""
        from starlette.testclient import TestClient
        import app as app_module
        with clean_env():
            with TestClient(app_module.app) as client:
                for path in ("/api/documents", "/api/converted_markdowns",
                             "/api/job_status", "/api/backend"):
                    res = client.get(path)
                    self.assertEqual(res.status_code, 200, f"{path} broke without a key")
