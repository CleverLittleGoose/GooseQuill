/**
 * GooseQuill - Background Job & Polling Manager
 */

import { appState, eventBus } from "../state.js";
import { notifyCompletion, showToast } from "./notifications.js";

let jobStatusTimer = null;
let wasJobRunning = false;

export function startJobPolling(intervalMs = 1500) {
  if (jobStatusTimer) clearInterval(jobStatusTimer);
  jobStatusTimer = setInterval(checkJobStatus, intervalMs);
}

export function stopJobPolling() {
  if (jobStatusTimer) {
    clearInterval(jobStatusTimer);
    jobStatusTimer = null;
  }
}

export async function checkJobStatus() {
  const progressBanner = document.getElementById("progressBanner");
  const bannerDocName = document.getElementById("bannerDocName");
  const bannerPageInfo = document.getElementById("bannerPageInfo");
  const progressBarFill = document.getElementById("progressBarFill");
  const rateLimitWarningPill = document.getElementById("rateLimitWarningPill");
  const errorCountBadge = document.getElementById("errorCountBadge");
  const batchPrepProgressBox = document.getElementById("batchPrepProgressBox");
  const batchPrepPercentText = document.getElementById("batchPrepPercentText");
  const batchPrepProgressBarFill = document.getElementById("batchPrepProgressBarFill");
  const batchPrepStatusText = document.getElementById("batchPrepStatusText");

  try {
    const res = await fetch("/api/job_status");
    const status = await res.json();

    if (status.logs && status.logs.length > 0) {
      status.logs.forEach(l => {
        const isErr = l.includes("[ERROR]");
        const isWarn = l.includes("[WARNING]");
        if (!appState.recentLogs.some(existing => existing.text === l)) {
          appState.recentLogs.push({
            text: l,
            type: isErr ? "error" : (isWarn ? "warning" : "normal")
          });
          if (appState.recentLogs.length > 200) appState.recentLogs.shift();
          eventBus.emit("logs:updated");
        }
      });
    }

    if (status.errors && status.errors.length > 0) {
      if (errorCountBadge) {
        errorCountBadge.textContent = status.errors.length;
        errorCountBadge.style.display = "inline-block";
      }
    } else if (errorCountBadge) {
      errorCountBadge.style.display = "none";
    }

    if (status.warning_message) {
      if (rateLimitWarningPill) {
        rateLimitWarningPill.style.display = "inline-block";
        rateLimitWarningPill.textContent = status.warning_message;
      }
    } else if (rateLimitWarningPill) {
      rateLimitWarningPill.style.display = "none";
    }

    if (status.error) {
      eventBus.emit("alert:show", {
        title: "Conversion Interrupted",
        message: status.error,
        isWarning: false
      });
    }

    if (batchPrepProgressBox && batchPrepProgressBox.style.display !== "none") {
      if (status.is_running) {
        if (batchPrepPercentText) batchPrepPercentText.textContent = `${status.percent}%`;
        if (batchPrepProgressBarFill) batchPrepProgressBarFill.style.width = `${status.percent}%`;
        if (status.current_file && batchPrepStatusText) batchPrepStatusText.textContent = status.current_file;
      }
    }

    if (status.is_running) {
      wasJobRunning = true;
      startJobPolling(1500);
      if (progressBanner) progressBanner.style.display = "block";
      if (bannerDocName) bannerDocName.textContent = status.current_file || "Processing...";
      if (bannerPageInfo) bannerPageInfo.textContent = `Page ${status.current_page} of ${status.total_pages} (${status.percent}%)`;
      if (progressBarFill) progressBarFill.style.width = `${status.percent}%`;
    } else {
      stopJobPolling();
      if (wasJobRunning) {
        wasJobRunning = false;
        notifyCompletion("Conversion Queue Complete! 🎉", "All selected documents have been transcribed into Markdown.");
      }
      if (progressBanner && progressBanner.style.display !== "none") {
        progressBanner.style.display = "none";
        eventBus.emit("documents:reload");
      }
    }
  } catch (e) {
    console.error("Polling error:", e);
  }
}

/** Ask the server to stop the running conversion. */
export async function cancelConversion() {
  const cancelBtn = document.getElementById("cancelJobBtn");
  if (cancelBtn) cancelBtn.textContent = "Cancelling...";
  try {
    const res = await fetch("/api/cancel", { method: "POST" });
    if (!res.ok) throw new Error(`Cancel failed (${res.status})`);
  } catch (e) {
    console.error("Cancel error:", e);
    if (cancelBtn) cancelBtn.textContent = "Cancel Job";
    showToast("Could not cancel", "The job is still running.", true);
  }
}
