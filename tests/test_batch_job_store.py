"""The batch job store is the only route back to work already submitted.

A job record holds the ``gemini_job_name``. Lose it and the job keeps running
at Google, keeps costing money, and can never be collected — so these tests are
about the store surviving the two things that actually happen to it: two
processes writing at once, and a write that does not finish.
"""

import json
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

from goosequill.services.batch_service import BatchService
from goosequill.services.cache_manager import CacheManager


def _job(job_id: str, name: str = None) -> dict:
    return {
        "id": job_id,
        "gemini_job_name": name or f"batches/{job_id}",
        "model": "gemini-3.5-flash-lite",
        "is_completed": False,
        "status": "JOB_STATE_PENDING",
    }


class TestBatchJobStore(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gq_jobstore_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        patcher = mock.patch("goosequill.services.genai_factory.load_dotenv", lambda *a, **k: None)
        patcher.start()
        self.addCleanup(patcher.stop)

        env = mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for var in ("GOOSEQUILL_USE_VERTEX", "GOOGLE_GENAI_USE_VERTEXAI"):
            os.environ.pop(var, None)

        self.service = self._service()

    def _service(self) -> BatchService:
        """A service instance sharing the store — stands in for another process."""
        return BatchService(cache_manager=CacheManager(cache_dir=self.tmp))

    # ------------------------------------------------------------------

    def test_a_job_submitted_during_a_poll_is_not_overwritten(self):
        """The race that loses a running job: A reads, B appends, A writes back."""
        app_side = self.service
        cli_side = self._service()

        app_side._update_jobs(lambda jobs: jobs.insert(0, _job("existing")))

        # The app has read the store and is now off polling Google.
        snapshot = app_side._load_jobs()
        self.assertEqual(len(snapshot), 1)

        # Meanwhile the CLI submits the next company folder.
        cli_side._update_jobs(lambda jobs: jobs.insert(0, _job("submitted_during_poll")))

        # The app now records what its poll found, against a fresh read.
        def _mark_running(jobs):
            for job in jobs:
                if job["id"] == "existing":
                    job["status"] = "JOB_STATE_RUNNING"
        merged = app_side._update_jobs(_mark_running)

        ids = {j["id"] for j in merged}
        self.assertEqual(ids, {"existing", "submitted_during_poll"})
        self.assertEqual(
            next(j for j in merged if j["id"] == "existing")["status"],
            "JOB_STATE_RUNNING",
        )

    def test_an_unparseable_store_is_preserved_rather_than_emptied(self):
        self.service._update_jobs(lambda jobs: jobs.insert(0, _job("precious")))
        self.service.metadata_file.write_text("{ this is not json", encoding="utf-8")

        # The damaged file must not simply read as "no jobs"...
        self.assertEqual(self.service._load_jobs(), [])
        # ...it must still exist somewhere a human can read the job name out of.
        preserved = list(self.tmp.glob("batch_jobs.json.corrupt-*"))
        self.assertEqual(len(preserved), 1, "damaged store was not preserved")
        self.assertIn("this is not json", preserved[0].read_text(encoding="utf-8"))

    def test_an_unreadable_store_is_an_error_not_an_empty_list(self):
        """Reporting zero jobs when 38 are in flight is worse than failing."""
        self.service.metadata_file.mkdir(parents=True, exist_ok=True)
        with self.assertRaises(RuntimeError) as ctx:
            self.service._load_jobs()
        self.assertIn("Could not read", str(ctx.exception))

    def test_a_write_leaves_no_partial_file_behind(self):
        self.service._update_jobs(lambda jobs: jobs.extend(_job(f"j{i}") for i in range(20)))

        leftovers = [p.name for p in self.tmp.iterdir() if ".tmp" in p.name]
        self.assertEqual(leftovers, [], f"temporary files left behind: {leftovers}")
        # And the committed file is complete and parseable.
        parsed = json.loads(self.service.metadata_file.read_text(encoding="utf-8"))
        self.assertEqual(len(parsed), 20)

    def test_the_lock_is_released_even_when_the_change_raises(self):
        with self.assertRaises(ValueError):
            self.service._update_jobs(self._explode)
        # A held lock would hang the next call rather than returning.
        self.service._update_jobs(lambda jobs: jobs.insert(0, _job("after")))
        self.assertEqual([j["id"] for j in self.service._load_jobs()], ["after"])

    @staticmethod
    def _explode(jobs):
        raise ValueError("something went wrong mid-change")

    def test_a_store_that_is_not_a_list_does_not_crash_the_reader(self):
        self.service.metadata_file.write_text('{"jobs": []}', encoding="utf-8")
        self.assertEqual(self.service._load_jobs(), [])


if __name__ == "__main__":
    unittest.main()
