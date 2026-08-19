/**
 * GooseQuill — Converted Document Catalogue
 *
 * One place that answers "which documents can Studio open?", so both compare
 * panes offer the same list built the same way. Pane A and pane B were
 * asymmetric while only B had a picker; sharing this keeps them equals.
 */

import { appState } from "../state.js";

/** Every converted document in the workspace, ordered by entity then name. */
export function listConvertedDocuments() {
  const docs = [];

  (appState.folders || []).forEach((folder) => {
    (folder.documents || []).forEach((doc) => {
      if (doc.is_converted) docs.push(doc);
    });
  });

  // Consolidations sit at the end of their entity's group: they are derived
  // from the filings above them, and putting them first would push the actual
  // documents down the list.
  (appState.consolidatedDocuments || []).forEach((doc) => docs.push(doc));

  docs.sort(
    (a, b) =>
      (a.folder || "").localeCompare(b.folder || "") ||
      Number(Boolean(a.is_consolidated)) - Number(Boolean(b.is_consolidated)) ||
      (a.name || "").localeCompare(b.name || "")
  );

  return docs;
}

/**
 * Fill a <select> with the catalogue, grouped by entity.
 *
 * @returns {Array} the documents used, so callers can resolve a chosen path
 */
export function populateDocumentSelect(select, { placeholder = "Choose a converted document…" } = {}) {
  if (!select) return [];

  const previous = select.value;
  const docs = listConvertedDocuments();

  const byFolder = new Map();
  docs.forEach((doc) => {
    if (!byFolder.has(doc.folder)) byFolder.set(doc.folder, []);
    byFolder.get(doc.folder).push(doc);
  });

  select.innerHTML = `<option value="">${placeholder}</option>`;
  byFolder.forEach((folderDocs, folderName) => {
    const group = document.createElement("optgroup");
    group.label = folderName;
    folderDocs.forEach((doc) => {
      const option = document.createElement("option");
      option.value = doc.path;
      option.textContent = doc.name.replace(/\.pdf$/i, "");
      group.appendChild(option);
    });
    select.appendChild(group);
  });

  if (previous) select.value = previous;
  return docs;
}

/** Resolve a path back to its document record. */
export function findDocumentByPath(path) {
  if (!path) return null;
  return listConvertedDocuments().find((doc) => doc.path === path) || null;
}

/** The scanned PDF that a document record points at, whichever path it carries. */
export function resolvePdfPath(doc) {
  let pdfPath = doc && doc.path;
  if (pdfPath && pdfPath.toLowerCase().endsWith(".md")) {
    pdfPath = pdfPath.replace(/[/\\]Markdown[/\\]/, "/").replace(/\.md$/i, ".pdf");
  }
  return pdfPath || null;
}
