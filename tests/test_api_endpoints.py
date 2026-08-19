import os
import sys
from pathlib import Path
import unittest
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fixtures import SAMPLE_MARKDOWN
from starlette.testclient import TestClient
import app as app_module
from app import app, PRICING

class TestApiEndpoints(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_favicon_endpoint(self):
        """Test /favicon.ico returns 200 OK and image/svg+xml."""
        res = self.client.get("/favicon.ico")
        self.assertEqual(res.status_code, 200)
        self.assertIn("image/svg+xml", res.headers.get("content-type", ""))
        self.assertIn("<svg", res.text)

    def test_documents_endpoint(self):
        """Test /api/documents returns folders, stats, and pricing data."""
        res = self.client.get("/api/documents?model=gemini-3.1-flash-lite")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("folders", data)
        self.assertIn("stats", data)
        self.assertIn("pricing", data)
        self.assertIn("presets", data)

        stats = data["stats"]
        self.assertIn("est_input_tokens", stats)
        self.assertIn("est_output_tokens", stats)
        self.assertIn("est_total_tokens", stats)
        self.assertIn("est_cost_standard_usd", stats)
        self.assertIn("est_cost_batch_usd", stats)

    def test_batch_jobs_endpoint(self):
        """Test /api/batch/jobs returns jobs list."""
        res = self.client.get("/api/batch/jobs")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("jobs", data)

    def test_job_status_endpoint(self):
        """Test /api/job_status returns running state dictionary."""
        res = self.client.get("/api/job_status")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("is_running", data)
        self.assertIn("percent", data)

    def test_pricing_models_covered(self):
        """Test all 10 Google Gemini models exist in pricing configuration."""
        expected_models = [
            "gemini-3.1-flash-lite",
            "gemini-3.5-flash-lite",
            "gemini-3.7-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash",
            "gemini-3-flash-preview",
            "gemini-3.1-pro-preview",
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
        ]
        for m in expected_models:
            self.assertIn(m, PRICING, f"Model {m} missing from PRICING rate card")

    def test_sync_pricing_endpoint(self):
        """Test /api/sync_pricing endpoint returns structured response with pricing dict.

        Google's live docs are stubbed here so the suite stays fast and works
        offline. See tests/test_pricing_live.py for the opt-in check that the
        real document still parses.
        """
        class _StubResponse:
            status_code = 200
            text = SAMPLE_MARKDOWN

        with mock.patch("goosequill.services.pricing_sync.requests.get",
                        return_value=_StubResponse()) as fetch:
            res = self.client.post("/api/sync_pricing")
            self.assertTrue(fetch.called, "endpoint should fetch the pricing document")

        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "success")
        self.assertIn("pricing", data)
        self.assertIn("gemini-3.1-flash-lite", data["pricing"])
        self.assertEqual(data["pricing"]["gemini-3.1-flash-lite"]["input_standard"], 0.25)

    def test_sync_pricing_survives_upstream_failure(self):
        """A dead or changed upstream must degrade gracefully, never 500."""
        with mock.patch("goosequill.services.pricing_sync.requests.get",
                        side_effect=Exception("network down")):
            res = self.client.post("/api/sync_pricing")

        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "error")
        # Bundled rates must still be served so the app stays usable offline.
        self.assertIn("gemini-3.1-flash-lite", data["pricing"])

    def test_chrome_devtools_probe(self):
        """Test /.well-known/appspecific/com.chrome.devtools.json returns 204 No Content."""
        res = self.client.get("/.well-known/appspecific/com.chrome.devtools.json")
        self.assertEqual(res.status_code, 204)

    def test_set_root_folder_endpoint(self):
        """Test /api/set_root_folder switches documents directory with valid folder.

        The root is module-level state on the app, so this puts it back. Left
        pointing at a deleted temporary directory it made every later test that
        touches a real path fail with 403 — the failure looked like a broken
        path guard rather than a test that had not tidied up after itself.
        """
        import tempfile
        original_root = app_module.BASE_ACCOUNTS_DIR
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                res = self.client.post("/api/set_root_folder", json={"root_path": tmp_dir})
                self.assertEqual(res.status_code, 200)
                data = res.json()
                self.assertEqual(data["status"], "success")
                self.assertEqual(data["root_directory"], str(Path(tmp_dir).resolve()))

            # Invalid path should return 400
            res_bad = self.client.post("/api/set_root_folder", json={"root_path": "/nonexistent/path/12345"})
            self.assertEqual(res_bad.status_code, 400)
        finally:
            app_module.BASE_ACCOUNTS_DIR = original_root


class TestDownloadMarkdown(unittest.TestCase):
    """The download route hands a file straight out of the workspace.

    That makes its two guards the interesting part: it must not serve anything
    outside the documents folder, and it must not serve anything that is not a
    Markdown file.
    """

    def setUp(self):
        self.client = TestClient(app)

    def test_refuses_a_path_outside_the_workspace(self):
        res = self.client.get("/api/download_markdown", params={"path": "/etc/passwd"})
        self.assertEqual(res.status_code, 403)

    def test_refuses_traversal_out_of_the_workspace(self):
        escape = str(app_module.BASE_ACCOUNTS_DIR / ".." / ".." / "etc" / "passwd")
        res = self.client.get("/api/download_markdown", params={"path": escape})
        self.assertEqual(res.status_code, 403)

    def test_refuses_a_non_markdown_file(self):
        target = app_module.BASE_ACCOUNTS_DIR / "download_guard_test.txt"
        target.write_text("not markdown", encoding="utf-8")
        try:
            res = self.client.get("/api/download_markdown", params={"path": str(target)})
            self.assertEqual(res.status_code, 400)
        finally:
            target.unlink(missing_ok=True)

    def test_missing_file_is_a_404(self):
        res = self.client.get(
            "/api/download_markdown",
            params={"path": str(app_module.BASE_ACCOUNTS_DIR / "definitely_not_here.md")}
        )
        self.assertEqual(res.status_code, 404)

    def test_serves_a_markdown_file_as_a_download(self):
        target = app_module.BASE_ACCOUNTS_DIR / "download_guard_test.md"
        target.write_text("# Hello\n\nBody.\n", encoding="utf-8")
        try:
            res = self.client.get("/api/download_markdown", params={"path": str(target)})
            self.assertEqual(res.status_code, 200)
            self.assertIn("text/markdown", res.headers.get("content-type", ""))
            self.assertIn("attachment", res.headers.get("content-disposition", ""))
            self.assertIn("# Hello", res.text)
        finally:
            target.unlink(missing_ok=True)


class TestComposedIndexPage(unittest.TestCase):
    """index.html is assembled from its parts at request time.

    A missing or renamed partial would otherwise fail quietly, leaving a comment
    where a whole view should be.
    """

    def setUp(self):
        self.client = TestClient(app)

    def test_every_view_and_dialog_is_present(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        html = res.text

        for element_id in (
            "viewWorkspace", "viewStudio", "viewSearch",
            "viewCombiner", "viewBatches", "viewEconomics",
            "uploadModal", "settingsModal", "logsModal", "newFolderModal",
        ):
            self.assertIn(f'id="{element_id}"', html, f"{element_id} missing from the composed page")

    def test_no_include_is_left_unresolved(self):
        html = self.client.get("/").text
        self.assertNotIn("#include", html, "an include marker survived composition")
        self.assertNotIn("missing include", html, "an include named a file that is not there")

if __name__ == "__main__":
    unittest.main()

