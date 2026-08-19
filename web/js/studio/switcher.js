/**
 * GooseQuill — Document Switcher (Cmd+K)
 *
 * Type a few letters, get the document. Reaching a filing previously meant
 * going back to the Workspace, finding the right entity in the sidebar, then
 * finding the right year in the table — three deliberate steps for something
 * you do constantly.
 *
 * It matches on entity as well as filename, because "northwind 2025" is how
 * you think of a document, not "Northwind Properties PLC - Annual Report 2025.pdf".
 */

import { listConvertedDocuments } from "../services/document_catalog.js";

const MAX_RESULTS = 40;

let overlay = null;
let input = null;
let list = null;
let results = [];
let activeIndex = 0;
let onChoose = null;

export function isSwitcherOpen() {
  return Boolean(overlay && overlay.style.display !== "none");
}

/** @param {(doc:Object) => void} handler — what to do with the chosen document. */
export function initDocumentSwitcher(handler) {
  onChoose = handler;
}

export function openDocumentSwitcher() {
  if (!overlay) build();
  overlay.style.display = "flex";
  input.value = "";
  refresh("");
  input.focus();
}

export function closeDocumentSwitcher() {
  if (overlay) overlay.style.display = "none";
}

function build() {
  overlay = document.createElement("div");
  overlay.className = "doc-switcher-overlay";
  overlay.style.display = "none";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Open a document");

  overlay.innerHTML = `
    <div class="doc-switcher">
      <input class="doc-switcher-input" type="text" placeholder="Go to document…"
             autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true"
             aria-autocomplete="list" aria-controls="docSwitcherList">
      <ul class="doc-switcher-list" id="docSwitcherList" role="listbox"></ul>
      <div class="doc-switcher-hint">
        <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
        <span><kbd>↵</kbd> to open</span>
        <span><kbd>esc</kbd> to close</span>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  input = overlay.querySelector(".doc-switcher-input");
  list = overlay.querySelector(".doc-switcher-list");

  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closeDocumentSwitcher();
  });

  input.addEventListener("input", () => refresh(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDocumentSwitcher();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
    }
  });
}

/**
 * Rank documents against what has been typed.
 *
 * Every term has to appear somewhere in "entity + filename", in any order, so
 * "2025 northwind" finds the same document as "northwind 2025". A match
 * on the entity sorts above a match buried in a filename.
 */
function rank(docs, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return docs.slice(0, MAX_RESULTS);

  return docs
    .map((doc) => {
      const name = (doc.name || "").toLowerCase();
      const folder = (doc.folder || "").toLowerCase();
      const haystack = `${folder} ${name}`;
      if (!terms.every((term) => haystack.includes(term))) return null;

      const score = terms.reduce((total, term) => {
        if (folder.startsWith(term)) return total + 3;
        if (folder.includes(term)) return total + 2;
        if (name.startsWith(term)) return total + 2;
        return total + 1;
      }, 0);

      return { doc, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name))
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.doc);
}

function refresh(query) {
  results = rank(listConvertedDocuments(), query.trim());
  activeIndex = 0;
  draw();
}

/**
 * The part of a filename that tells one document from another.
 *
 * Filings are named "<Entity> - Annual Report 2019.pdf", and an entity with
 * twenty years of accounts produced twenty rows reading
 * "Kingsmere Resort Operations Limited - Annual Report…" — identical up to
 * the truncation, with the year, the only thing that differed, cut off. The
 * entity is already in the column beside it.
 *
 * Only the leading entity name is dropped, and only when it really is the
 * folder repeating itself, so a document named something else keeps its name.
 */
export function distinguishingName(doc) {
  const full = (doc.name || "").replace(/\.(pdf|md)$/i, "");
  const folder = (doc.folder || "").trim();
  if (!folder) return full;

  // Matched rather than measured: comparing normalised text but slicing by the
  // folder's own length gets it wrong the moment the filename spaces the entity
  // differently from the folder does, and leaves a fragment of the entity
  // behind. This lets whitespace differ and takes the separator with it.
  const flexible = folder
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const prefix = new RegExp(`^${flexible}\\s*[-–—_:.]*\\s*`, "i");

  const remainder = full.replace(prefix, "").trim();
  return remainder && remainder !== full ? remainder : full;
}

function draw() {
  list.innerHTML = "";

  if (results.length === 0) {
    const empty = document.createElement("li");
    empty.className = "doc-switcher-empty";
    empty.setAttribute("role", "status");
    empty.textContent = "No converted document matches that.";
    list.appendChild(empty);
    input.removeAttribute("aria-activedescendant");
    return;
  }

  results.forEach((doc, index) => {
    const item = document.createElement("li");
    item.className = `doc-switcher-item ${index === activeIndex ? "active" : ""}`;
    item.id = `docSwitcherOption${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === activeIndex));

    const name = document.createElement("span");
    name.className = "doc-switcher-name";
    name.textContent = distinguishingName(doc);
    name.title = doc.name;

    const folder = document.createElement("span");
    folder.className = "doc-switcher-folder";
    folder.textContent = doc.folder || "";

    if (doc.is_consolidated) {
      // Worth marking: it reads like a filing but it is many of them at once.
      const badge = document.createElement("span");
      badge.className = "doc-switcher-badge";
      badge.textContent = "consolidated";
      item.append(name, badge, folder);
    } else {
      item.append(name, folder);
    }
    item.addEventListener("click", () => choose(index));
    list.appendChild(item);
  });

  // Focus stays in the input while the arrows move a highlight in the list, so
  // without this a screen reader announces nothing as you walk the results.
  input.setAttribute("aria-activedescendant", `docSwitcherOption${activeIndex}`);
}

function move(delta) {
  if (results.length === 0) return;
  activeIndex = (activeIndex + delta + results.length) % results.length;
  draw();
  list.querySelector(".doc-switcher-item.active")?.scrollIntoView({ block: "nearest" });
}

function choose(index) {
  const doc = results[index];
  if (!doc) return;
  closeDocumentSwitcher();
  if (onChoose) onChoose(doc);
}

export { rank as rankDocuments };
