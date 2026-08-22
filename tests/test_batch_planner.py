"""A batch plan has to survive the process that created it.

The failure these tests exist for: a run that staggers thirty-eight groups
under a token ceiling, submits twelve, and then loses the machine. Jobs already
at Google are recoverable because Google holds their state. A group that was
never submitted leaves no trace anywhere unless the plan was written down
first, and written down again after every transition.
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

from goosequill.services.batch_planner import (
    BatchPlanner, PENDING, SUBMITTED, COLLECTED, COMPLETE, FAILED,
    MAX_RECOVERY_ATTEMPTS,
)
from goosequill.services.cache_manager import CacheManager
from goosequill.services.cost_calculator import CostCalculator

MODEL = "gemini-3.5-flash-lite"
PAGES_PER_DOC = 10


class FakeRenderer:
    def get_page_count(self, path):
        return PAGES_PER_DOC


class FakeBatchService:
    """Stands in for Google: holds job state, and can be told how jobs end."""

    TERMINAL_STATES = (
        "JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED",
        "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED",
    )

    def __init__(self, max_pages=1000):
        self._max_pages = max_pages
        self.jobs = {}
        self.submissions = []
        self.nothing_to_do = set()      # group display names with everything cached
        self.explode_on = set()
        self.collected = []
        self.blocked_next = []       # blocked pages the next collection reports
        self.prompts = []            # system prompt used for each submission
        self.prompt_ids = []         # ... and the id recorded alongside it
        self.lost = set()            # job ids whose local record has vanished
        self.unrecoverable = set()   # ... and which cannot be found again
        self.recovery_raises = False # Google could not be reached at all
        self.recovery_calls = []

    def max_pages_per_job(self):
        return self._max_pages

    def create_batch_job(self, pdf_paths, model_name, system_prompt,
                         display_name=None, skip_cached=True, prompt_id=None):
        if any(tag in display_name for tag in self.nothing_to_do):
            raise ValueError("Nothing to submit: all pages have already been converted")
        if any(tag in display_name for tag in self.explode_on):
            raise RuntimeError("upload failed")
        job_id = f"job_{len(self.jobs) + 1:03d}"
        self.jobs[job_id] = {"id": job_id, "status": "JOB_STATE_PENDING", "is_completed": False}
        self.submissions.append((display_name, list(pdf_paths)))
        self.prompts.append(system_prompt)
        self.prompt_ids.append(prompt_id)
        return {"id": job_id, "total_requests": len(pdf_paths) * PAGES_PER_DOC}

    def list_jobs(self, force_refresh=False):
        # A lost record is absent from the store while the job itself lives on.
        return [j for j in self.jobs.values() if j["id"] not in self.lost]

    def recover_job(self, job_id, display_name):
        self.recovery_calls.append((job_id, display_name))
        if self.recovery_raises:
            raise ConnectionError("network is down")
        if job_id in self.unrecoverable:
            return None
        self.lost.discard(job_id)
        return self.jobs[job_id]

    def collect_job_results(self, job_id):
        self.collected.append(job_id)
        result = {"status": "success", "assembled_files_count": 1,
                  "blocked": list(self.blocked_next)}
        self.blocked_next = []
        return result

    # -- test helpers -------------------------------------------------
    def finish(self, job_id, status="JOB_STATE_SUCCEEDED"):
        self.jobs[job_id].update(status=status, is_completed=True)

    def finish_all(self, status="JOB_STATE_SUCCEEDED"):
        for job_id in self.jobs:
            self.finish(job_id, status)


class TestBatchPlanner(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gq_plan_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        patcher = mock.patch("goosequill.services.genai_factory.load_dotenv", lambda *a, **k: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False)
        env.start()
        self.addCleanup(env.stop)

        self.root = self.tmp / "corpus"
        for company in ("Acme Holdings Limited", "Pinion Alpha Limited", "Quill Estates Limited"):
            folder = self.root / company
            folder.mkdir(parents=True)
            for year in (2023, 2024):
                (folder / f"{company} - Annual Report {year}.pdf").write_bytes(b"%PDF-1.4\n")

        self.cache = CacheManager(cache_dir=self.tmp / ".cache")
        self.batch = FakeBatchService()
        self.planner = self._planner()

    def _planner(self):
        """A fresh planner sharing the same disk — stands in for a later process."""
        return BatchPlanner(
            batch_service=self.batch,
            cache_manager=CacheManager(cache_dir=self.tmp / ".cache"),
            pdf_renderer=FakeRenderer(),
        )

    def _plan(self, **kwargs):
        kwargs.setdefault("model", MODEL)
        return self.planner.create_plan(root=self.root, **kwargs)

    # ------------------------------------------------------------------
    # Planning
    # ------------------------------------------------------------------

    def test_a_corpus_is_grouped_one_group_per_company(self):
        plan = self._plan()
        self.assertEqual([g["name"] for g in plan["groups"]],
                         ["Acme Holdings Limited", "Pinion Alpha Limited", "Quill Estates Limited"])
        self.assertTrue(all(g["pages"] == 2 * PAGES_PER_DOC for g in plan["groups"]))
        self.assertTrue(all(g["state"] == PENDING for g in plan["groups"]))

    def test_a_folder_too_large_for_one_payload_is_split(self):
        self.batch._max_pages = 15  # one document (10 pages) per part
        plan = self._plan()
        acme = [g for g in plan["groups"] if g["folder"] == "Acme Holdings Limited"]
        self.assertEqual(len(acme), 2)
        self.assertTrue(all(g["pages"] <= 15 for g in acme))
        # A document is never split across two jobs — it could not be assembled.
        self.assertEqual(sum(len(g["files"]) for g in acme), 2)
        self.assertIn("part", acme[0]["name"])

    def test_nothing_is_submitted_by_planning(self):
        self._plan()
        self.assertEqual(self.batch.submissions, [])

    # ------------------------------------------------------------------
    # Advancing
    # ------------------------------------------------------------------

    def test_submission_stops_at_the_enqueued_token_ceiling(self):
        per_group = 2 * PAGES_PER_DOC * CostCalculator.INPUT_TOKENS_PER_PAGE
        plan = self._plan(max_enqueued_tokens=per_group * 2)   # room for two of three

        plan = self.planner.advance(plan["id"])
        states = [g["state"] for g in plan["groups"]]
        self.assertEqual(states, [SUBMITTED, SUBMITTED, PENDING])
        self.assertEqual(len(self.batch.submissions), 2)

    def test_capacity_freed_by_a_finished_job_is_refilled(self):
        per_group = 2 * PAGES_PER_DOC * CostCalculator.INPUT_TOKENS_PER_PAGE
        plan = self._plan(max_enqueued_tokens=per_group * 2)
        plan = self.planner.advance(plan["id"])

        self.batch.finish("job_001")
        plan = self.planner.advance(plan["id"])

        states = [g["state"] for g in plan["groups"]]
        self.assertEqual(states, [COLLECTED, SUBMITTED, SUBMITTED])
        self.assertEqual(self.batch.collected, ["job_001"])

    def test_a_plan_resumes_in_a_process_that_did_not_create_it(self):
        per_group = 2 * PAGES_PER_DOC * CostCalculator.INPUT_TOKENS_PER_PAGE
        plan_id = self._plan(max_enqueued_tokens=per_group)["id"]
        self.planner.advance(plan_id)

        # The machine goes away. Everything about the run is on disk.
        del self.planner
        self.batch.finish("job_001")
        revived = self._planner()

        plan = revived.advance(plan_id)
        self.assertEqual([g["state"] for g in plan["groups"]],
                         [COLLECTED, SUBMITTED, PENDING])

    def test_a_group_already_converted_is_marked_done_not_submitted(self):
        plan = self._plan()
        self.batch.nothing_to_do.add("Pinion Alpha Limited")

        plan = self.planner.advance(plan["id"])
        by_name = {g["name"]: g for g in plan["groups"]}
        self.assertEqual(by_name["Pinion Alpha Limited"]["state"], COMPLETE)
        self.assertEqual(by_name["Acme Holdings Limited"]["state"], SUBMITTED)

    def test_a_failed_submission_does_not_stop_the_rest(self):
        plan = self._plan()
        self.batch.explode_on.add("Acme Holdings Limited")

        plan = self.planner.advance(plan["id"])
        by_name = {g["name"]: g for g in plan["groups"]}
        self.assertEqual(by_name["Acme Holdings Limited"]["state"], FAILED)
        self.assertIn("upload failed", by_name["Acme Holdings Limited"]["error"])
        self.assertEqual(by_name["Quill Estates Limited"]["state"], SUBMITTED)

    def test_a_job_that_ends_badly_is_recorded_as_failed(self):
        plan = self._plan()
        self.planner.advance(plan["id"])
        self.batch.finish("job_001", "JOB_STATE_EXPIRED")

        plan = self.planner.advance(plan["id"])
        self.assertEqual(plan["groups"][0]["state"], FAILED)
        self.assertEqual(plan["groups"][0]["error"], "JOB_STATE_EXPIRED")

    def test_every_transition_is_on_disk_before_the_next_one(self):
        """A crash between two submissions must not lose the first."""
        plan = self._plan()
        seen = []

        def spy(kind, data):
            if kind == "submitted":
                # Read the plan back from disk mid-run, as a separate process would.
                on_disk = self._planner().load_plan(plan["id"])
                seen.append([g["state"] for g in on_disk["groups"]])

        self.planner.advance(plan["id"], on_event=spy)
        self.assertEqual(seen[0][0], SUBMITTED, "first submission was not persisted immediately")

    def test_only_restricts_which_groups_are_submitted(self):
        plan = self._plan()
        plan = self.planner.advance(plan["id"], only="pinion")

        by_name = {g["name"]: g["state"] for g in plan["groups"]}
        self.assertEqual(by_name["Pinion Alpha Limited"], SUBMITTED)
        self.assertEqual(by_name["Acme Holdings Limited"], PENDING)
        self.assertEqual(len(self.batch.submissions), 1)

    def test_max_new_caps_submissions_per_tick(self):
        plan = self._plan()
        plan = self.planner.advance(plan["id"], max_new=1)
        self.assertEqual(len(self.batch.submissions), 1)
        plan = self.planner.advance(plan["id"], max_new=1)
        self.assertEqual(len(self.batch.submissions), 2)

    def test_a_narrowed_run_still_collects_everything_already_running(self):
        """Otherwise a --only run would strand jobs a wider run started."""
        plan = self._plan()
        self.planner.advance(plan["id"])          # submits all three
        self.batch.finish_all()

        plan = self.planner.advance(plan["id"], only="pinion")
        self.assertTrue(all(g["state"] == COLLECTED for g in plan["groups"]),
                        "a narrowed tick skipped collection")

    def test_pages_refused_by_the_recitation_filter_are_retried(self):
        """Gemini reports the copyright filter as a successful, empty response."""
        from goosequill.models.document import RECITATION_FALLBACK_PROMPTS

        plan = self._plan()
        self.planner.advance(plan["id"], only="acme")
        self.batch.finish("job_001")
        self.batch.blocked_next = [{"pdf_path": "x.pdf", "page_num": 4, "reason": "RECITATION"}]

        plan = self.planner.advance(plan["id"], only="acme")
        acme = plan["groups"][0]

        # The same tick that finds the refusal sends the retry — no waiting for
        # another pass — and it asks in different words. Only the refused pages
        # go out, because they are the only ones left uncached.
        self.assertEqual(acme["retry_pass"], 1)
        self.assertEqual(acme["state"], SUBMITTED)
        self.assertEqual(self.batch.prompts[-1], RECITATION_FALLBACK_PROMPTS[0].text)
        self.assertEqual(self.batch.prompt_ids[-1], RECITATION_FALLBACK_PROMPTS[0].id,
                         "the page must record which prompt produced it")
        self.assertNotEqual(self.batch.prompts[0], self.batch.prompts[-1])

    def test_retrying_gives_up_once_the_fallback_prompts_run_out(self):
        from goosequill.models.document import RECITATION_FALLBACK_PROMPTS

        plan = self._plan()
        for _ in range(len(RECITATION_FALLBACK_PROMPTS) + 2):
            self.planner.advance(plan["id"], only="acme")
            self.batch.finish_all()
            self.batch.blocked_next = [{"pdf_path": "x.pdf", "page_num": 4, "reason": "RECITATION"}]
            plan = self.planner.advance(plan["id"], only="acme")

        acme = plan["groups"][0]
        self.assertEqual(acme["state"], COLLECTED, "must settle rather than retry forever")
        self.assertEqual(acme["retry_pass"], len(RECITATION_FALLBACK_PROMPTS))
        self.assertTrue(acme["blocked"], "the pages it could not get must stay on the record")

    def test_a_finished_plan_reports_itself_finished(self):
        plan = self._plan()
        self.planner.advance(plan["id"])
        self.batch.finish_all()
        plan = self.planner.advance(plan["id"])

        summary = self.planner.summarise(plan)
        self.assertTrue(summary["is_finished"])
        self.assertEqual(summary["percent"], 100.0)
        self.assertEqual(summary["enqueued_tokens"], 0)

    def test_advancing_a_finished_plan_submits_nothing_further(self):
        plan = self._plan()
        self.planner.advance(plan["id"])
        self.batch.finish_all()
        self.planner.advance(plan["id"])
        before = len(self.batch.submissions)

        self.planner.advance(plan["id"])
        self.assertEqual(len(self.batch.submissions), before)

    # ------------------------------------------------------------------
    # A job whose local record has gone missing.
    #
    # This is what used to strand a plan permanently: the reconcile loop looked
    # up an id the store no longer held, found nothing, and moved on — every
    # tick, for ever, while the job sat finished and paid for at Google.

    def test_a_group_whose_record_vanished_is_found_again_and_carries_on(self):
        plan = self._plan()
        self.planner.advance(plan["id"])
        job_id = plan["groups"][0]["job_id"] or self.planner.load_plan(plan["id"])["groups"][0]["job_id"]

        self.batch.finish_all()
        self.batch.lost.add(job_id)

        events = []
        plan = self.planner.advance(plan["id"], on_event=lambda k, d: events.append(k))

        self.assertIn("recovered", events)
        self.assertEqual(plan["groups"][0]["state"], COLLECTED)
        self.assertIn(job_id, self.batch.collected, "the results were actually collected")

    def test_a_group_is_not_failed_because_google_could_not_be_reached(self):
        """Not knowing is not the same as knowing it is gone."""
        plan = self._plan()
        self.planner.advance(plan["id"])
        job_id = self.planner.load_plan(plan["id"])["groups"][0]["job_id"]
        self.batch.lost.add(job_id)
        self.batch.recovery_raises = True

        for _ in range(5):
            plan = self.planner.advance(plan["id"])

        group = plan["groups"][0]
        self.assertEqual(group["state"], SUBMITTED, "still ours to find")
        self.assertIsNone(group.get("error"))

        # And once Google answers again, it recovers rather than staying stuck.
        self.batch.recovery_raises = False
        self.batch.finish_all()
        plan = self.planner.advance(plan["id"])
        self.assertEqual(plan["groups"][0]["state"], COLLECTED)

    def test_a_job_that_is_genuinely_gone_fails_the_group_rather_than_hanging(self):
        plan = self._plan()
        self.planner.advance(plan["id"])
        job_id = self.planner.load_plan(plan["id"])["groups"][0]["job_id"]
        self.batch.lost.add(job_id)
        self.batch.unrecoverable.add(job_id)

        for _ in range(MAX_RECOVERY_ATTEMPTS):
            plan = self.planner.advance(plan["id"])

        group = plan["groups"][0]
        self.assertEqual(group["state"], FAILED)
        self.assertIn(job_id, group["error"])
        self.assertIn("Reopen", group["error"], "the error must say what can be done")

    def test_giving_up_takes_more_than_one_look(self):
        plan = self._plan()
        self.planner.advance(plan["id"])
        job_id = self.planner.load_plan(plan["id"])["groups"][0]["job_id"]
        self.batch.lost.add(job_id)
        self.batch.unrecoverable.add(job_id)

        plan = self.planner.advance(plan["id"])
        self.assertEqual(plan["groups"][0]["state"], SUBMITTED, "one miss is not enough")
        self.assertEqual(plan["groups"][0]["recovery_attempts"], 1)

    # ------------------------------------------------------------------
    # Reopening what failed.

    def test_failed_groups_can_be_put_back_in_the_queue(self):
        """Nothing could do this before: a failure was permanent by construction."""
        self.batch.explode_on.add("Acme")
        plan = self._plan()
        plan = self.planner.advance(plan["id"])
        self.assertEqual(plan["groups"][0]["state"], FAILED)

        self.batch.explode_on.clear()
        self.assertEqual(self.planner.reopen_failed(plan["id"]), 1)

        plan = self.planner.load_plan(plan["id"])
        acme = plan["groups"][0]
        self.assertEqual(acme["state"], PENDING)
        self.assertIsNone(acme["job_id"])
        self.assertIsNone(acme.get("error"), "a stale error would outlive its cause")

        plan = self.planner.advance(plan["id"])
        self.assertEqual(plan["groups"][0]["state"], SUBMITTED, "and it goes out again")

    def test_reopening_touches_nothing_that_did_not_fail(self):
        plan = self._plan()
        self.planner.advance(plan["id"])
        before = [g["state"] for g in self.planner.load_plan(plan["id"])["groups"]]

        self.assertEqual(self.planner.reopen_failed(plan["id"]), 0)

        after = [g["state"] for g in self.planner.load_plan(plan["id"])["groups"]]
        self.assertEqual(before, after)

    # ------------------------------------------------------------------
    # Page accounting.
    #
    # "Did it do these pages" is answered by the cache and nothing else. A
    # group's blocked list records what one collection was refused, and most of
    # those pages arrive on the retry immediately after — reading the log as if
    # it were the current state is how a plan comes to claim 191 pages missing
    # when 8 are.

    def _cache_pages(self, group, count, model=MODEL):
        """Put `count` converted pages into the cache for a group's first document."""
        cache = CacheManager(cache_dir=self.tmp / ".cache")
        path = Path(group["files"][0])
        for n in range(1, count + 1):
            cache.write_page_cache(path, n, f"page {n} text", model)

    def test_converted_and_missing_come_from_the_cache(self):
        plan = self._plan()
        group = plan["groups"][0]
        self.assertEqual(self.planner.converted_pages(plan, group), 0)
        self.assertEqual(self.planner.missing_pages(plan, group), group["pages"])

        self._cache_pages(group, 7)
        self.assertEqual(self.planner.converted_pages(plan, group), 7)
        self.assertEqual(self.planner.missing_pages(plan, group), group["pages"] - 7)

    def test_a_refusal_log_does_not_make_a_page_missing(self):
        """The pages were refused once and obtained on the retry."""
        plan = self._plan()
        group = plan["groups"][0]
        group["blocked"] = [{"page_num": 3, "reason": "RECITATION"}] * 5
        self._cache_pages(group, group["pages"])

        self.assertEqual(self.planner.missing_pages(plan, group), 0)

    def test_a_summary_separates_pages_that_came_back_from_groups_that_finished(self):
        plan = self._plan()
        self.planner.advance(plan["id"])
        self.batch.finish_all()
        plan = self.planner.advance(plan["id"])
        self._cache_pages(plan["groups"][0], 4)

        summary = self.planner.summarise(plan)
        self.assertTrue(summary["is_finished"], "every group reached a terminal state")
        self.assertEqual(summary["converted_pages"], 4)
        self.assertEqual(summary["missing_pages"], summary["total_pages"] - 4)

    def test_annotating_gives_every_group_its_own_tally_without_storing_it(self):
        plan = self._plan()
        self._cache_pages(plan["groups"][1], 6)

        annotated = self.planner.annotate(plan)
        self.assertEqual(annotated["groups"][0]["converted"], 0)
        self.assertEqual(annotated["groups"][1]["converted"], 6)
        self.assertEqual(annotated["groups"][1]["missing"], plan["groups"][1]["pages"] - 6)

        # The stored plan is untouched, because what the cache holds changes
        # without the plan changing.
        self.assertNotIn("converted", self.planner.load_plan(plan["id"])["groups"][1])


if __name__ == "__main__":
    unittest.main()
