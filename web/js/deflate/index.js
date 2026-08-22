/**
 * GooseQuill — Deflate.
 *
 * Boilerplate removal, framed around the question that makes it worth doing:
 * will this set of filings fit somewhere Claude can read all of it at once.
 * The budget meter is the point of the view; the settings below it are how you
 * move the number.
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";

// Bytes per token. Markdown of dense financial prose runs a little under four
// characters to the token; four is the conventional estimate and errs towards
// over-counting, which is the safe direction for a budget.
const BYTES_PER_TOKEN = 4;

let candidates = [];
let selected = new Set();
let pollTimer = null;
let lastResults = null;

const $ = (id) => document.getElementById(id);

function tokens(bytes) {
  return Math.round(bytes / BYTES_PER_TOKEN);
}

function compactTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M tokens`;
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString()}K tokens`;
  return `${n.toLocaleString()} tokens`;
}

/**
 * How much smaller the selection is expected to get.
 *
 * Filings already deflated report their real figure. The rest are estimated
 * from whatever this workspace has actually achieved so far, and only fall back
 * to a fixed guess when nothing has been deflated yet — a number pulled from
 * the air is worse than no number, but a number measured on a neighbouring
 * filing of the same corpus is worth having.
 */
function projectedSaving() {
  const measured = candidates.filter((f) => f.deflated_size != null && f.size > 0);
  if (!measured.length) return 0.12;
  const original = measured.reduce((t, f) => t + f.size, 0);
  const light = measured.reduce((t, f) => t + f.deflated_size, 0);
  return original > 0 ? Math.max(0, 1 - light / original) : 0.12;
}

function selectedFiles() {
  return candidates.filter((f) => selected.has(f.path));
}

function renderBudget() {
  const files = selectedFiles();
  const budget = Number($("deflateBudgetTarget").value) || 2000000;
  const originalBytes = files.reduce((t, f) => t + (f.size || 0), 0);

  const rate = projectedSaving();
  const lightBytes = files.reduce(
    (t, f) => t + (f.deflated_size != null ? f.deflated_size : f.size * (1 - rate)),
    0
  );

  const originalTokens = tokens(originalBytes);
  const lightTokens = tokens(lightBytes);
  const pct = budget > 0 ? (lightTokens / budget) * 100 : 0;

  $("deflateFigureSelected").textContent =
    `${files.length} filing${files.length === 1 ? "" : "s"}`;
  $("deflateFigureOriginal").textContent = originalBytes ? compactTokens(originalTokens) : "—";
  $("deflateFigureLight").textContent = lightBytes ? compactTokens(lightTokens) : "—";
  $("deflateFigurePct").textContent = originalBytes ? `${pct.toFixed(0)}%` : "—";

  const fill = $("deflateMeterFill");
  const saving = $("deflateMeterSaving");
  fill.style.width = `${Math.min(100, pct)}%`;
  saving.style.width = `${Math.min(100, Math.max(0, (originalTokens / budget) * 100 - pct))}%`;
  $("deflateMeter").classList.toggle("over", pct > 100);

  const note = $("deflateBudgetNote");
  if (!files.length) {
    note.textContent = "Select filings to price them against a project.";
    note.className = "deflate-budget-note";
  } else if (pct > 100) {
    const fits = Math.floor((budget / lightTokens) * files.length);
    note.textContent =
      `Over budget by ${compactTokens(lightTokens - budget)} even after deflating. ` +
      `About ${fits} filings of this size would fit — narrow the selection, ` +
      `or split it across more than one project.`;
    note.className = "deflate-budget-note over";
  } else {
    note.textContent =
      `Fits, with ${compactTokens(budget - lightTokens)} to spare. ` +
      `Deflating saves about ${compactTokens(originalTokens - lightTokens)}.`;
    note.className = "deflate-budget-note ok";
  }
}

function renderFileList() {
  const list = $("deflateFileList");
  const query = ($("deflateSearchInput").value || "").toLowerCase().trim();
  const visible = query
    ? candidates.filter(
        (f) => f.name.toLowerCase().includes(query) || f.entity.toLowerCase().includes(query)
      )
    : candidates;

  if (!visible.length) {
    list.innerHTML = `<div class="text-muted text-center" style="padding: 40px;">${
      candidates.length ? "Nothing matches that filter." : "No converted transcripts yet."
    }</div>`;
    return;
  }

  const byEntity = new Map();
  visible.forEach((f) => {
    if (!byEntity.has(f.entity)) byEntity.set(f.entity, []);
    byEntity.get(f.entity).push(f);
  });

  const chunks = [];
  byEntity.forEach((files, entity) => {
    const allOn = files.every((f) => selected.has(f.path));
    chunks.push(`
      <div class="deflate-entity-group">
        <div class="deflate-entity-header">
          <label class="checkbox-pill">
            <input type="checkbox" data-entity="${escapeAttr(entity)}" ${allOn ? "checked" : ""}>
            <span>${escapeHtml(entity)}</span>
          </label>
          <span class="deflate-entity-meta">${files.length} filing${files.length === 1 ? "" : "s"} · ${
            escapeHtml(files[0].peer_group)
          } family</span>
        </div>
        ${files
          .map(
            (f) => `
          <label class="deflate-file-item${selected.has(f.path) ? " selected" : ""}">
            <input type="checkbox" data-path="${escapeAttr(f.path)}" ${
              selected.has(f.path) ? "checked" : ""
            }>
            <span class="deflate-file-title">${escapeHtml(f.stem)}</span>
            <span class="deflate-file-meta">
              ${(f.size / 1024).toFixed(0)} KB
              ${
                f.deflated_size != null
                  ? `<span class="deflate-done-tag">−${Math.round(
                      (1 - f.deflated_size / f.size) * 100
                    )}%</span>`
                  : ""
              }
            </span>
          </label>`
          )
          .join("")}
      </div>`);
  });

  list.innerHTML = chunks.join("");
  $("deflateSelectedBadge").textContent = `${selected.size} Selected`;
}

