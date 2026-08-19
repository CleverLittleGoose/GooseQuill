/**
 * GooseQuill — Naming the Output
 *
 * The suggested title, the filename, and where it will be written.
 */

import { appState } from "../state.js";
import * as dom from "./dom.js";

export function autoSuggestCombinerTitleAndFilename() {
  const masterTitleInput = document.getElementById("studioCombinerMasterTitleInput");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const selected = appState.combiner.selectedItems;

  if (selected.length === 0) {
    if (masterTitleInput) masterTitleInput.value = "";
    if (outputFilenameInput) outputFilenameInput.value = "Consolidated_Document.md";
    updateCombinerDestinationText();
    return;
  }

  const folders = Array.from(new Set(selected.map(s => s.folder).filter(Boolean)));
  const years = selected.map(s => s.year).filter(y => y && y !== 9999);
  let yearRange = "";
  if (years.length > 0) {
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    yearRange = minYear === maxYear ? ` ${minYear}` : ` (${minYear}–${maxYear})`;
  }

  let folderLabel = "Documents";
  if (folders.length === 1 && folders[0] && folders[0] !== "Accounts" && folders[0] !== "documents" && folders[0] !== "General / Root") {
    folderLabel = folders[0];
    if (targetFolderSelect) targetFolderSelect.value = folders[0];
  } else if (folders.length > 1) {
    folderLabel = `${folders.length} Folders`;
  }

  const title = `Consolidated Document — ${folderLabel}${yearRange}`;
  const cleanFolderName = folderLabel.replace(/[^\w\s-]/g, "").replace(/\s+/g, "_");
  const cleanYear = yearRange.replace(/[^\w-]/g, "_").replace(/^_+|_+$/g, "");
  const yearSuffix = cleanYear ? `_${cleanYear}` : "";
  const filename = `${cleanFolderName}_Consolidated${yearSuffix}.md`.replace(/__+/g, "_");

  if (masterTitleInput) masterTitleInput.value = title;
  if (outputFilenameInput) outputFilenameInput.value = filename;
  updateCombinerDestinationText();
}

export function updateCombinerDestinationText() {
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const saveDestinationText = document.getElementById("studioCombinerSaveDestinationText");

  const folder = (targetFolderSelect && targetFolderSelect.value) || "General / Root";
  let filename = (outputFilenameInput && outputFilenameInput.value.trim()) || "Consolidated_Document.md";
  if (!filename.toLowerCase().endsWith(".md")) filename += ".md";

  // Consolidations go to Consolidated/, not in among the transcripts. This
  // still said Markdown/, so the destination shown was not where the file
  // would actually be written.
  const destPath = `/${folder !== "General / Root" ? folder + "/" : ""}Consolidated/${filename}`;
  if (saveDestinationText) saveDestinationText.textContent = `Destination: ${destPath}`;
}
