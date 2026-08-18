/**
 * GooseQuill - Top Header & Action Controls Component
 */

import { appState, eventBus } from "../state.js";
import { requestNotificationPermission, updateNotificationUI, showToast } from "../services/notifications.js";
import { startJobPolling, checkJobStatus } from "../services/job_poller.js";

export function initHeader() {
  const apiStatusPill = document.getElementById("apiStatusPill");
  const toggleNotificationsBtn = document.getElementById("toggleNotificationsBtn");
  const openLogsBtn = document.getElementById("openLogsBtn");
  const openSettingsBtn = document.getElementById("openSettingsBtn");
  const openUploadModalBtn = document.getElementById("openUploadModalBtn");
  const cancelJobBtn = document.getElementById("cancelJobBtn");
  const apiAlertBanner = document.getElementById("apiAlertBanner");
  const alertTitle = document.getElementById("alertTitle");
  const alertMessage = document.getElementById("alertMessage");
  const alertViewLogsBtn = document.getElementById("alertViewLogsBtn");
  const dismissAlertBtn = document.getElementById("dismissAlertBtn");
  const studioTabBtns = document.querySelectorAll(".studio-tab-btn");

  // Studio View Switcher Tabs
  studioTabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetView = btn.dataset.view;
      if (!targetView) return;
      switchStudioView(targetView);
    });
  });

  // Upload Modal Trigger
  if (openUploadModalBtn) {
    openUploadModalBtn.addEventListener("click", () => eventBus.emit("modal:upload:open"));
  }

  // Notifications
  if (toggleNotificationsBtn) {
    toggleNotificationsBtn.addEventListener("click", requestNotificationPermission);
  }

  // Modals
  if (openLogsBtn) {
    openLogsBtn.addEventListener("click", () => eventBus.emit("modal:logs:open"));
  }
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener("click", () => eventBus.emit("modal:settings:open"));
  }

  // API Status Pill Click -> Open Logs Modal
  if (apiStatusPill) {
    apiStatusPill.addEventListener("click", () => eventBus.emit("modal:logs:open"));
  }

  // Alert Banner
  if (alertViewLogsBtn) {
    alertViewLogsBtn.addEventListener("click", () => eventBus.emit("modal:logs:open"));
  }
  if (dismissAlertBtn) {
    dismissAlertBtn.addEventListener("click", () => {
      if (apiAlertBanner) apiAlertBanner.style.display = "none";
    });
  }

  eventBus.on("alert:show", ({ title, message, isWarning }) => {
    if (!apiAlertBanner) return;
    apiAlertBanner.className = `api-alert-banner ${isWarning ? "warning" : ""}`;
    if (alertTitle) alertTitle.textContent = title;
    if (alertMessage) alertMessage.textContent = message;
    apiAlertBanner.style.display = "block";
  });

  // Cancel Job
  if (cancelJobBtn) {
    cancelJobBtn.addEventListener("click", async () => {
      cancelJobBtn.textContent = "Cancelling...";
      await fetch("/api/cancel", { method: "POST" });
    });
  }

  eventBus.on("view:switch", (viewName) => switchStudioView(viewName));
}

export function switchStudioView(viewName) {
  appState.currentView = viewName;

  // 1. Update Tab Buttons Active State
  const studioTabBtns = document.querySelectorAll(".studio-tab-btn");
  studioTabBtns.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === viewName);
  });

  // 2. Toggle View Containers
  const views = {
    workspace: document.getElementById("viewWorkspace"),
    combiner: document.getElementById("viewCombiner"),
    batches: document.getElementById("viewBatches"),
    economics: document.getElementById("viewEconomics")
  };

  Object.entries(views).forEach(([key, el]) => {
    if (el) {
      if (key === viewName) {
        el.style.display = "flex";
        el.classList.add("active");
      } else {
        el.style.display = "none";
        el.classList.remove("active");
      }
    }
  });

  // 3. Trigger view-specific refreshes
  if (viewName === "combiner") {
    eventBus.emit("studio:combiner:activated");
  } else if (viewName === "batches") {
    eventBus.emit("studio:batches:activated");
  } else if (viewName === "economics") {
    eventBus.emit("studio:economics:activated");
  }
}

