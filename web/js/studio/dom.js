/**
 * GooseQuill — Studio Element Lookups
 *
 * Every Studio element, named once.
 *
 * While the modal viewer existed, each of these was a pair — `viewerMarkdownPane`
 * and `studioMarkdownPane`, two search bars, two copies of every toggle — and
 * most lookups in the old file were `querySelectorAll("#viewerX, #studioX")`
 * applied to whichever surface happened to be live. With one surface left there
 * is one element per job, and a lookup can no longer act on the wrong copy.
 */

export const byId = (id) => document.getElementById(id);

/* Panes */
export const markdownPane = () => byId("studioMarkdownPane");
export const markdownContent = () => byId("studioMarkdownContent");
export const rawWrapper = () => byId("studioRawMarkdownWrapper");
export const rawTextarea = () => byId("studioRawMarkdownTextarea");
export const pdfPane = () => byId("studioPdfPane");
export const outlinePane = () => byId("studioOutlinePane");
export const comparePaneHost = () => byId("studioComparePane");

/* Toolbar */
export const formatRenderedBtn = () => byId("studioFormatRenderedBtn");
export const formatRawBtn = () => byId("studioFormatRawBtn");
export const scopeAllBtn = () => byId("studioScopeAllBtn");
export const scopePageBtn = () => byId("studioScopePageBtn");
export const autoSyncBtn = () => byId("studioAutoScrollBtn");
export const togglePdfBtn = () => byId("studioTogglePdfBtn");
export const saveBtn = () => byId("studioSaveBtn");

/* Find bar */
export const searchBar = () => byId("studioSearchBar");
export const searchInput = () => byId("studioSearchInput");
export const searchCount = () => byId("studioSearchCount");
export const searchToggleBtn = () => byId("studioSearchToggleBtn");
export const searchCaseBtn = () => byId("studioSearchCaseBtn");
export const searchPanePicker = () => byId("studioSearchPanePicker");
export const searchPaneButtons = () => [byId("studioSearchPaneABtn"), byId("studioSearchPaneBBtn")].filter(Boolean);
export const searchNavButtons = () => [byId("studioSearchPrevBtn"), byId("studioSearchNextBtn")].filter(Boolean);

/* Compare & diff */
export const compareBtn = () => byId("studioCompareBtn");
export const linkPagesBtn = () => byId("studioLinkPagesBtn");
export const diffBtn = () => byId("studioDiffBtn");
export const diffModeWrap = () => byId("studioDiffModeWrap");
export const diffModeSelect = () => byId("studioDiffModeSelect");
export const diffSummary = () => byId("studioDiffSummary");
export const diffPrevBtn = () => byId("studioDiffPrevBtn");
export const diffNextBtn = () => byId("studioDiffNextBtn");

/* Scan pane */
export const pdfPageImage = () => byId("studioPdfPageImage");
export const pdfPageIndicator = () => byId("studioPdfPageIndicator");
export const pdfPrevBtn = () => byId("studioPdfPrevPageBtn");
export const pdfNextBtn = () => byId("studioPdfNextPageBtn");
export const pdfCanvasWrapper = () => byId("studioPdfCanvasWrapper");
export const pdfZoomLevel = () => byId("studioPdfZoomLevel");

/* Chrome */
export const pageList = () => byId("studioPageList");
export const pageCount = () => byId("studioPageCount");
export const tabStrip = () => byId("studioTabStrip");
export const docSelect = () => byId("studioDocSelect");
export const docMeta = () => byId("studioDocMeta");

/** True when focus is somewhere the user is typing. */
export function isTextEntryElement(node) {
  if (!node) return false;
  return node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable === true;
}
