/**
 * GooseQuill — The Consolidated Preview
 *
 * Assembling an extract to look at, and building the whole document when asked.
 *
 * This tool exists because a browser could not consolidate a workspace, so the
 * preview is careful never to try: it shows the opening documents, and a full
 * build is assembled and written on the server with nothing coming back through
 * the tab.
 */

import { appState } from "../state.js";
import { TranscriptView } from "../services/transcript_view.js";
import { splitSequential } from "../services/page_splitter.js";
import * as dom from "./dom.js";

/**
 * The consolidated preview, drawn a page at a time.
 *
 * `TranscriptView` already solves rendering a long document without laying all
 * of it out at once, so the preview borrows it rather than growing its own
 * copy. The one thing it cannot borrow is page numbering: a consolidated file
 * restarts at page 1 for every source document, so blocks are keyed by position
 * and labelled with the page they claim to be.
 */
let combinerTranscript = null;

/**
 * How much of a large selection the preview assembles up front.
 *
 * Choosing documents should never commit you to building them.
 */
const PREVIEW_DOCUMENT_LIMIT = 10;

/**
 * A second guard, for one document that is enormous on its own: every page
 * reserves its estimated height even unrendered, and browsers cap an element at
 * about 33.5 million pixels. Past that, scroll positions stop mapping to pages
 * and the pane goes blank rather than slow.
 */
const PREVIEW_PAGE_LIMIT = 2000;

function resetCombinerStats() {
  ["studioCombinerStatDocs", "studioCombinerStatPages", "studioCombinerStatWords", "studioCombinerStatChars"]
    .forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = "0";
    });
  const raw = document.getElementById("studioCombinerRawMarkdownTextarea");
  if (raw) raw.value = "";
}

export function updateCombinerOutputButtons({ builtPath = null } = {}) {
  const partial = Boolean(appState.combiner.previewIsPartial);
  const copyBtn = document.getElementById("studioCombinerCopyBtn");
  const downloadBtn = document.getElementById("studioCombinerDownloadBtn");

  if (copyBtn) {
    // The clipboard route goes through a JavaScript string, so it stays shut
    // for a document that was deliberately never brought into the tab.
    copyBtn.disabled = partial || Boolean(builtPath);
    copyBtn.title = builtPath
      ? "The full document is on disk — download it rather than routing it through the clipboard"
      : partial
        ? "Build the full document first — the preview is only an extract"
        : "";
  }

  if (downloadBtn) {
    downloadBtn.disabled = partial && !builtPath;
    downloadBtn.title = downloadBtn.disabled
      ? "Build the full document first — the preview is only an extract"
      : "";
  }
}

function escapeForHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * What a completed full build looks like.
 *
 * The document is on disk and is not coming back through the tab, so there is
 * nothing to render — and nothing to render is the point.
 */
function renderBuiltDocument(data) {
  const notice = document.getElementById("studioCombinerPreviewNotice");
  if (notice) {
    notice.style.display = "none";
    notice.innerHTML = "";
  }

  appState.combiner.previewIsPartial = false;
  updateCombinerOutputButtons({ builtPath: data.saved_path });

  const stats = [
    [ "studioCombinerStatDocs", data.total_documents ],
    [ "studioCombinerStatPages", data.total_pages ],
    [ "studioCombinerStatWords", (data.total_words || 0).toLocaleString() ],
    [ "studioCombinerStatChars", (data.total_chars || 0).toLocaleString() ]
  ];
  stats.forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });

  const megabytes = ((data.total_chars || 0) / 1048576).toFixed(1);

  clearCombinerPreviewBody(`
    <div style="padding: 56px 20px; text-align: center;">
      <h3 style="font-size: 17px; font-weight: 600; color: var(--text-main);">Document built</h3>
      <p class="text-muted" style="margin: 8px auto 4px; font-size: 14px; max-width: 460px;">
        ${(data.total_documents || 0).toLocaleString()} documents,
        ${(data.total_pages || 0).toLocaleString()} pages, about ${megabytes}MB.
      </p>
      <p class="text-muted text-xs" style="margin: 0 auto 18px; max-width: 520px; word-break: break-all;">
        ${escapeForHtml(data.saved_path || "")}
      </p>
      <a class="btn btn-primary" id="studioCombinerBuiltDownload"
         href="/api/download_markdown?path=${encodeURIComponent(data.saved_path || "")}">Download .md</a>
      <p class="text-muted text-xs" style="margin-top: 14px;">
        Too large to preview in the browser — that is why it was assembled on disk.
      </p>
    </div>
  `);
}

