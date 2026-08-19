/**
 * GooseQuill — Token Economics
 *
 * The rate card was ten rows of hand-written HTML sitting under a button
 * labelled "Sync Latest Rates". Syncing did update the registry the estimates
 * are costed against, and reported success — but the table underneath never
 * moved, so the one number the reader came to check was the one thing the
 * button could not change. A model added to the registry never showed up
 * either.
 *
 * The table is now drawn from `/api/pricing`, which is the same registry the
 * costs are calculated from. The two cannot disagree.
 */

import { appState, eventBus } from "../state.js";
import { apiClient } from "../services/api_client.js";

const COLUMNS = 4;

/** Which badge, if any, a model's tier earns. Exported for testing. */
export function badgeFor(key, tier, defaultModel) {
  if (key === defaultModel) return { text: "Default", className: "default" };
  if (/pro/i.test(tier)) return { text: "Pro", className: "pro" };
  if (/frontier/i.test(tier)) return { text: "Frontier", className: "frontier" };
  if (/economy/i.test(tier)) return { text: "Economy", className: "" };
  if (/preview/i.test(tier)) return { text: "Preview", className: "" };
  return null;
}

/**
 * "$0.25", "$1.50", "$1.875" — two decimals unless the rate genuinely needs a
 * third. Rounding to two would print the half-price batch rate for a $3.75
 * model as $1.88, which is not what anyone is charged.
 * Exported for testing.
 */
export function money(value) {
  // Number(null) and Number("") are both 0, which would print a missing rate as
  // "$0.00" — a model that costs nothing rather than one whose price we do not
  // have. Say we do not know.
  if (value === null || value === undefined || value === "") return "—";

  const n = Number(value);
  if (!Number.isFinite(n)) return "—";

  let out = n.toFixed(3).replace(/0+$/, "");
  if (out.endsWith(".")) out = out.slice(0, -1);

  const [whole, fraction = ""] = out.split(".");
  return `$${whole}.${fraction.padEnd(2, "0")}`;
}

/**
 * How long ago the rate card was fetched, in words, and whether that is long
 * enough to distrust.
 *
 * `/api/pricing` serves the registry, and the registry is the rates bundled
 * with this release until somebody presses Sync. Both look identical in the
 * table — the same figures, laid out the same way — so a card frozen at
 * whenever the release was cut reads exactly like one fetched this morning.
 * This is the line that tells them apart.
 *
 * `now` is a parameter so the wording can be tested without waiting.
 * Exported for testing.
 */
export function syncStampText(syncedAt, now = Date.now()) {
  const STALE_AFTER_DAYS = 30;

  if (!syncedAt) {
    return {
      text: "Never synced — showing the rates bundled with this release",
      title: "These are the figures GooseQuill shipped with. Sync to check them against Google's published rates.",
      stale: true
    };
  }

  const then = Date.parse(syncedAt);
  if (!Number.isFinite(then)) {
    // A cache file we cannot read the date out of. Saying so is better than
    // printing "Invalid Date" or silently claiming the rates are fresh.
    return {
      text: "Synced at an unknown time",
      title: `The recorded sync time could not be read: ${syncedAt}`,
      stale: true
    };
  }

  // Signed on purpose. A browser clock a little behind the server's makes this
  // negative, and the "just now" branch below absorbs that — clamping it to
  // zero here would be a second guard doing the same job, and an untestable one.
  const seconds = Math.round((now - then) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let when;
  if (seconds < 60) when = "just now";
  else if (minutes < 60) when = `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  else if (hours < 24) when = `${hours} hour${hours === 1 ? "" : "s"} ago`;
  else when = `${days} day${days === 1 ? "" : "s"} ago`;

  return {
    text: `Rates synced ${when}`,
    // The exact moment, in the reader's own timezone, for anyone who wants it.
    title: new Date(then).toLocaleString(),
    stale: days >= STALE_AFTER_DAYS
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function messageRow(text, modifier = "text-muted") {
  return `<tr><td colspan="${COLUMNS}" class="${modifier} text-center" style="padding: 28px;">${escapeHtml(text)}</td></tr>`;
}

function rowFor(key, model, defaultModel) {
  const badge = badgeFor(key, model.tier || "", defaultModel);
  const badgeHtml = badge
    ? ` <span class="badge-tag ${badge.className}">${escapeHtml(badge.text)}</span>`
    : "";

  return `
    <tr${key === defaultModel ? ' class="highlight-row"' : ""}>
      <td><strong>${escapeHtml(model.name || key)}</strong>${badgeHtml}</td>
      <td>${money(model.input_standard)} / M tokens</td>
      <td>${money(model.output_standard)} / M tokens</td>
      <td><strong class="text-night">${money(model.input_batch)} / ${money(model.output_batch)}</strong></td>
    </tr>`;
}

/** Say when these figures were last checked against Google's. */
function renderSyncStamp() {
  const stamp = document.getElementById("rateCardSyncedAt");
  if (!stamp) return;

  const { text, title, stale } = syncStampText(appState.pricingSyncedAt);
  stamp.textContent = text;
  stamp.title = title;
  stamp.classList.toggle("stale", stale);
}

/** Draw whatever pricing we currently hold. */
export function renderRateCard() {
  renderSyncStamp();

  const body = document.getElementById("rateCardTableBody");
  if (!body) return;

  const pricing = appState.pricing || {};
  const keys = Object.keys(pricing);

  if (keys.length === 0) {
    body.innerHTML = messageRow("Rate card unavailable — the server did not return any pricing.");
    return;
  }

  body.innerHTML = keys
    .map((key) => rowFor(key, pricing[key] || {}, appState.defaultModel))
    .join("");
}

/** Fetch the rate card once, and show why if it cannot be had. */
async function loadRateCard() {
  const body = document.getElementById("rateCardTableBody");
  if (body) body.innerHTML = messageRow("Loading the current rate card…");

  try {
    const res = await apiClient.getPricing();
    appState.pricing = (res && res.pricing) || {};
    appState.defaultModel = (res && res.default_model) || appState.model;
    appState.pricingSyncedAt = (res && res.synced_at) || null;
    renderRateCard();
  } catch (e) {
    if (body) {
      body.innerHTML = messageRow(`Could not load the rate card: ${e.message}`, "text-danger");
    }
  }
}

export function initEconomicsView() {
  // A sync replaces the registry; the table has to follow it or the button is
  // telling the reader something the page then contradicts.
  eventBus.on("pricing:updated", () => renderRateCard());

  // Drawn on first arrival rather than at startup: the rates do not change
  // while the page is open unless a sync changes them, and most sessions never
  // open this view at all.
  let loaded = false;
  eventBus.on("studio:economics:activated", () => {
    if (loaded) return;
    loaded = true;
    loadRateCard();
  });
}
