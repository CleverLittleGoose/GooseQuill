/**
 * GooseQuill - Web Application Bootstrap & Orchestrator
 * Modular ES6 Architecture
 */

import { appState, eventBus } from "./js/state.js";
import { updateNotificationUI } from "./js/services/notifications.js";
import { checkJobStatus } from "./js/services/job_poller.js";
import { initHeader, testApiConnection } from "./js/components/header.js";
import { initFolderSidebar, renderSidebarFolders, renderStats } from "./js/components/folder_sidebar.js";
import { initDocumentTable, renderDocuments, updateSelectedUI } from "./js/components/document_table.js";
import { initViewerModal } from "./js/components/viewer_modal.js";
import { initSearchView } from "./js/components/search_view.js";
import { initCombinerModal, refreshCombinerAvailableFiles } from "./js/components/combiner_modal.js";
import { initBatchModal, fetchBatchJobs } from "./js/components/batch_modal.js";
import { initSettingsModal } from "./js/components/settings_modal.js";
import { initLogsModal } from "./js/components/logs_modal.js";
import { initNewFolderModal } from "./js/components/new_folder_modal.js";

export async function fetchDocuments() {
  try {
    const res = await fetch(`/api/documents?model=${encodeURIComponent(appState.model)}`);
    const data = await res.json();
    appState.rootDirectory = data.root_directory;
    appState.folders = data.folders;
    appState.presets = data.presets;
    appState.defaultPrompt = data.default_prompt;
    appState.pricing = data.pricing || {};
    appState.stats = data.stats || {};

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
  initViewerModal();
  initSearchView();
  initCombinerModal();
  initBatchModal();
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
}

window.addEventListener("DOMContentLoaded", init);
