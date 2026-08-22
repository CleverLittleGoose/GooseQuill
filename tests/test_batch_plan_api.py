"""The HTTP surface over batch plans.

A plan is long-running and shared: the CLI and the browser drive the same file
on disk. These tests hold the endpoints to that — creating a plan submits
nothing, a step returns before the work finishes rather than holding the
request open for an upload, and two steps cannot run at once.
"""

import os
import sys
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from starlette.testclient import TestClient
import app as app_module
from app import app
from goosequill.services.cache_manager import CacheManager


class TestBatchPlanApi(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gq_planapi_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        self.root = self.tmp / "workspace"
        folder = self.root / "Acme Holdings Limited"
        folder.mkdir(parents=True)
        for year in (2023, 2024):
            (folder / f"Acme Holdings Limited - Annual Report {year}.pdf").write_bytes(b"%PDF-1.4\n")

        # Point the app at a scratch workspace and a scratch cache, so a test
        # run never plans over — or writes into — the developer's own corpus.
        self.saved_root = app_module.BASE_ACCOUNTS_DIR
        self.saved_cache = app_module.cache_manager
        app_module.BASE_ACCOUNTS_DIR = self.root
        app_module.cache_manager = CacheManager(cache_dir=self.tmp / ".cache")
        self.addCleanup(self._restore)

        patcher = mock.patch("goosequill.services.pdf_renderer.PDFRenderer.get_page_count",
                             staticmethod(lambda path: 4))
        patcher.start()
        self.addCleanup(patcher.stop)

        env = mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False)
        env.start()
        self.addCleanup(env.stop)

        self.client = TestClient(app)

    def _restore(self):
        app_module.BASE_ACCOUNTS_DIR = self.saved_root
        app_module.cache_manager = self.saved_cache

    def _create(self, **body):
        return self.client.post("/api/batch/plans", json=body)

    # ------------------------------------------------------------------

    def test_creating_a_plan_groups_the_corpus_and_submits_nothing(self):
        res = self._create(model="gemini-3.5-flash-lite")
        self.assertEqual(res.status_code, 200)
        payload = res.json()

        groups = payload["plan"]["groups"]
        self.assertEqual([g["name"] for g in groups], ["Acme Holdings Limited"])
        self.assertEqual(groups[0]["pages"], 8)
        self.assertTrue(all(g["state"] == "pending" for g in groups))
        self.assertIsNone(groups[0]["job_id"], "creating a plan must not submit")
        self.assertEqual(payload["summary"]["done_pages"], 0)

    def test_a_plan_appears_in_the_listing_and_can_be_read_back(self):
        plan_id = self._create().json()["plan"]["id"]

        listing = self.client.get("/api/batch/plans").json()["plans"]
        self.assertIn(plan_id, [p["id"] for p in listing])

        detail = self.client.get(f"/api/batch/plans/{plan_id}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["plan"]["id"], plan_id)
        self.assertFalse(detail.json()["advancing"])

    def test_an_unknown_plan_is_a_404(self):
        res = self.client.get("/api/batch/plans/plan_00000000_000000")
        self.assertEqual(res.status_code, 404)

    def test_a_plan_id_cannot_walk_out_of_the_plans_directory(self):
        res = self.client.get("/api/batch/plans/..%2F..%2Fetc%2Fpasswd")
        self.assertIn(res.status_code, (400, 404), f"got {res.status_code}")

    def test_a_root_outside_the_workspace_is_refused(self):
        res = self._create(root="/etc")
        self.assertEqual(res.status_code, 403)

    def test_named_files_outside_the_workspace_are_refused(self):
        res = self._create(files=["/etc/passwd"])
        self.assertEqual(res.status_code, 403)

    def test_a_plan_can_be_restricted_to_named_documents(self):
        one = next((self.root / "Acme Holdings Limited").glob("*.pdf"))
        payload = self._create(files=[str(one)]).json()
        groups = payload["plan"]["groups"]
        self.assertEqual(len(groups), 1)
        # Paths come back resolved, because containment is checked on the
        # resolved path — on macOS that turns /var into /private/var.
        self.assertEqual(groups[0]["files"], [str(one.resolve())])
        self.assertEqual(groups[0]["pages"], 4, "only the named document")

    def test_advancing_returns_before_the_work_finishes(self):
        """A step renders and uploads. The request must not wait for that."""
        import threading as _t
        started, release = _t.Event(), _t.Event()

        def slow_advance(self_, plan_id, on_event=None, only=None, max_new=None):
            started.set()
            release.wait(5)
            return {"id": plan_id, "groups": []}

        with mock.patch.object(app_module.BatchPlanner, "advance", slow_advance):
            plan_id = self._create().json()["plan"]["id"]
            res = self.client.post(f"/api/batch/plans/{plan_id}/advance", json={})
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.json()["status"], "advancing")

            self.assertTrue(started.wait(5), "the step never started")
            # It returned while the step was still going, and says so.
            self.assertTrue(self.client.get(f"/api/batch/plans/{plan_id}").json()["advancing"])
            release.set()

    def test_a_second_step_is_refused_while_one_is_running(self):
        plan_id = self._create().json()["plan"]["id"]
        app_module._advancing[plan_id] = True
        self.addCleanup(app_module._advancing.pop, plan_id, None)

        res = self.client.post(f"/api/batch/plans/{plan_id}/advance", json={})
        self.assertEqual(res.status_code, 409)
        self.assertIn("already advancing", res.json()["detail"])

    def test_advancing_an_unknown_plan_is_a_404_not_a_started_thread(self):
        res = self.client.post("/api/batch/plans/plan_00000000_000000/advance", json={})
        self.assertEqual(res.status_code, 404)

    def test_a_step_can_be_asked_to_reopen_what_failed(self):
        """Nothing else in the interface can rescue a failed group."""
        import threading as _t
        done = _t.Event()

        plan_id = self._create().json()["plan"]["id"]
        with mock.patch.object(app_module.BatchPlanner, "reopen_failed") as reopen, \
             mock.patch.object(app_module.BatchPlanner, "advance",
                               lambda *a, **k: done.set() or {"groups": []}):
            res = self.client.post(f"/api/batch/plans/{plan_id}/advance",
                                   json={"retry_failed": True})
            self.assertEqual(res.status_code, 200)
            self.assertTrue(done.wait(5), "the step never ran")
            reopen.assert_called_once_with(plan_id)

    def test_a_plain_step_leaves_failed_groups_alone(self):
        import threading as _t
        done = _t.Event()

        plan_id = self._create().json()["plan"]["id"]
        with mock.patch.object(app_module.BatchPlanner, "reopen_failed") as reopen, \
             mock.patch.object(app_module.BatchPlanner, "advance",
                               lambda *a, **k: done.set() or {"groups": []}):
            self.client.post(f"/api/batch/plans/{plan_id}/advance", json={})
            self.assertTrue(done.wait(5))
            reopen.assert_not_called()

    # ------------------------------------------------------------------
    # A plan the CLI is driving.
    #
    # The browser cannot see a terminal, so the lock file is the only evidence
    # that `batch run --watch` already owns this plan. Without it the interface
    # offers a step that spends thirty seconds failing to get a lock, and
    # reports nothing at all.

    def test_a_plan_driven_elsewhere_is_reported_as_locked(self):
        plan_id = self._create().json()["plan"]["id"]
        planner = app_module._planner()

        listed = self.client.get("/api/batch/plans").json()["plans"]
        self.assertFalse(next(p for p in listed if p["id"] == plan_id)["locked"])
        self.assertFalse(self.client.get(f"/api/batch/plans/{plan_id}").json()["locked"])

        with planner._plan_lock(plan_id):
            listed = self.client.get("/api/batch/plans").json()["plans"]
            self.assertTrue(next(p for p in listed if p["id"] == plan_id)["locked"])
            self.assertTrue(self.client.get(f"/api/batch/plans/{plan_id}").json()["locked"])

        # And released again once the other process is done with it.
        self.assertFalse(self.client.get(f"/api/batch/plans/{plan_id}").json()["locked"])

    def test_stepping_a_plan_another_process_holds_is_refused_outright(self):
        plan_id = self._create().json()["plan"]["id"]
        planner = app_module._planner()

        with mock.patch.object(app_module.BatchPlanner, "advance") as advance:
            with planner._plan_lock(plan_id):
                res = self.client.post(f"/api/batch/plans/{plan_id}/advance", json={})

            self.assertEqual(res.status_code, 409)
            self.assertIn("terminal", res.json()["detail"])
            # Refused before any work started, not abandoned partway.
            advance.assert_not_called()
        self.assertNotIn(plan_id, app_module._advancing)


if __name__ == "__main__":
    unittest.main()
