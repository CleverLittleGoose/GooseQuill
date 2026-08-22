/**
 * GooseQuill - Web Application Bootstrap & Orchestrator
 * Modular ES6 Architecture
 */

import { appState, eventBus } from "./js/state.js";
import { updateNotificationUI } from "./js/services/notifications.js";
import { checkJobStatus } from "./js/services/job_poller.js";
import { initHeader, testApiConnection, watchNavOverflow } from "./js/components/header.js";
import { initFolderSidebar, renderSidebarFolders, renderStats } from "./js/components/folder_sidebar.js";
import { initDocumentTable, renderDocuments, updateSelectedUI } from "./js/components/document_table.js";
import { initStudio } from "./js/studio/index.js";
import { initSearchView } from "./js/components/search_view.js";
import { initEconomicsView } from "./js/components/economics_view.js";
import { initCombinerModal, refreshCombinerAvailableFiles } from "./js/combiner/index.js";
import { initDeflateView } from "./js/deflate/index.js";
import { initBatchModal, fetchBatchJobs } from "./js/components/batch_modal.js";
import { initBatchPlans, fetchBatchPlans } from "./js/components/batch_plans.js";
import { initSettingsModal } from "./js/components/settings_modal.js";
import { initLogsModal } from "./js/components/logs_modal.js";
import { initNewFolderModal } from "./js/components/new_folder_modal.js";

/**
 * Load the consolidated documents so the Studio can open them.
 *
 * They are deliberately absent from the Workspace table, which lists filings
 * and their conversion state — a consolidation is neither. But nothing else
 * listed them either, so once one was built there was no way back to it short
 * of opening the file by hand.
 */
async function fetchConsolidatedDocuments() {
  try {
    const res = await fetch("/api/converted_markdowns");
    const data = await res.json();
    appState.consolidatedDocuments = (data.files || [])
      .filter((file) => file.is_consolidated)
      .map((file) => ({
        name: file.name,
        stem: file.stem,
        path: file.path,
        folder: file.folder,
        file_size: file.size,
        is_converted: true,
        is_consolidated: true,
        // Page count is not known until the file is read; the Studio fills it in.
        total_pages: null
      }));
  } catch (e) {
    console.error("Could not load consolidated documents:", e);
    appState.consolidatedDocuments = [];
  }
}

export async function fetchDocuments() {
  try {
    const res = await fetch(`/api/documents?model=${encodeURIComponent(appState.model)}`);
    const data = await res.json();
    appState.rootDirectory = data.root_directory;
    appState.folders = data.folders;
    appState.presets = data.presets;
    appState.defaultPrompt = data.default_prompt;
    appState.pricing = data.pricing || {};
    appState.defaultModel = data.default_model || appState.defaultModel || appState.model;
    appState.version = data.version || appState.version;
    appState.stats = data.stats || {};

    await fetchConsolidatedDocuments();

    if (!appState.systemPrompt) {
      const presetKey = appState.currentPreset || "financial";
      appState.systemPrompt = (data.presets && data.presets[presetKey])
        ? data.presets[presetKey].prompt
        : data.default_prompt;
    }

    // Populate upload folder select dropdown
    const uploadFolderSelect = document.getElementById("uploadFolderSelect");
    if (uploadFolderSelect) {
      uploadFolderSelect.innerHTML = "";
      data.folders.forEach(f => {
        const opt = document.createElement("option");
        opt.value = f.name;
        opt.textContent = f.name;
        uploadFolderSelect.appendChild(opt);
      });
      if (appState.activeFolder && appState.activeFolder !== "ALL") {
        uploadFolderSelect.value = appState.activeFolder;
      }
    }

    renderSidebarFolders();
    renderDocuments();
    renderStats();
    await refreshCombinerAvailableFiles();
  } catch (err) {
    eventBus.emit("alert:show", {
      title: "Workspace Load Failed",
      message: err.message,
      isWarning: false
    });
  }
}

async function init() {
  // 1. Initialize UI Components
  initHeader();
  initFolderSidebar();
  initDocumentTable();
  initStudio();
  watchNavOverflow();
  initSearchView();
  initEconomicsView();
  initCombinerModal();
  initDeflateView();
  initBatchModal();
  initBatchPlans();
  initSettingsModal();
  initLogsModal();
  initNewFolderModal();

  // 2. Wire Global Events
  eventBus.on("documents:reload", () => fetchDocuments());

  // 3. Update Notifications
  updateNotificationUI();

  // 4. Initial data load.
  //
  // Only the document scan is awaited: it is what the interface is waiting to
  // draw. Everything after it is a background check, and two of them reach
  // Google — which took 2.7s on a good connection and held the whole UI behind
  // it. Worse, it made the app look Gemini-gated when it is not: the Combiner
  // needs no key at all, and the document list is a local scan.
  await fetchDocuments();

  // Deliberately not awaited, and each isolated: a rejected API key must not
  // stop the job poller or the batch list from starting.
  testApiConnection(false).catch(() => {});
  checkJobStatus().catch(() => {});
  fetchBatchJobs(false).catch(() => {});
  fetchBatchPlans().catch(() => {});
}

window.addEventListener("DOMContentLoaded", init);
