/**
 * GooseQuill — Batch plans in the browser.
 *
 * A plan is a corpus broken into one job per company, sized to stay inside
 * Google's payload cap and the account's enqueued-token allowance, and driven
 * one step at a time. The same plan files are driven by `goosequill batch run`,
 * so this view is a window onto work that may have been started in a terminal
 * hours ago and is still going — which is the whole reason a plan lives on
 * disk rather than in the process that made it.
 *
 * That shared ownership is what most of the care here is about. A plan being
 * advanced elsewhere is locked, and the honest thing to do is say so and
 * withhold the button, rather than offer a step that quietly loses a race.
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { groupModelsForSelect } from "./settings_modal.js";

const $ = (id) => document.getElementById(id);

/**
 * A plan's total, in pounds-and-pence terms.
 *
 * Deliberately not `money()` from format.js. That formatter exists for per-token
 * rates, where a third decimal is the difference between $1.875 and a price
 * nobody is charged — but a plan total rendered the same way reads as $12.414,
 * which is three decimals of false precision on an estimate.
 */
export function cost(value) {
  // Number(null) and Number("") are both 0, which would print a cost we do not
  // have as a plan that costs nothing — the same trap `money()` guards against.
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

// How often to re-read the plans. Batch jobs take minutes at best and hours at
// worst, so a busy poll buys nothing; these are just fast enough that a step
// you started yourself appears to respond.
const POLL_ACTIVE_MS = 15000;
const POLL_IDLE_MS = 90000;

let pollTimer = null;
let pollInterval = null;
let expanded = new Set();
let plans = [];
let details = new Map();

/* ------------------------------------------------------------------ *
 * Pure helpers — exported for testing.
 * ------------------------------------------------------------------ */

/**
 * A plan id is a timestamp, and reads like one to nobody.
 *
 * `plan_20260822_124430` becomes "22 Aug 2026, 12:44". The id itself stays on
 * the card, because it is what you type at the CLI.
 */
export function planLabel(planId) {
  const match = /^plan_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/.exec(planId || "");
  if (!match) return planId || "Plan";

  const [, year, month, day, hour, minute] = match;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const name = months[Number(month) - 1];
  if (!name) return planId;

  return `${Number(day)} ${name} ${year}, ${hour}:${minute}`;
}

/**
 * Whether this plan can be stepped from here, and if not, why not.
 *
 * The three reasons are genuinely different and a reader needs to tell them
 * apart: finished means there is nothing left to do, locked means someone
 * else is doing it, advancing means we are already doing it.
 */
export function stepAvailability(summary) {
  if (!summary) return { enabled: false, reason: "" };
  if (summary.locked) {
    return {
      enabled: false,
      reason: "Being advanced elsewhere — most likely `goosequill batch run` in a terminal."
    };
  }
  if (summary.advancing) {
    return { enabled: false, reason: "Stepping now…" };
  }
  if (summary.is_finished) {
    return { enabled: false, reason: "Every group has finished." };
  }
  return { enabled: true, reason: "" };
}

/**
 * What state to badge the plan as, at a glance.
 *
 * "Finished" wins over everything, but only when nothing failed: a plan whose
 * last group failed is finished in the state-machine sense and not at all in
 * the sense the reader cares about.
 */
export function planBadge(summary) {
  if (!summary) return { text: "Unknown", className: "idle" };

  const failed = (summary.counts && summary.counts.failed) || 0;
  if (summary.is_finished) {
    return failed
      ? { text: `${failed} failed`, className: "failed" }
      : { text: "Finished", className: "done" };
  }
  if (summary.locked) return { text: "Running in a terminal", className: "running" };
  if (summary.advancing) return { text: "Stepping", className: "running" };
  if ((summary.counts && summary.counts.submitted) || 0) {
    return { text: "Waiting on Google", className: "waiting" };
  }
  return { text: "Not started", className: "idle" };
}

/** Groups this plan gave up on. They stay failed until something reopens them. */
export function failedGroupCount(summary) {
  return (summary && summary.counts && summary.counts.failed) || 0;
}

export function groupBadge(group) {
  switch (group.state) {
    case "collected":
      return { text: "Collected", className: "done" };
    case "complete":
      return { text: "Already done", className: "done" };
    case "submitted":
      return { text: "At Google", className: "running" };
    case "failed":
      return { text: "Failed", className: "failed" };
    default:
      return { text: "Waiting", className: "idle" };
  }
}

/**
 * Pages still without text, split by whether anything can be done about them.
 *
 * Counted from what the cache holds now, not from each group's `blocked` list.
 * That list is a log of what one collection was refused, and most of those
 * pages are obtained by the retry that immediately follows — reading it as the
 * current state is what had a plan offering to retry 191 pages when 8 were
 * actually missing.
 *
 * The split matters because a group that has used every reworded prompt is
 * skipped when the plan is reopened. Counting those on the retry button would
 * promise pages the retry cannot deliver.
 */
export function missingPages(plan, maxPasses) {
  const limit = Number(maxPasses) || 3;
  let retryable = 0;
  let exhausted = 0;

  if (!plan || !plan.groups) return { retryable, exhausted };

  for (const group of plan.groups) {
    const count = group.missing || 0;
    if (!count) continue;
    if ((group.retry_pass || 0) >= limit) exhausted += count;
    else retryable += count;
  }
  return { retryable, exhausted };
}

/**
 * Whether refused pages can be retried from here.
 *
 * Deliberately not the same test as taking a step. A finished plan cannot be
 * stepped — there is nothing pending — but retrying is exactly what a finished
 * plan with refused pages is for, and gating it on the same condition would
 * mean the button appeared only where it could never be used.
 */
export function retryAvailability(summary) {
  if (!summary) return { enabled: false, reason: "" };
  if (summary.locked) {
    return {
      enabled: false,
      reason: "Being advanced elsewhere — most likely `goosequill batch run` in a terminal."
    };
  }
  if (summary.advancing) return { enabled: false, reason: "Stepping now…" };
  return { enabled: true, reason: "" };
}

/**
 * How often to poll, given what is on screen.
 *
 * Anything in flight — ours or a terminal's — is worth watching closely.
 * A screen of finished plans is not worth watching at all, but is still worth
 * checking occasionally, because a terminal may start one at any time.
 */
export function pollIntervalFor(summaries) {
  const busy = (summaries || []).some(
    (s) => s.advancing || s.locked || !s.is_finished
  );
  return busy ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // Always textContent, never innerHTML: every name on this screen is a folder
  // name off the user's disk, and folder names can contain anything at all.
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function figure(label, value) {
  const wrap = el("div", "plan-figure");
  wrap.appendChild(el("span", "plan-figure-label", label));
  wrap.appendChild(el("strong", null, value));
  return wrap;
}

function renderGroupTable(plan) {
  const table = el("table", "plan-group-table");

  const head = el("thead");
  const headRow = el("tr");
  // Sent, back, and short — per company, because "did it do these pages" is
  // asked about a company far more often than about a whole plan.
  const columns = [
    ["Company", false],
    ["Sent", true],
    ["Back", true],
    ["Missing", true],
    ["State", false],
    ["Job", false],
  ];
  columns.forEach(([heading, numeric]) => {
    headRow.appendChild(el("th", numeric ? "num" : null, heading));
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el("tbody");
  plan.groups.forEach((group) => {
    const row = el("tr");

    const nameCell = el("td");
    nameCell.appendChild(el("span", "plan-group-name", group.name));
    if (group.retry_pass) {
      nameCell.appendChild(
        el("span", "plan-retry-tag", `retry ${group.retry_pass}`)
      );
    }
    if (group.error) {
      nameCell.appendChild(el("div", "plan-group-error", group.error));
    }
    row.appendChild(nameCell);

    row.appendChild(el("td", "num", (group.pages || 0).toLocaleString()));
    row.appendChild(el("td", "num", (group.converted || 0).toLocaleString()));

    const missing = group.missing || 0;
    row.appendChild(el("td", missing ? "num short" : "num", missing ? missing.toLocaleString() : "—"));

    const badge = groupBadge(group);
    const stateCell = el("td");
    stateCell.appendChild(el("span", `plan-state ${badge.className}`, badge.text));
    row.appendChild(stateCell);

    row.appendChild(el("td", "plan-job-id", group.job_id || "—"));
    body.appendChild(row);
  });
  table.appendChild(body);

  return table;
}

function renderPlanCard(summary) {
  const card = el("div", "plan-card");
  if (summary.advancing || summary.locked) card.classList.add("busy");

  // --- header -------------------------------------------------------
  const header = el("div", "plan-card-header");

  const heading = el("div", "plan-card-heading");
  const title = el("h4", "plan-card-title", planLabel(summary.id));
  heading.appendChild(title);

  const meta = el("div", "plan-card-meta");
  meta.appendChild(el("code", "plan-id", summary.id));
  meta.appendChild(el("span", null, summary.model));
  meta.appendChild(el("span", null, `${summary.groups} groups`));
  heading.appendChild(meta);
  header.appendChild(heading);

  const badge = planBadge(summary);
  header.appendChild(el("span", `plan-state ${badge.className}`, badge.text));
  card.appendChild(header);

  // --- progress -----------------------------------------------------
  // The bar measures pages that came back, not groups that finished. A plan can
  // tick off every group and still be short, and the bar should not say
  // otherwise.
  const total = summary.total_pages || 0;
  const done = summary.converted_pages || 0;
  const track = el("div", "plan-progress-track");
  const fill = el("div", "plan-progress-fill");
  fill.style.width = total ? `${Math.min(100, (done / total) * 100)}%` : "0%";
  track.appendChild(fill);
  card.appendChild(track);

  const figures = el("div", "plan-figures");
  // Sent, and got back. Those are the two numbers you want when asking whether
  // a run worked, and neither of them is "how far through its groups it is".
  figures.appendChild(figure("Pages sent", (summary.total_pages || 0).toLocaleString()));
  figures.appendChild(figure("Transcribed", (summary.converted_pages || 0).toLocaleString()));

  const shortfall = summary.missing_pages || 0;
  const missingFigure = figure("Missing", shortfall.toLocaleString());
  if (shortfall) missingFigure.classList.add("short");
  figures.appendChild(missingFigure);

  figures.appendChild(figure("Batch cost", cost(summary.estimated_batch_cost_usd)));
  // Labelled "account" because that is what it counts: Google's ceiling is per
  // account, so this figure is the same on every card and would otherwise read
  // as this plan's own queue.
  figures.appendChild(figure(
    "Account queue",
    `${Math.round((summary.enqueued_tokens || 0) / 1000).toLocaleString()}K of ` +
    `${Math.round((summary.max_enqueued_tokens || 0) / 1e6)}M tokens`
  ));
  card.appendChild(figures);

  // --- actions ------------------------------------------------------
  const actions = el("div", "plan-card-actions");
  const availability = stepAvailability(summary);

  const stepBtn = el("button", "btn btn-sm btn-accent", "Take a step");
  stepBtn.disabled = !availability.enabled;
  stepBtn.title = "Collect whatever has finished, then submit as much as the allowance allows";
  stepBtn.addEventListener("click", () => stepPlan(summary.id, {}, stepBtn));
  actions.appendChild(stepBtn);

  const detail = details.get(summary.id);
  const blocked = missingPages(detail, summary.max_retry_passes);
  const retry = retryAvailability(summary);

  if (blocked.retryable) {
    const retryBtn = el(
      "button",
      "btn btn-sm btn-secondary",
      `Retry ${blocked.retryable.toLocaleString()} missing page${blocked.retryable === 1 ? "" : "s"}`
    );
    retryBtn.disabled = !retry.enabled;
    retryBtn.title = "Ask again for the pages that came back empty, in different words";
    retryBtn.addEventListener(
      "click",
      () => stepPlan(summary.id, { retryBlocked: true }, retryBtn)
    );
    actions.appendChild(retryBtn);
  }

  const failed = failedGroupCount(summary);
  if (failed) {
    const failedBtn = el(
      "button",
      "btn btn-sm btn-secondary",
      `Retry ${failed} failed group${failed === 1 ? "" : "s"}`
    );
    failedBtn.disabled = !retry.enabled;
    failedBtn.title =
      "Put them back in the queue. Pages already converted are skipped, " +
      "so only what is missing is sent again";
    failedBtn.addEventListener(
      "click",
      () => stepPlan(summary.id, { retryFailed: true }, failedBtn)
    );
    actions.appendChild(failedBtn);
  }

  const isOpen = expanded.has(summary.id);
  const toggle = el(
    "button",
    "btn btn-sm btn-text-link",
    isOpen ? "Hide groups" : "Show groups"
  );
  toggle.addEventListener("click", () => {
    if (expanded.has(summary.id)) expanded.delete(summary.id);
    else expanded.add(summary.id);
    refresh();
  });
  actions.appendChild(toggle);

  // The step button's reason, unless it is only "finished" and there is still a
  // retry to offer — in which case saying "every group has finished" next to a
  // live retry button reads as though the retry were pointless.
  const hasSomethingToRetry = blocked.retryable || failed;
  const note = (availability.reason && !(summary.is_finished && hasSomethingToRetry))
    ? availability.reason
    : retry.reason;
  if (note) actions.appendChild(el("span", "plan-action-note", note));

  // Pages that have used every reworded prompt. Nothing on this screen will
  // recover them, and saying so is the only honest thing to do — they are
  // gaps in the transcript, not work still in progress.
  if (blocked.exhausted) {
    const n = blocked.exhausted;
    actions.appendChild(el(
      "span",
      "plan-action-warn",
      `${n.toLocaleString()} page${n === 1 ? " has" : "s have"} no text: Gemini declined to ` +
      `transcribe ${n === 1 ? "it" : "them"}, and all ${summary.max_retry_passes || 3} rewordings ` +
      `were declined too. Converting ${n === 1 ? "it" : "them"} normally, or on another model, ` +
      `is what is left to try.`
    ));
  }

  card.appendChild(actions);

  // --- groups -------------------------------------------------------
  if (isOpen) {
    const body = el("div", "plan-group-body");
    const scroller = el("div", "plan-group-scroll");
    if (detail && detail.groups) {
      scroller.appendChild(renderGroupTable(detail));
    } else {
      scroller.appendChild(el("p", "text-muted text-sm", "Loading groups…"));
    }
    body.appendChild(scroller);
    card.appendChild(body);
  }

  return card;
}

function renderPlans() {
  const list = $("batchPlanList");
  if (!list) return;

  list.setAttribute("aria-busy", "false");
  list.innerHTML = "";

  if (!plans.length) {
    const empty = el("div", "plan-empty");
    empty.appendChild(el("h4", null, "No batch plans yet"));
    empty.appendChild(el(
      "p",
      "text-muted text-sm",
      "A plan breaks the workspace into one job per company and runs them within " +
      "the account's limits. Making one submits nothing — it works out the " +
      "grouping and the price first."
    ));
    list.appendChild(empty);
    return;
  }

  plans.forEach((summary) => list.appendChild(renderPlanCard(summary)));
}

function refresh() {
  renderPlans();
  // A newly opened plan has no detail yet; fetch it, then draw again.
  expanded.forEach((planId) => {
    if (!details.has(planId)) loadPlanDetail(planId);
  });
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

async function loadPlanDetail(planId, redraw = true) {
  try {
    const res = await fetch(`/api/batch/plans/${encodeURIComponent(planId)}`);
    if (!res.ok) return;
    const data = await res.json();
    details.set(planId, data.plan);
    // A bulk refresh draws once at the end rather than once per plan, which
    // would otherwise rebuild the whole list thirty-eight times.
    if (redraw) renderPlans();
  } catch (e) {
    console.error("Could not load plan", planId, e);
  }
}

export async function fetchBatchPlans() {
  try {
    const res = await fetch("/api/batch/plans");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    plans = data.plans || [];

    // Every plan's detail, not just the open ones. Two reasons: an open plan
    // needs its groups kept current, and a *closed* plan needs its refused-page
    // count, because that is what puts the retry button on the card at all —
    // and a button you only find by opening something first is a button nobody
    // finds. These are small local file reads, one per plan.
    await Promise.all(plans.map((summary) => loadPlanDetail(summary.id, false)));

    renderPlans();
    schedulePoll();
  } catch (e) {
    console.error("Could not load batch plans:", e);
    const list = $("batchPlanList");
    if (list && !plans.length) {
      list.setAttribute("aria-busy", "false");
      list.innerHTML = "";
      list.appendChild(el("div", "plan-empty", `Could not load plans: ${e.message}`));
    }
  }
}

function schedulePoll() {
  const wanted = pollIntervalFor(plans);
  // Only rebuild the timer when the cadence actually changes, so a plan that
  // stays busy is not restarting its own poll every time it reports in.
  if (pollTimer && pollInterval === wanted) return;

  if (pollTimer) clearInterval(pollTimer);
  pollInterval = wanted;
  pollTimer = setInterval(() => fetchBatchPlans(), wanted);
}

async function stepPlan(planId, options, button) {
  const originalText = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    button.textContent = "Starting…";
  }

  try {
    const res = await fetch(`/api/batch/plans/${encodeURIComponent(planId)}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        only: options.only || null,
        max_groups: options.maxGroups || null,
        retry_blocked: Boolean(options.retryBlocked),
        retry_failed: Boolean(options.retryFailed)
      })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showToast("Cannot step this plan", data.detail || `HTTP ${res.status}`, true);
      return;
    }

    appState.recentLogs.push({
      text: `[INFO] Advancing batch plan ${planId}${options.retryBlocked ? " (retrying refused pages)" : ""}.`,
      type: "normal"
    });
    eventBus.emit("logs:updated");
    showToast(
      "Step under way",
      "Collecting what has finished and submitting what fits. This screen will keep up."
    );

    // The step runs on a thread on the server, so the plan file is what says
    // how far it got — read it, rather than assuming anything from this reply.
    await fetchBatchPlans();
  } catch (e) {
    showToast("Cannot step this plan", e.message, true);
  } finally {
    if (button) {
      button.disabled = false;
      if (originalText !== null) button.textContent = originalText;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Making a plan
 * ------------------------------------------------------------------ */

function populateComposer() {
  const modelSelect = $("planModelSelect");
  if (modelSelect) {
    modelSelect.innerHTML = "";
    const groups = groupModelsForSelect(appState.pricing, appState.defaultModel || appState.model);
    if (!groups.length) {
      const fallback = el("option", null, appState.model);
      fallback.value = appState.model;
      modelSelect.appendChild(fallback);
    } else {
      groups.forEach((group) => {
        const optgroup = document.createElement("optgroup");
        optgroup.label = group.label;
        group.models.forEach((model) => {
          const option = el("option", null, model.label);
          option.value = model.value;
          optgroup.appendChild(option);
        });
        modelSelect.appendChild(optgroup);
      });
      modelSelect.value = appState.model;
    }
  }

  const presetSelect = $("planPresetSelect");
  if (presetSelect) {
    presetSelect.innerHTML = "";
    Object.entries(appState.presets || {}).forEach(([key, preset]) => {
      const option = el("option", null, preset.name || key);
      option.value = key;
      presetSelect.appendChild(option);
    });
    presetSelect.value = appState.currentPreset || "financial";
  }

  const scope = $("planComposerScope");
  if (scope) {
    scope.textContent = appState.rootDirectory
      ? `Whole workspace: ${appState.rootDirectory}`
      : "Whole workspace.";
  }
}

async function createPlan(button) {
  const model = $("planModelSelect") ? $("planModelSelect").value : appState.model;
  const preset = $("planPresetSelect") ? $("planPresetSelect").value : "financial";
  const force = $("planForceCheckbox") ? $("planForceCheckbox").checked : false;
  const ceiling = $("planTokenCeiling") ? Number($("planTokenCeiling").value) : null;

  button.disabled = true;
  button.textContent = "Working it out…";

  try {
    const res = await fetch("/api/batch/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        preset,
        force,
        max_enqueued_tokens: ceiling || null
      })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showToast("Could not make a plan", data.detail || `HTTP ${res.status}`, true);
      return;
    }

    const summary = data.summary || {};
    $("planComposer").style.display = "none";
    expanded.add(summary.id);
    await fetchBatchPlans();
    showToast(
      "Plan ready",
      `${summary.groups} groups, ${(summary.total_pages || 0).toLocaleString()} pages, ` +
      `about ${cost(summary.estimated_batch_cost_usd)}. Nothing has been submitted yet.`
    );
  } catch (e) {
    showToast("Could not make a plan", e.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Work out the plan";
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

export function initBatchPlans() {
  const newBtn = $("newBatchPlanBtn");
  const cancelBtn = $("cancelPlanComposerBtn");
  const createBtn = $("createPlanBtn");
  const composer = $("planComposer");

  if (newBtn && composer) {
    newBtn.addEventListener("click", () => {
      const showing = composer.style.display !== "none";
      composer.style.display = showing ? "none" : "block";
      if (!showing) populateComposer();
    });
  }

  if (cancelBtn && composer) {
    cancelBtn.addEventListener("click", () => {
      composer.style.display = "none";
    });
  }

  if (createBtn) {
    createBtn.addEventListener("click", () => createPlan(createBtn));
  }

  // The one Refresh button on the panel covers both halves of the screen.
  const refreshBtn = $("refreshBatchJobsStandaloneBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", () => fetchBatchPlans());

  eventBus.on("studio:batches:activated", () => fetchBatchPlans());
  eventBus.on("pricing:updated", () => populateComposer());
}