function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text == null ? "" : String(text);
  return d.innerHTML;
}
function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function renderResults(results) {
  lastResults = results;
  const box = $("deflateResults");
  box.style.display = "block";

  const saved = results.total_original_bytes - results.total_lightweight_bytes;
  const notes = [];
  if (results.corpus_too_small) {
    notes.push(
      "Fewer than two companies were compared, so only page scaffolding was removed."
    );
  }
  if (results.mode === "safe" && results.verification && !results.verification.available) {
    notes.push(
      "The classifier could not be reached, and verified mode removes a section only on an explicit verdict — no prose was removed."
    );
  }

  $("deflateResultsSummary").innerHTML = `
    <div class="deflate-budget-figures">
      <div class="deflate-figure">
        <span class="deflate-figure-label">Reduction</span>
        <strong class="text-accent">${results.total_reduction_pct}%</strong>
      </div>
      <div class="deflate-figure">
        <span class="deflate-figure-label">Tokens saved</span>
        <strong>${compactTokens(tokens(saved))}</strong>
      </div>
      <div class="deflate-figure">
        <span class="deflate-figure-label">Patterns</span>
        <strong>${results.pattern_count.toLocaleString()}</strong>
      </div>
      <div class="deflate-figure">
        <span class="deflate-figure-label">Compared across</span>
        <strong>${results.entities_scanned} companies</strong>
      </div>
    </div>
    ${notes.map((n) => `<p class="deflate-budget-note over">${escapeHtml(n)}</p>`).join("")}
  `;

  $("deflatePanelPatterns").innerHTML = results.patterns.length
    ? `<table class="deflate-table">
         <thead><tr><th>Section</th><th>Companies</th><th>Filings</th><th>Words</th></tr></thead>
         <tbody>${results.patterns
           .map(
             (p) => `<tr>
               <td title="${escapeAttr(p.example)}">${escapeHtml(p.heading)}</td>
               <td class="num">${p.companies}</td>
               <td class="num">${p.filings}</td>
               <td class="num">${p.words}</td>
             </tr>`
           )
           .join("")}</tbody>
       </table>`
    : `<p class="text-muted" style="padding: 16px;">No passage was shared by enough separate companies to count as boilerplate.</p>`;

  $("deflatePanelFiles").innerHTML = `
    <table class="deflate-table">
      <thead><tr><th>Filing</th><th>Company</th><th>Before</th><th>After</th><th>Cut</th></tr></thead>
      <tbody>${results.files
        .map(
          (f) => `<tr>
            <td>${escapeHtml(f.name)}</td>
            <td>${escapeHtml(f.entity)}</td>
            <td class="num">${(f.original_size / 1024).toFixed(0)} KB</td>
            <td class="num">${(f.lightweight_size / 1024).toFixed(0)} KB</td>
            <td class="num">${f.reduction_pct}%</td>
          </tr>`
        )
        .join("")}</tbody>
    </table>`;

  $("deflatePanelRestated").innerHTML = results.restatements.length
    ? `<p class="deflate-explainer">Word-for-word repeats of an earlier filing by the same company.
         The earliest filing keeps the text; later ones point at it.</p>
       <table class="deflate-table">
         <thead><tr><th>Section</th><th>Later copies replaced</th></tr></thead>
         <tbody>${results.restatements
           .map(
             (r) =>
               `<tr><td>${escapeHtml(r.heading)}</td><td class="num">${r.copies}</td></tr>`
           )
           .join("")}</tbody>
       </table>`
    : `<p class="text-muted" style="padding: 16px;">Nothing was repeated word-for-word within a single company.</p>`;

  const wrote = results.files.some((f) => f.written);
  $("deflateHandoff").style.display = wrote ? "block" : "none";
}

