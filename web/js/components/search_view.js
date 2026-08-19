/**
 * GooseQuill — Workspace-wide Search
 *
 * Studio's find bar searches the document you already have open. This searches
 * every converted document in the workspace, which is the question people
 * actually arrive with: "which filing mentions this, and where?"
 *
 * Matching happens on the server, over the Markdown on disk. Results come back
 * grouped by document with the page each hit came from, so a result is a place
 * you can go to rather than just a filename.
 */

import { eventBus } from "../state.js";
import { findDocumentByPath } from "../services/document_catalog.js";
import { showToast } from "../services/notifications.js";

/**
 * How many documents a page of results holds.
 *
 * The search always finds and ranks every match; this only decides how many
 * arrive at once. It used to be a hard ceiling — "Showing the 100 documents
 * with the most matches, of 118" — with no way to see the other eighteen.
 */
const PAGE_SIZE = 100;

const state = {
  query: "",
  matchCase: false,
  wholeWord: false,
  running: false,
  requestToken: 0,
  offset: 0,
  debounceTimer: null
};

export function initSearchView() {
  const input = document.getElementById("workspaceSearchInput");
  const caseBtn = document.getElementById("workspaceSearchCaseBtn");
  const wordBtn = document.getElementById("workspaceSearchWordBtn");
  const clearBtn = document.getElementById("workspaceSearchClearBtn");

  if (input) {
    input.addEventListener("input", () => scheduleSearch(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        clearTimeout(state.debounceTimer);
        runSearch(input.value);
      } else if (event.key === "Escape") {
        input.value = "";
        scheduleSearch("");
      }
    });
  }

  if (caseBtn) {
    caseBtn.addEventListener("click", () => {
      state.matchCase = !state.matchCase;
      caseBtn.classList.toggle("active", state.matchCase);
      caseBtn.setAttribute("aria-pressed", String(state.matchCase));
      if (state.query) runSearch(state.query);
    });
  }

  if (wordBtn) {
    wordBtn.addEventListener("click", () => {
      state.wholeWord = !state.wholeWord;
      wordBtn.classList.toggle("active", state.wholeWord);
      wordBtn.setAttribute("aria-pressed", String(state.wholeWord));
      if (state.query) runSearch(state.query);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (input) input.value = "";
      scheduleSearch("");
      if (input) input.focus();
    });
  }

  eventBus.on("studio:search:activated", () => {
    const el = document.getElementById("workspaceSearchInput");
    if (el) el.focus();
  });
}

function scheduleSearch(value) {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => runSearch(value), 250);
}

async function runSearch(rawQuery, { offset = 0, append = false } = {}) {
  const query = (rawQuery || "").trim();
  state.query = query;

  const results = document.getElementById("workspaceSearchResults");
  const summary = document.getElementById("workspaceSearchSummary");
  if (!results) return;

  if (!query) {
    renderIdle(results, summary);
    return;
  }

  state.offset = offset;

  // Every keystroke can start a request; only the newest one may paint.
  const token = ++state.requestToken;
  state.running = true;
  if (summary && !append) summary.textContent = "Searching…";

  try {
    const params = new URLSearchParams({
      q: query,
      match_case: String(state.matchCase),
      whole_word: String(state.wholeWord),
      max_documents: String(PAGE_SIZE),
      max_matches_per_document: "5",
      offset: String(offset)
    });
    const res = await fetch(`/api/search?${params.toString()}`);
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const data = await res.json();

    if (token !== state.requestToken) return;
    renderResults(data, results, summary, { append });
  } catch (error) {
    if (token !== state.requestToken) return;
    if (summary) summary.textContent = "";
    results.innerHTML = `<div class="search-empty text-danger">Search failed: ${escapeHtml(error.message)}</div>`;
  } finally {
    if (token === state.requestToken) state.running = false;
  }
}

function renderIdle(results, summary) {
  if (summary) summary.textContent = "";
  results.innerHTML = `
    <div class="search-empty">
      <div class="search-empty-icon">🔎</div>
      <div class="search-empty-title">Search every converted document</div>
      <p class="text-muted text-sm">Type a phrase to find it across the whole workspace. Results show the page it appears on, and open the document there.</p>
    </div>
  `;
}

