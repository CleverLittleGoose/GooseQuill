"""Finding a job again when its local record has gone.

The job store is a cache of where the work is; Google is where the work lives.
So a lost record is not lost work — the batch is still at Google, and the
mapping file that says which page each request came from is still on disk.

This matters because of what a lost record does otherwise. A plan's group sits
at "submitted", the reconcile loop looks up an id that is not there, and moves
on. Every tick. For ever — while the results sit finished and paid for.

The hard part is not finding a batch but finding the *right* one: every retry
pass of a group is submitted to Google under the same display name.
"""

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.batch_service import BatchService
from goosequill.services.cache_manager import CacheManager


def _remote(name, display_name, created, state="JOB_STATE_SUCCEEDED", dest="files/out"):
    """A batch as the SDK hands it back."""
    return SimpleNamespace(
        name=name,
        display_name=display_name,
        create_time=datetime.fromtimestamp(created, tz=timezone.utc),
        state=SimpleNamespace(name=state),
        dest=SimpleNamespace(file_name=dest) if dest else None,
        model="models/gemini-3.5-flash-lite",
    )


class TestJobRecovery(unittest.TestCase):
    JOB_ID = "batch_20260822_133838"
    DISPLAY = "plan_20260822_124430 — Acme Holdings Limited"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gq_recover_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        patcher = mock.patch("goosequill.services.genai_factory.load_dotenv", lambda *a, **k: None)
        patcher.start()
        self.addCleanup(patcher.stop)

        env = mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for var in ("GOOSEQUILL_USE_VERTEX", "GOOGLE_GENAI_USE_VERTEXAI"):
            os.environ.pop(var, None)

        self.service = BatchService(cache_manager=CacheManager(cache_dir=self.tmp))
        self.submitted_at = BatchService.job_id_submitted_at(self.JOB_ID)

    def _write_mapping(self, job_id=None, pages=3):
        """The mapping a submission leaves behind, which is what makes recovery possible."""
        path = self.service.batch_dir / f"{job_id or self.JOB_ID}_mapping.json"
        mapping = {
            # Three pages per document, so a 4-page job spans two of them.
            f"req-{n}": {"pdf_path": f"/docs/Acme/Report{(n - 1) // 3 + 1}.pdf", "page_num": n}
            for n in range(1, pages + 1)
        }
        path.write_text(json.dumps(mapping), encoding="utf-8")
        return path

    def _with_batches(self, batches):
        """Stand in for Google's batch listing."""
        client = SimpleNamespace(
            batches=SimpleNamespace(list=lambda config=None: iter(batches))
        )
        return mock.patch.object(self.service, "client", client)

    # ------------------------------------------------------------------

    def test_a_lost_record_is_rebuilt_from_google_and_the_mapping(self):
        self._write_mapping(pages=4)
        remote = _remote("batches/xyz", self.DISPLAY, self.submitted_at + 30)

        with self._with_batches([remote]):
            record = self.service.recover_job(self.JOB_ID, self.DISPLAY)

        self.assertIsNotNone(record)
        self.assertEqual(record["gemini_job_name"], "batches/xyz")
        self.assertEqual(record["status"], "JOB_STATE_SUCCEEDED")
        self.assertTrue(record["is_completed"])
        self.assertEqual(record["dest_file_name"], "files/out")
        self.assertEqual(record["total_requests"], 4)
        # Documents come from the mapping, deduped but in the order met.
        self.assertEqual(record["pdf_paths"], ["/docs/Acme/Report1.pdf", "/docs/Acme/Report2.pdf"])
        self.assertEqual(record["total_documents"], 2)
        self.assertIn("recovered_at", record)

        # And it is in the store, so collection can find it.
        self.assertIn(self.JOB_ID, [j["id"] for j in self.service._load_jobs()])

    def test_a_record_that_is_already_there_is_returned_untouched(self):
        self._write_mapping()
        self.service._update_jobs(
            lambda jobs: jobs.insert(0, {"id": self.JOB_ID, "gemini_job_name": "batches/original"})
        )

        def _explode(config=None):
            raise AssertionError("Google must not be asked about a job we already have")

        with mock.patch.object(self.service, "client",
                               SimpleNamespace(batches=SimpleNamespace(list=_explode))):
            record = self.service.recover_job(self.JOB_ID, self.DISPLAY)

        self.assertEqual(record["gemini_job_name"], "batches/original")
        self.assertEqual(len(self.service._load_jobs()), 1, "no duplicate record")

    # --- picking the right batch --------------------------------------
    #
    # Every retry pass of a group carries the same display name, so a match on
    # the name alone is not an answer. Two things separate them: a batch some
    # other record already points at is not ours, and a batch created before
    # this id was minted belongs to an earlier pass.

    def test_a_batch_another_record_already_points_at_is_not_taken(self):
        self._write_mapping()
        self.service._update_jobs(
            lambda jobs: jobs.insert(0, {"id": "batch_20260822_120000",
                                         "gemini_job_name": "batches/first-pass"})
        )
        batches = [
            _remote("batches/first-pass", self.DISPLAY, self.submitted_at + 10),
            _remote("batches/second-pass", self.DISPLAY, self.submitted_at + 20),
        ]

        with self._with_batches(batches):
            record = self.service.recover_job(self.JOB_ID, self.DISPLAY)

        self.assertEqual(record["gemini_job_name"], "batches/second-pass")

    def test_a_batch_created_before_this_id_existed_belongs_to_an_earlier_pass(self):
        self._write_mapping()
        batches = [
            _remote("batches/earlier", self.DISPLAY, self.submitted_at - 3600),
            _remote("batches/ours", self.DISPLAY, self.submitted_at + 45),
        ]

        with self._with_batches(batches):
            record = self.service.recover_job(self.JOB_ID, self.DISPLAY)

        self.assertEqual(record["gemini_job_name"], "batches/ours")

    def test_the_earliest_batch_after_the_id_wins_not_the_newest(self):
        """Later ones belong to passes that came after this id was minted."""
        self._write_mapping()
        batches = [
            _remote("batches/later", self.DISPLAY, self.submitted_at + 4000),
            _remote("batches/ours", self.DISPLAY, self.submitted_at + 60),
        ]

        with self._with_batches(batches):
            record = self.service.recover_job(self.JOB_ID, self.DISPLAY)

        self.assertEqual(record["gemini_job_name"], "batches/ours")

    def test_another_groups_batch_is_never_taken(self):
        self._write_mapping()
        batches = [_remote("batches/other", "plan_20260822_124430 — Someone Else Ltd",
                           self.submitted_at + 30)]

        with self._with_batches(batches):
            self.assertIsNone(self.service.recover_job(self.JOB_ID, self.DISPLAY))

    # --- when recovery is not possible --------------------------------

    def test_without_its_mapping_a_job_is_not_recovered_even_if_google_has_it(self):
        """Results with nothing to file them against are no use."""
        remote = _remote("batches/xyz", self.DISPLAY, self.submitted_at + 30)

        with self._with_batches([remote]):
            self.assertIsNone(self.service.recover_job(self.JOB_ID, self.DISPLAY))

        self.assertEqual(self.service._load_jobs(), [])

    def test_nothing_at_google_means_nothing_recovered(self):
        self._write_mapping()
        with self._with_batches([]):
            self.assertIsNone(self.service.recover_job(self.JOB_ID, self.DISPLAY))

    def test_a_failure_to_reach_google_is_raised_not_reported_as_absence(self):
        """"We could not look" and "it is not there" must not look alike."""
        self._write_mapping()

        def _boom(config=None):
            raise ConnectionError("network is down")

        with mock.patch.object(self.service, "client",
                               SimpleNamespace(batches=SimpleNamespace(list=_boom))):
            with self.assertRaises(ConnectionError):
                self.service.recover_job(self.JOB_ID, self.DISPLAY)

    # --- the timestamp a job id carries -------------------------------

    def test_a_job_id_yields_the_moment_it_was_minted(self):
        stamp = BatchService.job_id_submitted_at("batch_20260822_133838")
        self.assertEqual(time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stamp)),
                         "2026-08-22 13:38:38")

    def test_an_id_that_carries_no_timestamp_yields_none(self):
        for job_id in ("", None, "batch_nonsense", "batch_20261322_133838", "xyz"):
            with self.subTest(job_id=job_id):
                self.assertIsNone(BatchService.job_id_submitted_at(job_id))

    def test_an_id_without_a_timestamp_still_recovers_on_the_name_alone(self):
        """Falling back is better than refusing: the display name still narrows it."""
        odd_id = "batch_handmade"
        self._write_mapping(job_id=odd_id)
        remote = _remote("batches/xyz", self.DISPLAY, time.time())

        with self._with_batches([remote]):
            record = self.service.recover_job(odd_id, self.DISPLAY)

        self.assertIsNotNone(record)
        self.assertEqual(record["gemini_job_name"], "batches/xyz")


if __name__ == "__main__":
    unittest.main()
