/**
 * GooseQuill — Keyboard Shortcuts
 *
 * The Studio was entirely mouse-driven. These are the moves you make most often
 * while reading a filing, bound to the keys the rest of the desktop uses for
 * them.
 *
 *   Cmd/Ctrl+P          open a document
 *   Cmd/Ctrl+Shift+F    search the whole workspace
 *   Cmd/Ctrl+F          find in this document
 *   [ / ]               previous / next open document
 *   n / p               next / previous change, while diff is on
 *   ← / → PgUp / PgDn   previous / next page
 *   Escape              close the find bar
 *
 * Every binding is guarded on focus: a shortcut that fires while the caret is
 * in a field is a shortcut that corrupts the text someone was typing.
 */

import { appState } from "../state.js";
import { studio, searchState } from "./state.js";
import { isTextEntryElement } from "./dom.js";
import { switchStudioView } from "../components/header.js";
import { stepPage } from "./navigation.js";
import { openSearchBar, closeSearchBar } from "./search.js";
import { goToChangedPage } from "./diff.js";
import { stepTab } from "./document.js";
import { openDocumentSwitcher, isSwitcherOpen } from "./switcher.js";

export function initStudioShortcuts() {
  window.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;

    // The document switcher works from anywhere — it is how you get to a
    // document, so requiring you to already be looking at one is backwards.
    if (mod && !event.shiftKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      openDocumentSwitcher();
      return;
    }

    // Workspace-wide search, likewise.
    if (mod && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      switchStudioView("search");
      document.getElementById("workspaceSearchInput")?.focus();
      return;
    }

    if (isSwitcherOpen()) return;
    if (appState.currentView !== "studio") return;

    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openSearchBar();
      return;
    }

    if (event.key === "Escape") {
      if (searchState.isOpen) {
        event.preventDefault();
        closeSearchBar();
      }
      return;
    }

    // Everything below is a bare key. Page keys must never fire while the caret
    // is in a field: guarding only the search input meant arrow keys in the raw
    // editor flipped the scan instead of moving the cursor, so the transcript
    // could not be edited.
    if (isTextEntryElement(document.activeElement)) return;
    if (event.altKey || mod) return;

    switch (event.key) {
      case "[":
        event.preventDefault();
        stepTab(-1);
        break;
      case "]":
        event.preventDefault();
        stepTab(1);
        break;
      case "n":
        if (studio.diffEnabled) {
          event.preventDefault();
          goToChangedPage(1);
        }
        break;
      case "p":
        if (studio.diffEnabled) {
          event.preventDefault();
          goToChangedPage(-1);
        }
        break;
      case "ArrowLeft":
      case "PageUp":
        event.preventDefault();
        stepPage(-1);
        break;
      case "ArrowRight":
      case "PageDown":
        event.preventDefault();
        stepPage(1);
        break;
      default:
        break;
    }
  });
}
