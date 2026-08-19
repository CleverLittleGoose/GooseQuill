/**
 * GooseQuill - Central Application State
 */

export const appState = {
  rootDirectory: "",
  folders: [],
  /**
   * Consolidated documents, which have no PDF behind them.
   *
   * They are not filings, so they do not belong in `folders` alongside the
   * scans — but they are readable documents, and until they were listed
   * somewhere there was no way to open one at all after building it.
   */
  consolidatedDocuments: [],
  activeFolder: "ALL",
  selectedFiles: new Set(),
  currentViewingDoc: null,
  currentViewingMarkdownPath: null,
  currentViewingPdfPath: null,
  currentPdfPage: 1,
  totalPdfPages: 1,
  docPages: {},
  splitViewMode: "full",
  model: "gemini-3.1-flash-lite",
  concurrency: 5,
  presets: {},
  currentPreset: "financial",
  defaultPrompt: "",
  systemPrompt: "",
  forceReprocess: false,
  apiConnected: false,
  apiErrorDetail: null,
  recentLogs: [],
  jobErrors: [],
  pricing: {},
  // Which model the server treats as the default, so the rate card can mark it.
  defaultModel: "",
  stats: {},
  // Workspace UI filter states
  currentView: "workspace", // "workspace" | "studio" | "search" | "combiner" | "batches" | "economics"
  filterStatus: "all",      // "all" | "ready" | "converted" | "batch"
  searchQuery: "",
  folderSearchQuery: "",
  sortField: "year",        // "year" | "name" | "pages" | "size"
  sortDirection: "desc",    // "asc" | "desc"
  combiner: {
    availableFiles: [],
    selectedItems: [],
    sortMode: "chronological_asc",
    sourceFolder: "ALL",
    cachedResult: null,
    previewTab: "rendered",
    previewTimer: null,
    // Consolidations contain the documents they were made from, so combining
    // them again duplicates everything. Opt in.
    includeConsolidated: false,
    // True while the preview holds an extract rather than the whole document.
    previewIsPartial: false
  }
};

class EventBus {
  constructor() {
    this.listeners = {};
  }

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => cb(data));
    }
  }
}

export const eventBus = new EventBus();