function renderResults(data, container, summary, { append = false } = {}) {
  const { results, total_matches: total, documents_matched: matched, documents_searched: searched, truncated } = data;

  if (summary) {
    summary.textContent = total === 0
      ? `No matches in ${searched} documents`
      : `${total.toLocaleString()} ${total === 1 ? "match" : "matches"} in ${matched} of ${searched} documents`;
  }

  if (!results.length && !append) {
    container.innerHTML = `
      <div class="search-empty">
        <div class="search-empty-icon">∅</div>
        <div class="search-empty-title">Nothing found for “${escapeHtml(data.query)}”</div>
        <p class="text-muted text-sm">Try a shorter phrase, or turn off whole-word matching.</p>
      </div>
    `;
    return;
  }

  const fragment = document.createDocumentFragment();

  results.forEach((doc) => {
    const card = document.createElement("div");
    card.className = "search-result-card";

    const snippets = doc.matches
      .map(
        (match) => `
        <button class="search-snippet" data-pdf="${escapeHtml(doc.pdf_path)}" data-page="${match.page || 1}">
          <span class="search-snippet-page">${match.page ? `p${match.page}` : "—"}</span>
          <span class="search-snippet-text">${renderSnippet(match)}</span>
        </button>`
      )
      .join("");

    const remaining = doc.match_count - doc.matches.length;

    card.innerHTML = `
      <div class="search-result-header">
        <div class="search-result-titles">
          <div class="search-result-name">${escapeHtml(doc.stem)}</div>
          <div class="search-result-folder">${escapeHtml(doc.folder)}</div>
        </div>
        <span class="search-result-count">${doc.match_count} ${doc.match_count === 1 ? "match" : "matches"}</span>
      </div>
      <div class="search-snippets">${snippets}</div>
      ${remaining > 0 ? `<div class="search-result-more text-muted text-xs">+ ${remaining} more in this document</div>` : ""}
    `;

    fragment.appendChild(card);
  });

  // A new search replaces what is on screen; "load more" adds to it.
  if (!append) container.innerHTML = "";
  container.querySelector(".search-load-more")?.remove();
  container.appendChild(fragment);

  // Derived rather than taken on trust: the count on screen against the count
  // that matched is the same question the server answers with `has_more`, and
  // computing it here means a server that has not been restarted since this
  // shipped degrades to a correct answer instead of a wrong one.
  const shown = (data.offset || 0) + results.length;
  if (shown < matched) {
    const more = document.createElement("div");
    more.className = "search-load-more";
    more.innerHTML = `
      <button class="btn btn-secondary" type="button">
        Load more documents
      </button>
      <span class="text-muted text-xs">${shown.toLocaleString()} of ${matched.toLocaleString()} documents shown</span>
    `;
    const button = more.querySelector("button");
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "Loading…";
      runSearch(state.query, { offset: shown, append: true });
    });
    container.appendChild(more);
  } else if (matched > PAGE_SIZE) {
    const done = document.createElement("div");
    done.className = "search-load-more";
    done.innerHTML = `<span class="text-muted text-xs">All ${matched.toLocaleString()} matching documents shown</span>`;
    container.appendChild(done);
  }

  container.querySelectorAll(".search-snippet").forEach((btn) => {
    btn.addEventListener("click", () => openResult(btn.dataset.pdf, parseInt(btn.dataset.page, 10)));
  });
}

/**
 * Build a snippet with the hit marked.
 *
 * The server returns offsets rather than markup, so the text is escaped here
 * and the highlight inserted around it — search results are never a route for
 * document content to become HTML.
 */
function renderSnippet(match) {
  const text = match.text || "";
  const start = Math.max(0, Math.min(match.match_start, text.length));
  const end = Math.max(start, Math.min(match.match_end, text.length));

  const before = escapeHtml(text.slice(0, start));
  const hit = escapeHtml(text.slice(start, end));
  const after = escapeHtml(text.slice(end));

  const lead = match.prefix_truncated ? "…" : "";
  const tail = match.suffix_truncated ? "…" : "";

  return `${lead}${before}<mark>${hit}</mark>${after}${tail}`;
}

function openResult(pdfPath, page) {
  const doc = findDocumentByPath(pdfPath);
  if (!doc) {
    showToast("Cannot open document", "It is no longer in the workspace listing.", true);
    return;
  }
  eventBus.emit("studio:document:open", { doc, startPage: Number.isFinite(page) ? page : 1 });
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
