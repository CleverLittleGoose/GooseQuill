/**
 * GooseQuill — Getting the Document Out
 *
 * Saving to the workspace, copying, and downloading.
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import * as dom from "./dom.js";

export async function saveCombinedMarkdown() {
  const saveBtn = document.getElementById("studioCombinerSaveBtn");
  const masterTitleInput = document.getElementById("studioCombinerMasterTitleInput");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const includeToc = document.getElementById("studioCombinerIncludeToc");
  const includeSourceMeta = document.getElementById("studioCombinerIncludeSourceMeta");
  const stripHeaders = document.getElementById("studioCombinerStripHeaders");

  const selected = appState.combiner.selectedItems;
  if (selected.length === 0) {
    showToast("Selection Empty", "Please select at least one converted document to combine.", true);
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
  }

  try {
    const res = await fetch("/api/combine_markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: selected.map(s => s.path),
        master_title: (masterTitleInput && masterTitleInput.value.trim()) || undefined,
        output_filename: (outputFilenameInput && outputFilenameInput.value.trim()) || undefined,
        target_folder: (targetFolderSelect && targetFolderSelect.value) || undefined,
        include_toc: includeToc ? includeToc.checked : true,
        include_source_meta: includeSourceMeta ? includeSourceMeta.checked : true,
        strip_original_headers: stripHeaders ? stripHeaders.checked : true,
        sort_mode: "custom",
        save_to_disk: true
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Could not save consolidated file");

    showToast("Consolidated File Saved! 🎉", `Saved to ${data.saved_path}`);
    appState.recentLogs.push({
      text: `[INFO] Consolidated ${data.total_documents} markdown documents (${data.total_pages} pages) into ${data.saved_path}`,
      type: "normal"
    });
    eventBus.emit("logs:updated");
    eventBus.emit("documents:reload");

    if (saveBtn) {
      saveBtn.textContent = "Saved!";
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
          Save to Workspace
        `;
      }, 2500);
    }
  } catch (e) {
    showToast("Save Error", e.message, true);
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save to Workspace";
    }
  }
}

export function copyCombinedMarkdown() {
  const rawTextarea = document.getElementById("studioCombinerRawMarkdownTextarea");
  const copyBtn = document.getElementById("studioCombinerCopyBtn");
  const content = rawTextarea ? rawTextarea.value : "";
  if (!content) {
    showToast("Empty Document", "No consolidated content to copy.", true);
    return;
  }
  navigator.clipboard.writeText(content);
  if (copyBtn) {
    copyBtn.textContent = "Copied!";
    setTimeout(() => {
      copyBtn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        Copy Markdown
      `;
    }, 2000);
  }
}

export function downloadCombinedMarkdown() {
  const rawTextarea = document.getElementById("studioCombinerRawMarkdownTextarea");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const content = rawTextarea ? rawTextarea.value : "";
  if (!content) {
    showToast("Empty Document", "No consolidated content to download.", true);
    return;
  }

  let filename = (outputFilenameInput && outputFilenameInput.value.trim()) || "Consolidated_Document.md";
  if (!filename.toLowerCase().endsWith(".md")) filename += ".md";

  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Download Started 📥", `Downloading ${filename}`);
}