/**
 * Say what the pane is showing, and offer the way to see the rest.
 */
function renderPreviewNotice(notice, { previewedDocuments, totalDocuments, totalPages }) {
  if (!notice) return;

  const partialDocs = totalDocuments > previewedDocuments;
  const partialPages = totalPages > PREVIEW_PAGE_LIMIT;

  if (!partialDocs && !partialPages) {
    notice.style.display = "none";
    notice.innerHTML = "";
    return;
  }

  const parts = [];
  if (partialDocs) {
    parts.push(
      `Showing the first ${previewedDocuments.toLocaleString()} of ${totalDocuments.toLocaleString()} documents`
    );
  }
  if (partialPages) {
    parts.push(`${PREVIEW_PAGE_LIMIT.toLocaleString()} of ${totalPages.toLocaleString()} pages`);
  }

  notice.style.display = "flex";
  notice.innerHTML = `
    <span>${parts.join(", ")}.</span>
    ${partialDocs ? `<button class="btn btn-xs btn-primary" id="studioCombinerBuildFullBtn">Build full document</button>` : ""}
  `;

  document
    .getElementById("studioCombinerBuildFullBtn")
    ?.addEventListener("click", () => generateCombinerPreview({ full: true }));
}

function renderCombinerPreviewBody(markdown, { previewedDocuments = 0, totalDocuments = 0 } = {}) {
  const pane = document.getElementById("studioCombinerTabRendered");
  const content = document.getElementById("studioCombinerRenderedContent");
  const notice = document.getElementById("studioCombinerPreviewNotice");
  if (!pane || !content) return;

  if (!combinerTranscript) {
    combinerTranscript = new TranscriptView(pane, content, {});
  }

  const { pages, labels } = splitSequential(markdown);
  const total = Object.keys(pages).filter((key) => /^\d+$/.test(key)).length;

  let shown = pages;
  if (total > PREVIEW_PAGE_LIMIT) {
    shown = { preamble: pages.preamble };
    for (let page = 1; page <= PREVIEW_PAGE_LIMIT; page++) shown[page] = pages[page];
  }

  renderPreviewNotice(notice, { previewedDocuments, totalDocuments, totalPages: total });

  combinerTranscript.setDocument(shown, { pageLabels: labels });
}

/** Drop the virtualised preview back to a plain message. */
function clearCombinerPreviewBody(html) {
  const content = document.getElementById("studioCombinerRenderedContent");
  const notice = document.getElementById("studioCombinerPreviewNotice");
  if (notice) notice.style.display = "none";
  if (combinerTranscript) {
    combinerTranscript.destroy();
    combinerTranscript = null;
  }
  if (content) content.innerHTML = html;
}

export function triggerCombinerPreviewDebounced() {
  if (appState.combiner.previewTimer) {
    clearTimeout(appState.combiner.previewTimer);
  }
  appState.combiner.previewTimer = setTimeout(() => {
    generateCombinerPreview();
  }, 250);
}

