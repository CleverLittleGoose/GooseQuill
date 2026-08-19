/**
 * GooseQuill — Raw Markdown Editor
 *
 * Editing the transcript and writing it back to the .md file on disk.
 */

import { appState } from "../state.js";
import { showToast } from "../services/notifications.js";
import { parsePages } from "../services/page_splitter.js";
import { studio, searchState } from "./state.js";
import * as dom from "./dom.js";
import { updateSaveButtonState, rerenderTranscript } from "./render.js";
import { renderPageList } from "./outline.js";
import { goToPage } from "./navigation.js";
import { navigateMatch } from "./search.js";

export function markDirty() {
  // Only full-document edits are savable, so only they can make it dirty.
  if (studio.scope !== "all") return;
  studio.rawEditorDirty = true;
  updateSaveButtonState();
}

export async function saveRawMarkdown() {
  const textarea = dom.rawTextarea();
  const targetPath = appState.currentViewingMarkdownPath;

  if (!textarea || !targetPath) return;
  if (studio.scope !== "all") {
    showToast("Cannot save a single page", "Switch to Full Doc scope before saving.", true);
    return;
  }

  const content = textarea.value;
  try {
    const res = await fetch("/api/markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_path: targetPath, content })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Save failed (${res.status})`);
    }

    appState.currentViewingMarkdownContent = content;
    studio.pagesMap = parsePages(content);
    studio.rawEditorDirty = false;
    updateSaveButtonState();

    // Rebuild the rendered side from the saved text so the two views cannot
    // drift apart. The editor already holds it, so it is left alone.
    rerenderTranscript();
    renderPageList({ onSelect: (page) => goToPage(page, true) });

    showToast("Saved", "Markdown written to disk.");
  } catch (e) {
    showToast("Save failed", e.message, true);
  }
}

/** Wire the textarea's own key handling. */
export function initEditor() {
  const textarea = dom.rawTextarea();
  if (!textarea) return;

  textarea.addEventListener("input", markDirty);
  textarea.addEventListener("keydown", (e) => {
    // Cmd/Ctrl+S saves from inside the editor.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveRawMarkdown();
      return;
    }
    // With the find bar open, Enter walks matches instead of breaking the line.
    if (searchState.isOpen && searchState.rawMatches.length > 0 && e.key === "Enter") {
      e.preventDefault();
      navigateMatch(e.shiftKey ? -1 : 1);
    }
  });

  dom.saveBtn()?.addEventListener("click", saveRawMarkdown);
}
