/**
 * GooseQuill - Gemini Batch API Component & Studio View
 */

import { appState, eventBus } from "../state.js";
import { showToast, notifyCompletion } from "../services/notifications.js";
import { startJobPolling, stopJobPolling } from "../services/job_poller.js";
import { switchStudioView } from "./header.js";

let batchPollTimer = null;

export function initBatchModal() {
  const refreshBtn = document.getElementById("refreshBatchJobsStandaloneBtn");

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => fetchBatchJobs(true));
  }

  eventBus.on("studio:batches:activated", () => fetchBatchJobs(true));
  eventBus.on("modal:batch:open", (forceRefresh) => {
    switchStudioView("batches");
    fetchBatchJobs(forceRefresh);
  });
  eventBus.on("batch:submit", (files) => submitOvernightBatch(files));
}

export async function fetchBatchJobs(force = false) {
  const topNavBatchActiveBadge = document.getElementById("topNavBatchActiveBadge");

  try {
    const res = await fetch(`/api/batch/jobs${force ? "?force=true" : ""}`);
    const data = await res.json();
    const jobs = data.jobs || [];

    const activeCount = jobs.filter(j => j.status === "JOB_STATE_PENDING" || j.status === "JOB_STATE_RUNNING").length;
    if (activeCount > 0) {
      if (topNavBatchActiveBadge) {
        topNavBatchActiveBadge.textContent = `${activeCount} active`;
        topNavBatchActiveBadge.style.display = "inline-block";
      }

      if (!batchPollTimer) {
        batchPollTimer = setInterval(() => fetchBatchJobs(false), 60000);
      }
    } else {
      if (topNavBatchActiveBadge) topNavBatchActiveBadge.style.display = "none";
      if (batchPollTimer) {
        clearInterval(batchPollTimer);
        batchPollTimer = null;
      }
    }

    renderBatchJobsList(jobs);

    if (jobs.some(j => j.status === "JOB_STATE_SUCCEEDED" && j.is_collected)) {
      eventBus.emit("documents:reload");
    }
  } catch (err) {
    console.error("Error fetching batch jobs:", err);
  }
}

function renderBatchJobsList(jobs) {
  const listEl = document.getElementById("batchJobsStandaloneList");
  if (!listEl) return;

  // The list opens in its loading state; whatever we do below settles it.
  listEl.setAttribute("aria-busy", "false");

  if (jobs.length === 0) {
    listEl.innerHTML = `
      <div style="padding: 60px 20px; text-align: center; background-color: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 14px; opacity: 0.4;">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
        <h4 style="font-size: 16px; font-weight: 600;">No overnight batch jobs submitted yet</h4>
        <p class="text-muted text-sm mt-1" style="max-width: 480px; margin: 6px auto 0;">Select corporate entities or filings in the Workspace and click "Overnight (50% Off)" to process them at half token rates.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = "";
  jobs.forEach(job => {
    const card = document.createElement("div");
    card.className = "economics-card mb-3";

    let statusText = job.status.replace("JOB_STATE_", "");
    let actionBtn = "";

    if (job.status === "JOB_STATE_SUCCEEDED") {
      if (job.is_collected) {
        actionBtn = `<span class="badge" style="color: #34d399; font-weight: 600; display: inline-flex; align-items: center; gap: 5px;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>
          Markdown Assembled</span>`;
      } else {
        actionBtn = `<button class="btn btn-sm btn-accent collect-batch-btn" data-id="${job.id}">Collect & Assemble .md</button>`;
      }
    } else if (job.status === "JOB_STATE_RUNNING" || job.status === "JOB_STATE_PENDING") {
      actionBtn = `<span class="spinner" style="width: 16px; height: 16px;"></span>`;
    }

    const timeSubmitted = new Date(job.submitted_at * 1000).toLocaleString();

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;">
        <div>
          <h4 style="font-size: 15px; font-weight: 700; color: var(--text-main);">${job.display_name}</h4>
          <div class="text-muted text-sm mt-1" style="display: flex; gap: 12px; flex-wrap: wrap;">
            <span><strong>${job.total_documents}</strong> Documents (${job.total_requests} pages)</span>
            <span>•</span>
            <span>Model: <strong>${job.model}</strong></span>
            <span>•</span>
            <span>Submitted: ${timeSubmitted}</span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <span class="status-badge ${job.status}">${statusText}</span>
          ${actionBtn}
        </div>
      </div>
    `;

    const collectBtn = card.querySelector(".collect-batch-btn");
    if (collectBtn) {
      collectBtn.addEventListener("click", () => collectBatchResults(job.id, collectBtn));
    }

    listEl.appendChild(card);
  });
}

export async function submitOvernightBatch(files) {
  const submitBtn = document.getElementById("submitOvernightBatchBtn");

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting Batch...";
  }

  try {
    const res = await fetch("/api/batch/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: files,
        model: appState.model,
        system_prompt: appState.systemPrompt
      })
    });
    const data = await res.json();
    if (res.ok) {
      appState.recentLogs.push({ text: `[INFO] Submitted overnight Batch API job for ${files.length} document(s) (50% discount).`, type: "normal" });
      eventBus.emit("logs:updated");
      notifyCompletion("Overnight Batch Submitted", `${files.length} document(s) queued for overnight processing.`);
      switchStudioView("batches");
      await fetchBatchJobs(true);
    } else {
      eventBus.emit("alert:show", {
        title: "Batch API Error",
        message: data.detail || "Failed to submit batch job.",
        isWarning: false
      });
    }
  } catch (e) {
    eventBus.emit("alert:show", {
      title: "Network Error",
      message: e.message,
      isWarning: false
    });
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
        Overnight (50% Off)
      `;
    }
  }
}

async function collectBatchResults(jobId, btnElement) {
  if (btnElement) {
    btnElement.disabled = true;
    btnElement.textContent = "Assembling Markdown...";
  }

  try {
    const res = await fetch("/api/batch/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId })
    });
    const data = await res.json();

    if (res.ok && data.status === "success") {
      appState.recentLogs.push({ text: `[INFO] Assembled ${data.assembled_files_count} markdown file(s) from batch job ${jobId}`, type: "normal" });
      eventBus.emit("logs:updated");
      eventBus.emit("documents:reload");
      await fetchBatchJobs();
      showToast("Batch Assembled!", `Created ${data.assembled_files_count} markdown files.`);
    } else {
      showToast("Batch Collect Error", data.message || "Failed to collect batch results.", true);
    }
  } catch (e) {
    showToast("Batch Collect Error", e.message, true);
  }
}
