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
        """Test /api/set_root_folder switches documents directory with valid folder."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp_dir:
            res = self.client.post("/api/set_root_folder", json={"root_path": tmp_dir})
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertEqual(data["status"], "success")
            self.assertEqual(data["root_directory"], str(Path(tmp_dir).resolve()))

        # Invalid path should return 400
        res_bad = self.client.post("/api/set_root_folder", json={"root_path": "/nonexistent/path/12345"})
        self.assertEqual(res_bad.status_code, 400)

if __name__ == "__main__":
    unittest.main()

