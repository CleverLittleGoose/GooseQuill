"""A resumable plan for converting a corpus through the Batch API.

Submitting a corpus is not one job. Google's File API caps a batch payload at
2 GB, and a paid tier caps how many tokens may sit enqueued across all jobs at
once — 10M on Tier 1, which a corpus of any size exceeds several times over. So
the work has to be broken into groups, submitted as capacity frees up, and
collected as each finishes.

The obvious way to do that is a loop in the submitting process. That is also
the way to lose it: close the laptop after twelve of thirty-eight groups and
the remaining twenty-six exist nowhere. Jobs already at Google are recoverable
because Google holds their state — but a group that was never submitted leaves
no trace at all.

So the plan is written to disk before anything is submitted, and every
transition is recorded as it happens:

    pending -> submitted -> collected
                        \\-> failed
    pending -> complete            (nothing left for this model to convert)

``advance`` performs one tick of that machine and returns. Run it once, run it
on a timer, run it from the CLI or the web app — it reads the plan, reconciles
it against Google, does what it can, writes it back, and stops. Nothing is held
in memory between ticks, which is what makes it resumable.
"""

import fcntl
import json
import logging
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..models.document import (
    PROMPT_PRESETS,
    PRESET_PROMPT_ID,
    RECITATION_FALLBACK_PROMPTS,
)
from ..models.pricing import PricingRegistry
from .batch_service import BatchService
from .cache_manager import CacheManager, atomic_write_text
from .cost_calculator import CostCalculator
from .pdf_renderer import PDFRenderer

logger = logging.getLogger(__name__)

PENDING = "pending"
SUBMITTED = "submitted"
COLLECTED = "collected"
COMPLETE = "complete"
FAILED = "failed"

# Google's Tier 1 allowance is 10M enqueued tokens per model. Aim below it:
# the accounting here is an estimate, and a rejected submission costs a whole
# tick while unused headroom costs nothing but a little throughput.
DEFAULT_MAX_ENQUEUED_TOKENS = 8_000_000

# How many ticks to spend trying to find a job whose local record has gone
# missing before giving up on it. More than one because failing to reach Google
# is not the same as the job not existing, and a tick is cheap.
MAX_RECOVERY_ATTEMPTS = 3


