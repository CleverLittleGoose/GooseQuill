/**
 * GooseQuill - Central Application State
 */

export const appState = {
  rootDirectory: "",
  folders: [],
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
    previewTimer: null
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