async function poll() {
  try {
    const res = await fetch("/api/deflate/status");
    const state = await res.json();

    if (state.is_running) {
      $("deflateProgress").style.display = "inline-flex";
      $("deflateProgressText").textContent =
        state.phase === "scanning"
          ? "Reading the corpus for repeated passages…"
          : `Deflating ${state.files_done} of ${state.total_files}…`;
      return;
    }

    clearInterval(pollTimer);
    pollTimer = null;
    $("deflateProgress").style.display = "none";
    $("deflateRunBtn").disabled = false;
    $("deflatePreviewBtn").disabled = false;

    if (state.error) {
      showToast(`Deflation failed: ${state.error}`, "error");
      return;
    }
    if (state.results) {
      renderResults(state.results);
      showToast(
        `Deflated ${state.results.files_deflated} filings — ${state.results.total_reduction_pct}% smaller.`,
        "success"
      );
      await loadCandidates();
    }
  } catch (e) {
    clearInterval(pollTimer);
    pollTimer = null;
    $("deflateProgress").style.display = "none";
    $("deflateRunBtn").disabled = false;
    $("deflatePreviewBtn").disabled = false;
  }
}

async function run(write) {
  if (!selected.size) {
    showToast("Select some filings first.", "warning");
    return;
  }

  $("deflateRunBtn").disabled = true;
  $("deflatePreviewBtn").disabled = true;
  $("deflateProgress").style.display = "inline-flex";
  $("deflateProgressText").textContent = "Starting…";

  try {
    const res = await fetch("/api/deflate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [...selected],
        mode: $("deflateMode").value,
        threshold: Number($("deflateThreshold").value) || 3,
        peer_threshold: Number($("deflatePeerThreshold").value) || 2,
        similarity: Number($("deflateSimilarity").value) || 0.85,
        model: appState.model,
        compare_against_selection: $("deflateCompareSelection").checked,
        write
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, 700);
  } catch (e) {
    $("deflateProgress").style.display = "none";
    $("deflateRunBtn").disabled = false;
    $("deflatePreviewBtn").disabled = false;
    showToast(e.message, "error");
  }
}

async function loadCandidates() {
  try {
    const res = await fetch("/api/deflate/candidates");
    const data = await res.json();
    candidates = data.files || [];
    // Drop selections for files that have since gone.
    const live = new Set(candidates.map((f) => f.path));
    selected = new Set([...selected].filter((p) => live.has(p)));
    renderFileList();
    renderBudget();
  } catch (e) {
    $("deflateFileList").innerHTML =
      `<div class="text-muted text-center" style="padding: 40px;">Could not load transcripts.</div>`;
  }
}

export function initDeflateView() {
  const list = $("deflateFileList");
  if (!list) return;

  list.addEventListener("change", (e) => {
    const box = e.target;
    if (box.dataset.path) {
      if (box.checked) selected.add(box.dataset.path);
      else selected.delete(box.dataset.path);
    } else if (box.dataset.entity) {
      candidates
        .filter((f) => f.entity === box.dataset.entity)
        .forEach((f) => (box.checked ? selected.add(f.path) : selected.delete(f.path)));
    } else {
      return;
    }
    renderFileList();
    renderBudget();
  });

  $("deflateSearchInput").addEventListener("input", renderFileList);

  $("deflateSelectAllBtn").addEventListener("click", () => {
    candidates.forEach((f) => selected.add(f.path));
    renderFileList();
    renderBudget();
  });

  $("deflateSelectVisibleBtn").addEventListener("click", () => {
    const query = ($("deflateSearchInput").value || "").toLowerCase().trim();
    candidates
      .filter(
        (f) =>
          !query ||
          f.name.toLowerCase().includes(query) ||
          f.entity.toLowerCase().includes(query)
      )
      .forEach((f) => selected.add(f.path));
    renderFileList();
    renderBudget();
  });

  $("deflateClearBtn").addEventListener("click", () => {
    selected.clear();
    renderFileList();
    renderBudget();
  });

  $("deflateBudgetTarget").addEventListener("change", renderBudget);

  $("deflateSettingsToggle").addEventListener("click", () => {
    const body = $("deflateSettingsBody");
    const open = body.style.display !== "none";
    body.style.display = open ? "none" : "grid";
    $("deflateSettingsToggle").textContent = open ? "Show settings" : "Hide settings";
  });

  $("deflateRunBtn").addEventListener("click", () => run(true));
  $("deflatePreviewBtn").addEventListener("click", () => run(false));

  document.querySelectorAll(".deflate-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".deflate-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      ["patterns", "files", "restated"].forEach((panel) => {
        const el = $(`deflatePanel${panel[0].toUpperCase()}${panel.slice(1)}`);
        if (el) el.style.display = panel === tab.dataset.panel ? "block" : "none";
      });
    });
  });

  $("deflateToCombinerBtn").addEventListener("click", () => {
    if (!lastResults) return;
    const outputs = lastResults.files.filter((f) => f.written).map((f) => f.output);
    if (!outputs.length) {
      showToast("Nothing was written to hand over — this was a preview.", "warning");
      return;
    }
    // The Combiner holds lightweight copies back by default, because beside
    // their transcripts they are the same document twice. Here they are the
    // point, so say so before handing them over.
    appState.combiner.includeLightweight = true;
    eventBus.emit("view:switch", "combiner");
    eventBus.emit("modal:combiner:open", outputs);
  });

  eventBus.on("studio:deflate:activated", () => loadCandidates());
}

export { loadCandidates };