export async function testApiConnection(userInitiated = false) {
  const apiStatusPill = document.getElementById("apiStatusPill");
  const statusDot = document.getElementById("statusDot");
  const apiStatusText = document.getElementById("apiStatusText");

  if (apiStatusText) apiStatusText.textContent = "Testing API...";
  if (statusDot) statusDot.className = "pulse-dot warning";

  try {
    const res = await fetch(`/api/test_connection?model=${encodeURIComponent(appState.model)}`);
    const data = await res.json();

    if (data.status === "connected") {
      appState.apiConnected = true;
      appState.apiErrorDetail = null;
      if (apiStatusPill) apiStatusPill.className = "status-pill active";
      if (statusDot) statusDot.className = "pulse-dot";
      if (apiStatusText) apiStatusText.textContent = `API Connected (${appState.model})`;

      if (userInitiated) {
        appState.recentLogs.push({ text: `[INFO] Connection test succeeded for model: ${appState.model}`, type: "normal" });
        eventBus.emit("logs:updated");
      }
    } else {
      appState.apiConnected = false;
      appState.apiErrorDetail = data.message || "Unknown error";
      if (apiStatusPill) apiStatusPill.className = "status-pill error";
      if (statusDot) statusDot.className = "pulse-dot error";
      if (apiStatusText) apiStatusText.textContent = "API Error (Click for details)";

      const noKey = data.error_type === "NO_KEY";
      if (apiStatusText) {
        apiStatusText.textContent = noKey ? "No API key set" : "API Error (Click for details)";
      }
      if (apiStatusPill) apiStatusPill.className = `status-pill ${noKey ? "warning" : "error"}`;
      if (statusDot) statusDot.className = `pulse-dot ${noKey ? "warning" : "error"}`;

      eventBus.emit("alert:show", {
        title: noKey ? "No Gemini API key set" : `Gemini API Error (${data.error_type || "Error"})`,
        // Naming what still works is the point. Without it a first run looks
        // like a broken app, and someone who only wanted to combine markdown
        // has no way of knowing they can carry on.
        message: noKey
          ? `Converting PDFs needs a Gemini API key — add one in Settings. `
            + `Everything else works without it: ${(data.offline_features || []).join(", ")}.`
          : data.message,
        isWarning: noKey
      });
    }
  } catch (err) {
    appState.apiConnected = false;
    appState.apiErrorDetail = err.message;
    if (apiStatusPill) apiStatusPill.className = "status-pill error";
    if (statusDot) statusDot.className = "pulse-dot error";
    if (apiStatusText) apiStatusText.textContent = "Network Error";

    eventBus.emit("alert:show", {
      title: "Server Connection Error",
      message: err.message,
      isWarning: false
    });
  }
}

export async function startConversion(files) {
  const activeRunningDocs = [];
  appState.folders.forEach(f => {
    f.documents.forEach(d => {
      if (files.includes(d.path) && (d.batch_status === "JOB_STATE_RUNNING" || d.batch_status === "JOB_STATE_PENDING")) {
        activeRunningDocs.push(d.name);
      }
    });
  });

  if (activeRunningDocs.length > 0) {
    const proceed = confirm(`⚠️ Notice: ${activeRunningDocs.length} of the selected document(s) are already processing in an active Gemini Batch job.\n\nRunning standard conversion now will duplicate the processing.\n\nDo you want to proceed anyway?`);
    if (!proceed) return;
  }

  const progressBanner = document.getElementById("progressBanner");
  const rateLimitWarningPill = document.getElementById("rateLimitWarningPill");
  const apiAlertBanner = document.getElementById("apiAlertBanner");

  try {
    const res = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: files,
        model: appState.model,
        system_prompt: appState.systemPrompt,
        force_reprocess: appState.forceReprocess,
        concurrency: appState.concurrency || 5
      })
    });
    if (res.ok) {
      if (progressBanner) progressBanner.style.display = "block";
      if (rateLimitWarningPill) rateLimitWarningPill.style.display = "none";
      if (apiAlertBanner) apiAlertBanner.style.display = "none";
      startJobPolling(1500);
      checkJobStatus();
    } else {
      const err = await res.json();
      eventBus.emit("alert:show", {
        title: "Conversion Request Failed",
        message: err.detail || "Unable to start conversion job.",
        isWarning: false
      });
    }
  } catch (e) {
    eventBus.emit("alert:show", {
      title: "Network Error",
      message: e.message,
      isWarning: false
    });
  }
}