export async function generateCombinerPreview({ full = false } = {}) {
  const rawTextarea = document.getElementById("studioCombinerRawMarkdownTextarea");
  const statDocs = document.getElementById("studioCombinerStatDocs");
  const statPages = document.getElementById("studioCombinerStatPages");
  const statWords = document.getElementById("studioCombinerStatWords");
  const statChars = document.getElementById("studioCombinerStatChars");

  const masterTitleInput = document.getElementById("studioCombinerMasterTitleInput");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const includeToc = document.getElementById("studioCombinerIncludeToc");
  const includeSourceMeta = document.getElementById("studioCombinerIncludeSourceMeta");
  const stripHeaders = document.getElementById("studioCombinerStripHeaders");

  const selected = appState.combiner.selectedItems;
  if (selected.length === 0) {
    clearCombinerPreviewBody(`
        <div style="padding: 60px 20px; text-align: center;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 14px; opacity: 0.35;">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          <h3 style="font-size: 18px; font-weight: 600; color: var(--text-main);">Ready to Consolidate Documents</h3>
          <p class="text-muted" style="margin-top: 6px; font-size: 14.5px; max-width: 440px; margin-left: auto; margin-right: auto;">
            Select documents on the left to sequence them, or click "Select Entity" to consolidate an entire folder.
          </p>
        </div>
    `);
    appState.combiner.previewIsPartial = false;
    updateCombinerOutputButtons();
    resetCombinerStats();
    return;
  }

  // Unless the whole thing was asked for, assemble only the opening documents.
  // The rest stay selected, listed and saved — they are simply not fetched into
  // the tab in order to be glanced at.
  const previewFiles = full ? selected : selected.slice(0, PREVIEW_DOCUMENT_LIMIT);
  const previewIsPartial = previewFiles.length < selected.length;
  appState.combiner.previewIsPartial = previewIsPartial;
  updateCombinerOutputButtons();

  clearCombinerPreviewBody(`
    <div class="text-muted text-center" style="padding: 60px; font-size: 15px;">
      <span class="spinner" style="width: 16px; height: 16px; display: inline-block; vertical-align: middle; margin-right: 8px;"></span>
      ${full ? "Building the full document" : "Preparing a preview"} —
      ${previewFiles.length.toLocaleString()} ${previewFiles.length === 1 ? "document" : "documents"}…
      ${full ? '<div class="text-xs" style="margin-top: 10px;">Assembled and written on the server; this can take a moment for a large workspace.</div>' : ""}
    </div>
  `);

  try {
    const res = await fetch("/api/combine_markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: previewFiles.map(s => s.path),
        master_title: (masterTitleInput && masterTitleInput.value.trim()) || undefined,
        output_filename: (outputFilenameInput && outputFilenameInput.value.trim()) || undefined,
        target_folder: (targetFolderSelect && targetFolderSelect.value) || undefined,
        include_toc: includeToc ? includeToc.checked : true,
        include_source_meta: includeSourceMeta ? includeSourceMeta.checked : true,
        strip_original_headers: stripHeaders ? stripHeaders.checked : true,
        sort_mode: "custom",
        // A full build is written on the server. Anything smaller comes back
        // so the raw pane and the preview have something to show.
        save_to_disk: full,
        return_content: !full
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Consolidation preview failed");

    appState.combiner.cachedResult = data;

    if (full) {
      renderBuiltDocument(data);
      return;
    }

    renderCombinerPreviewBody(data.content, {
      previewedDocuments: previewFiles.length,
      totalDocuments: selected.length
    });
    if (rawTextarea) rawTextarea.value = data.content;

    if (previewIsPartial) {
      // The counts describe what will be saved, not what was assembled to look
      // at. Pages we know from the selection; words and characters we would
      // have to build the whole document to learn, which is the thing being
      // avoided, so they are left blank rather than quietly understated.
      const selectedPages = selected.reduce((total, item) => total + (item.pages || 0), 0);
      if (statDocs) statDocs.textContent = selected.length.toLocaleString();
      if (statPages) statPages.textContent = selectedPages.toLocaleString();
      if (statWords) statWords.textContent = "—";
      if (statChars) statChars.textContent = "—";
    } else {
      if (statDocs) statDocs.textContent = data.total_documents;
      if (statPages) statPages.textContent = data.total_pages;
      if (statWords) statWords.textContent = data.total_words.toLocaleString();
      if (statChars) statChars.textContent = data.total_chars.toLocaleString();
    }

  } catch (e) {
    clearCombinerPreviewBody(`<div class="text-danger text-center" style="padding: 40px; font-size: 15px;">Error generating preview: ${e.message}</div>`);
  }
}
