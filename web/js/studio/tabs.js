/**
 * GooseQuill — Open Documents
 *
 * Studio held exactly one document, so moving between two filings meant going
 * back to the Workspace and losing your place each time. Each tab keeps its own
 * loaded transcript and the page it was left on, so switching is instant and
 * returns you where you were rather than to page one.
 *
 * This module owns the list and the strip that draws it. What happens when a
 * tab is chosen is the document module's business, and is passed in.
 */

import { appState } from "../state.js";
import { studio } from "./state.js";
import * as dom from "./dom.js";

/** @type {Array<{doc:Object, content:?string, pagesMap:?Object, markdownPath:?string, currentPage:number}>} */
export const tabs = [];

export let activeIndex = -1;

export function setActiveIndex(index) {
  activeIndex = index;
}

export function activeTab() {
  return tabs[activeIndex] || null;
}

export function findTab(path) {
  return tabs.findIndex((tab) => tab.doc.path === path);
}

export function openTab(doc, startPage = 1) {
  tabs.push({ doc, content: null, pagesMap: null, markdownPath: null, currentPage: startPage });
  return tabs.length - 1;
}

/** Remember where the current tab was left, before moving away from it. */
export function captureActivePosition() {
  const tab = activeTab();
  if (!tab) return;
  tab.currentPage = appState.currentPdfPage;
  tab.content = appState.currentViewingMarkdownContent;
  tab.pagesMap = studio.pagesMap;
  tab.markdownPath = appState.currentViewingMarkdownPath;
}

/** Store what has just been loaded against the active tab. */
export function recordLoaded() {
  const tab = activeTab();
  if (!tab) return;
  tab.content = appState.currentViewingMarkdownContent;
  tab.pagesMap = studio.pagesMap;
  tab.markdownPath = appState.currentViewingMarkdownPath;
}

/**
 * Remove a tab.
 *
 * @returns {{closed:boolean, empty:boolean, activate:?number}} what the caller
 *   should do next: nothing, leave the Studio, or activate another tab.
 */
export function removeTab(index) {
  if (!tabs[index]) return { closed: false, empty: false, activate: null };

  if (index === activeIndex) captureActivePosition();
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    activeIndex = -1;
    return { closed: true, empty: true, activate: null };
  }

  if (index < activeIndex) {
    activeIndex -= 1;
    return { closed: true, empty: false, activate: null };
  }
  if (index === activeIndex) {
    // Land on the neighbour, the way a closed tab usually behaves.
    return { closed: true, empty: false, activate: Math.min(index, tabs.length - 1) };
  }
  return { closed: true, empty: false, activate: null };
}

/** Step to the next or previous open document, wrapping at the ends. */
export function neighbourIndex(delta) {
  if (tabs.length < 2) return -1;
  return (activeIndex + delta + tabs.length) % tabs.length;
}

export function renderTabStrip({ onSelect, onClose }) {
  const strip = dom.tabStrip();
  if (!strip) return;

  // One document is not a set of tabs; the strip only earns its space at two.
  strip.style.display = tabs.length > 1 ? "flex" : "none";
  strip.innerHTML = "";

  tabs.forEach((tab, index) => {
    const isActive = index === activeIndex;

    const item = document.createElement("div");
    item.className = `studio-doc-tab ${isActive ? "active" : ""}`;
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", String(isActive));
    item.title = tab.doc.name;

    const label = document.createElement("button");
    label.className = "studio-doc-tab-label";
    label.textContent = tab.doc.name.replace(/\.pdf$/i, "");
    label.addEventListener("click", () => onSelect(index));

    const close = document.createElement("button");
    close.className = "studio-doc-tab-close";
    close.setAttribute("aria-label", `Close ${tab.doc.name}`);
    close.title = "Close";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      onClose(index);
    });

    item.append(label, close);
    strip.appendChild(item);
  });
}

/**
 * Keep the top-nav Studio button current.
 *
 * It shows how many documents are open, not which — a filename there is
 * unbounded, and a long one pushed the last nav items off the bar. The strip
 * below names them, and names them all rather than only the active one.
 */
export function updateNavTabLabel() {
  const nameEl = dom.byId("tabNavStudioDocName");
  const badge = dom.byId("topNavStudioDocBadge");

  if (nameEl) nameEl.textContent = "Studio";
  if (badge) {
    badge.style.display = tabs.length ? "inline-flex" : "none";
    badge.textContent = tabs.length > 1 ? String(tabs.length) : "1";
    badge.title = tabs.length === 1 ? "One document open" : `${tabs.length} documents open`;
  }
}