class BatchPlanner:
    """Creates, persists and advances a multi-job batch plan."""

    def __init__(
        self,
        batch_service: Optional[BatchService] = None,
        cache_manager: Optional[CacheManager] = None,
        pdf_renderer: Optional[PDFRenderer] = None,
    ):
        self.cache_manager = cache_manager or CacheManager()
        self.pdf_renderer = pdf_renderer or PDFRenderer()
        self.batch_service = batch_service or BatchService(
            cache_manager=self.cache_manager, pdf_renderer=self.pdf_renderer
        )
        self.plans_dir = self.cache_manager.cache_dir / "batch_plans"
        self.plans_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def plan_path(self, plan_id: str) -> Path:
        return self.plans_dir / f"{plan_id}.json"

    @contextmanager
    def _plan_lock(self, plan_id: str, timeout: float = 30.0):
        """One writer per plan, so two ticks cannot submit the same group twice."""
        lock_path = self.plans_dir / f"{plan_id}.lock"
        handle = open(lock_path, "a+")
        deadline = time.time() + timeout
        try:
            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.time() >= deadline:
                        raise TimeoutError(
                            f"Plan {plan_id} is locked by another process. If nothing "
                            f"else is running, remove {lock_path}."
                        )
                    time.sleep(0.1)
            yield
        finally:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            handle.close()

    def is_locked(self, plan_id: str) -> bool:
        """Whether some other process is mid-tick on this plan.

        The lock is what stops two ticks submitting the same group twice, and
        it works across processes — so a plan being driven by `batch run
        --watch` in a terminal is already spoken for. A caller that cannot see
        that terminal has no other way to find out, and would otherwise offer a
        step that spends thirty seconds waiting for a lock it will not get.
        """
        lock_path = self.plans_dir / f"{plan_id}.lock"
        if not lock_path.exists():
            return False
        try:
            handle = open(lock_path, "a+")
        except OSError:
            return False
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        else:
            # We took it, so nobody held it. Put it straight back.
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            return False
        finally:
            handle.close()

    def load_plan(self, plan_id: str) -> Dict[str, Any]:
        path = self.plan_path(plan_id)
        if not path.exists():
            raise ValueError(f"No such plan: {plan_id}. Try `goosequill batch list`.")
        return json.loads(path.read_text(encoding="utf-8"))

    def save_plan(self, plan: Dict[str, Any]) -> Path:
        path = self.plan_path(plan["id"])
        plan["updated_at"] = time.time()
        atomic_write_text(path, json.dumps(plan, indent=2))
        return path

    def list_plans(self) -> List[Dict[str, Any]]:
        plans = []
        for path in sorted(self.plans_dir.glob("*.json"), reverse=True):
            try:
                plans.append(json.loads(path.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                logger.warning("Ignoring unreadable plan file %s", path)
        return plans

    def latest_plan_id(self) -> Optional[str]:
        plans = self.list_plans()
        return plans[0]["id"] if plans else None

    # ------------------------------------------------------------------
    # Creating
    # ------------------------------------------------------------------

    def create_plan(
        self,
        root: Path,
        model: str = PricingRegistry.DEFAULT_MODEL,
        preset: str = "financial",
        max_enqueued_tokens: int = DEFAULT_MAX_ENQUEUED_TOKENS,
        skip_cached: bool = True,
        files: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Group a corpus by company folder, splitting any folder that is too big.

        ``files`` restricts the plan to specific documents, still grouped by
        their folder — the shape a repair run wants.
        """
        root = Path(root).resolve()
        if files is None and not root.is_dir():
            raise ValueError(f"Not a directory: {root}")

        max_pages = self.batch_service.max_pages_per_job()
        groups: List[Dict[str, Any]] = []

        if files is not None:
            # A targeted plan: only these documents, still grouped by the
            # folder they sit in so collection and provenance look the same as
            # any other plan.
            by_folder: Dict[str, List[Path]] = {}
            for raw in files:
                path = Path(raw)
                if path.exists():
                    by_folder.setdefault(path.parent.name, []).append(path)
            folders = [(name, sorted(paths)) for name, paths in sorted(by_folder.items())]
        else:
            folders = [(f.name, sorted(f.rglob("*.pdf")))
                       for f in sorted(p for p in root.iterdir() if p.is_dir())]

        for folder_name, pdfs in folders:
            if not pdfs:
                continue

            # Count once, here, so a tick never has to reopen every PDF.
            counted = []
            for pdf in pdfs:
                try:
                    counted.append((pdf, self.pdf_renderer.get_page_count(pdf)))
                except Exception as e:
                    logger.warning("Could not read %s: %s", pdf, e)

            # A folder larger than one payload is split by document, never
            # mid-document — a document split across two jobs would assemble
            # from two separate collections.
            for part_no, chunk in enumerate(self._chunk(counted, max_pages), start=1):
                suffix = f" (part {part_no})" if part_no > 1 or self._needs_splitting(counted, max_pages) else ""
                groups.append({
                    "name": folder_name + suffix,
                    "folder": folder_name,
                    "files": [str(pdf) for pdf, _ in chunk],
                    "pages": sum(pages for _, pages in chunk),
                    "state": PENDING,
                    "job_id": None,
                    "error": None,
                })

        plan = {
            "id": f"plan_{time.strftime('%Y%m%d_%H%M%S')}",
            "created_at": time.time(),
            "root": str(root),
            "model": model,
            "preset": preset,
            "skip_cached": skip_cached,
            "max_enqueued_tokens": max_enqueued_tokens,
            "groups": groups,
        }
        self.save_plan(plan)
        return plan

    @staticmethod
    def _needs_splitting(counted: List[tuple], max_pages: int) -> bool:
        return sum(pages for _, pages in counted) > max_pages

    @staticmethod
    def _chunk(counted: List[tuple], max_pages: int) -> List[List[tuple]]:
        """Split a folder's documents into runs that each fit one payload."""
        chunks: List[List[tuple]] = []
        current: List[tuple] = []
        running = 0
        for pdf, pages in counted:
            if current and running + pages > max_pages:
                chunks.append(current)
                current, running = [], 0
            current.append((pdf, pages))
            running += pages
        if current:
            chunks.append(current)
        return chunks or [[]]

    # ------------------------------------------------------------------
    # Advancing
    # ------------------------------------------------------------------

    def advance(
        self,
        plan_id: str,
        on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
        only: Optional[str] = None,
        max_new: Optional[int] = None,
    ) -> Dict[str, Any]:
        """One tick: collect what has finished, submit what now fits.

        ``only`` restricts *submission* to groups whose name contains that
        text, and ``max_new`` caps how many groups this tick may submit —
        between them, a way to try one company before committing a corpus.
        Neither restricts collection: work already at Google is always
        reconciled, or a narrowed run would strand jobs a wider one started.
        """
        emit = on_event or (lambda kind, data: None)

        with self._plan_lock(plan_id):
            plan = self.load_plan(plan_id)

            # Reconcile against Google before deciding anything. Job state is
            # held there, not here, which is why a plan survives this process.
            try:
                jobs = {j["id"]: j for j in self.batch_service.list_jobs(force_refresh=True)}
            except Exception as e:
                logger.warning("Could not refresh job states: %s", e)
                jobs = {}

            for group in plan["groups"]:
                if group["state"] != SUBMITTED:
                    continue
                job = jobs.get(group["job_id"])
                if not job:
                    # The record has gone missing from the local store. The job
                    # itself has not — Google still has it — so look it up
                    # rather than leaving the group here for ever.
                    job = self._recover_group_job(plan, group, emit)
                if not job:
                    continue

                status = job.get("status")
                if status == "JOB_STATE_SUCCEEDED":
                    try:
                        result = self.batch_service.collect_job_results(group["job_id"])
                        if result.get("status") == "success":
                            group["collected_files"] = result.get("assembled_files_count", 0)
                            blocked = result.get("blocked") or []
                            passes = group.get("retry_pass", 0)

                            if blocked and passes < len(RECITATION_FALLBACK_PROMPTS):
                                # Gemini's recitation filter refuses some pages
                                # of a statutory filing — typically the auditor's
                                # report, which really is recited text. Those
                                # pages were left uncached, so resubmitting the
                                # group picks up exactly the holes, and a
                                # differently worded prompt usually gets them.
                                group["state"] = PENDING
                                group["retry_pass"] = passes + 1
                                group["blocked"] = blocked
                                group["job_id"] = None
                                self._commit(plan, emit, "retrying",
                                             {"group": group, "blocked": blocked})
                            else:
                                group["state"] = COLLECTED
                                if blocked:
                                    group["blocked"] = blocked
                                self._commit(plan, emit, "collected",
                                             {"group": group, "result": result})
                    except Exception as e:
                        group["state"] = FAILED
                        group["error"] = f"Collection failed: {e}"
                        self._commit(plan, emit, "failed", {"group": group})
                elif status in self.batch_service.TERMINAL_STATES:
                    group["state"] = FAILED
                    group["error"] = job.get("error") or status
                    self._commit(plan, emit, "failed", {"group": group})

            self.save_plan(plan)

            # Now fill whatever headroom that freed.
            in_flight = self._enqueued_tokens(plan)
            budget = plan["max_enqueued_tokens"]
            base_prompt = PROMPT_PRESETS[plan["preset"]].prompt

            submitted_now = 0
            for group in plan["groups"]:
                if group["state"] != PENDING:
                    continue
                if only and only.lower() not in group["name"].lower():
                    continue
                if max_new is not None and submitted_now >= max_new:
                    break
                cost = group["pages"] * CostCalculator.INPUT_TOKENS_PER_PAGE
                if in_flight + cost > budget:
                    # Groups are submitted in order; stopping here rather than
                    # hunting for a smaller one keeps the corpus arriving in a
                    # predictable sequence.
                    break

                # A retry pass re-asks for the same pages in different words.
                # The originals are still cached and will be skipped, so only
                # the refused pages go back out.
                passes = group.get("retry_pass", 0)
                fallback = RECITATION_FALLBACK_PROMPTS[passes - 1] if passes else None
                prompt = fallback.text if fallback else base_prompt
                prompt_id = fallback.id if fallback else PRESET_PROMPT_ID

                emit("submitting", {"group": group})
                try:
                    job = self.batch_service.create_batch_job(
                        pdf_paths=group["files"],
                        model_name=plan["model"],
                        system_prompt=prompt,
                        display_name=f"{plan['id']} — {group['name']}",
                        skip_cached=plan.get("skip_cached", True),
                        prompt_id=prompt_id,
                    )
                    group["state"] = SUBMITTED
                    group["job_id"] = job["id"]
                    group["requests"] = job["total_requests"]
                    in_flight += cost
                    submitted_now += 1
                    self._commit(plan, emit, "submitted", {"group": group, "job": job})
                except ValueError as e:
                    # "Nothing to submit" is success: this model has already
                    # converted every page in the group.
                    if "already been converted" in str(e):
                        group["state"] = COLLECTED if group.get("retry_pass") else COMPLETE
                        self._commit(plan, emit, "complete", {"group": group})
                    else:
                        group["state"] = FAILED
                        group["error"] = str(e)
                        self._commit(plan, emit, "failed", {"group": group})
                except Exception as e:
                    group["state"] = FAILED
                    group["error"] = str(e)
                    self._commit(plan, emit, "failed", {"group": group})
                finally:
                    # Safety net for anything that escaped the handlers above.
                    self.save_plan(plan)

            return plan

    def _recover_group_job(self, plan: Dict[str, Any], group: Dict[str, Any], emit) -> Optional[Dict[str, Any]]:
        """Find a group's job again when the local record has vanished.

        A missing record used to strand a group at "submitted" permanently: the
        reconcile loop looked up an id that was not there and moved on, tick
        after tick, while the results sat finished and paid for at Google.

        Three answers are possible and they are not interchangeable. Recovered,
        and the group carries on. Definitively not there, and after a few tries
        the group fails with an error that says what happened. Or Google could
        not be reached — which is not evidence of anything, so nothing changes
        and the next tick asks again.
        """
        job_id = group.get("job_id")
        if not job_id:
            return None

        display_name = f"{plan['id']} — {group['name']}"
        try:
            job = self.batch_service.recover_job(job_id, display_name)
        except Exception as e:
            logger.warning("Could not look up job %s at Google: %s", job_id, e)
            return None

        if job:
            group.pop("recovery_attempts", None)
            self._commit(plan, emit, "recovered", {"group": group, "job": job})
            return job

        attempts = group.get("recovery_attempts", 0) + 1
        group["recovery_attempts"] = attempts
        if attempts >= MAX_RECOVERY_ATTEMPTS:
            group["state"] = FAILED
            group["error"] = (
                f"The record for job {job_id} is missing from the job store and no "
                f"matching batch could be found at Google after {attempts} attempts. "
                f"Any results it produced cannot be collected. Reopen this group to "
                f"convert its pages again — pages already cached will be skipped, so "
                f"only what is genuinely missing is resubmitted."
            )
            self._commit(plan, emit, "failed", {"group": group})
        else:
            self.save_plan(plan)
        return None

    def reopen_failed(self, plan_id: str) -> int:
        """Put failed groups back to pending so a later tick retries them.

        Nothing else could do this. A group that failed — a collection that
        threw, a job that expired, a record that could not be recovered — stayed
        failed for the life of the plan, because the submit loop only ever looks
        at pending groups. That made every failure permanent regardless of
        whether its cause still applied, which for a transient one is simply
        wrong.

        Resubmitting is not wasteful: the submission skips pages this model has
        already converted, so a group that failed halfway sends only the pages
        that are still missing.
        """
        with self._plan_lock(plan_id):
            plan = self.load_plan(plan_id)
            reopened = 0
            for group in plan["groups"]:
                if group["state"] != FAILED:
                    continue
                group["state"] = PENDING
                group["job_id"] = None
                # Cleared, not removed: a group carries this key from the moment
                # it is planned, and a stale message would outlive its cause.
                group["error"] = None
                group.pop("recovery_attempts", None)
                reopened += 1

            if reopened:
                self.save_plan(plan)
            return reopened

    def _commit(self, plan: Dict[str, Any], emit, kind: str, data: Dict[str, Any]) -> None:
        """Write the transition down, then announce it.

        In that order, and never the reverse. An observer told a group was
        submitted must be able to read that from disk — and more to the point,
        a crash immediately after a submission must leave the job recorded
        rather than orphaned at Google with nothing pointing at it.
        """
        self.save_plan(plan)
        emit(kind, data)

    def converted_pages(self, plan: Dict[str, Any], group: Dict[str, Any]) -> int:
        """Pages of this group that actually hold text, according to the cache.

        This is the only honest answer to "did it do these pages". A group's
        recorded ``blocked`` list is a log of what one collection was refused,
        not a statement about now — most of those pages are obtained by the
        retry that follows, and reading the log as if it were the current
        state is how a plan comes to claim 191 missing pages when it has 8.
        """
        model = plan["model"]
        return sum(
            len(self.cache_manager.cached_page_numbers(Path(raw), model))
            for raw in group["files"]
        )

    def missing_pages(self, plan: Dict[str, Any], group: Dict[str, Any]) -> int:
        """Pages of this group the model has still not produced.

        Counted against the group's planned total rather than by reopening
        every PDF: the page counts were taken once when the plan was made,
        precisely so that a tick never has to read them again.
        """
        return max(0, group["pages"] - self.converted_pages(plan, group))

    def annotate(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """The plan with each group's real page accounting filled in.

        Kept apart from the stored plan: what the cache holds changes without
        the plan changing — a repair run, or a standard conversion filling a
        hole — so this is worked out when asked rather than written down and
        left to go stale.
        """
        annotated = dict(plan)
        annotated["groups"] = []
        for group in plan["groups"]:
            converted = self.converted_pages(plan, group)
            annotated["groups"].append({
                **group,
                "converted": converted,
                "missing": max(0, group["pages"] - converted),
            })
        return annotated

    def reopen_blocked(self, plan_id: str) -> int:
        """Send collected groups that still have holes back for another pass.

        Pages refused by the recitation filter used to be cached as empty and
        so were skipped forever. They are no longer, but a group already marked
        collected will not resubmit on its own.

        The test is the cache, not the recorded blocked list: groups collected
        before refusals were tracked have no such list, and those are precisely
        the ones with holes worth reopening. Only the holes go back out —
        everything else is still cached and gets skipped.
        """
        with self._plan_lock(plan_id):
            plan = self.load_plan(plan_id)
            reopened = 0
            for group in plan["groups"]:
                if group["state"] != COLLECTED:
                    continue
                if group.get("retry_pass", 0) >= len(RECITATION_FALLBACK_PROMPTS):
                    continue
                if not self.missing_pages(plan, group):
                    continue
                group["state"] = PENDING
                group["retry_pass"] = group.get("retry_pass", 0) + 1
                group["job_id"] = None
                reopened += 1
            if reopened:
                self.save_plan(plan)
            return reopened

    def _enqueued_tokens(self, plan: Optional[Dict[str, Any]] = None) -> int:
        """Tokens in flight across every plan, not merely this one.

        Google's ceiling is per model per account. Two plans each counting only
        their own submissions would each believe they had the whole allowance,
        and together would sail past it — which is exactly the situation when a
        repair run and a corpus run are going at the same time.
        """
        seen: Dict[str, int] = {}
        for candidate in self.list_plans():
            if plan is not None and candidate["id"] == plan["id"]:
                candidate = plan          # the in-memory copy is the fresher one
            for group in candidate["groups"]:
                if group["state"] == SUBMITTED and group.get("job_id"):
                    seen[group["job_id"]] = group["pages"] * CostCalculator.INPUT_TOKENS_PER_PAGE
        return sum(seen.values())

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def summarise(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        counts: Dict[str, int] = {}
        pages: Dict[str, int] = {}
        for group in plan["groups"]:
            counts[group["state"]] = counts.get(group["state"], 0) + 1
            pages[group["state"]] = pages.get(group["state"], 0) + group["pages"]

        total_pages = sum(g["pages"] for g in plan["groups"])
        done_pages = pages.get(COLLECTED, 0) + pages.get(COMPLETE, 0)
        estimate = CostCalculator.calculate_cost_for_pages(plan["model"], total_pages)

        # Two different questions, and conflating them is what made the figures
        # unreadable. done_pages is how far through its groups the plan is;
        # converted is how many pages actually came back with text on them. A
        # plan can be finished and still be short.
        converted = sum(self.converted_pages(plan, g) for g in plan["groups"])

        return {
            "id": plan["id"],
            "model": plan["model"],
            "root": plan["root"],
            "groups": len(plan["groups"]),
            "counts": counts,
            "total_pages": total_pages,
            "done_pages": done_pages,
            "percent": round(done_pages / total_pages * 100, 1) if total_pages else 0.0,
            "converted_pages": converted,
            "missing_pages": max(0, total_pages - converted),
            "enqueued_tokens": self._enqueued_tokens(plan),
            "max_enqueued_tokens": plan["max_enqueued_tokens"],
            "estimated_batch_cost_usd": estimate.cost_batch_usd,
            # How many reworded prompts a refused page gets before it is given
            # up on. A caller counting retryable pages needs this to tell a
            # page that will be retried from one that never will be again.
            "max_retry_passes": len(RECITATION_FALLBACK_PROMPTS),
            "is_finished": all(
                g["state"] in (COLLECTED, COMPLETE, FAILED) for g in plan["groups"]
            ),
        }
