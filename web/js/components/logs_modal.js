/**
 * GooseQuill - Logs & Diagnostics Modal Component
 */

import { appState, eventBus } from "../state.js";
import { testApiConnection } from "./header.js";

export function initLogsModal() {
  const openLogsBtn = document.getElementById("openLogsBtn") || document.getElementById("openLogsModalBtn");
  const logsModal = document.getElementById("logsModal");
  const closeLogsBtn = document.getElementById("closeLogsBtn");
  const modalTestApiBtn = document.getElementById("modalTestApiBtn");
  const clearLogsBtn = document.getElementById("clearLogsBtn");

  if (openLogsBtn) {
    openLogsBtn.addEventListener("click", () => openLogsModal());
  }


  if (closeLogsBtn) {
    closeLogsBtn.addEventListener("click", () => {
      if (logsModal) logsModal.style.display = "none";
    });
  }

  if (modalTestApiBtn) {
    modalTestApiBtn.addEventListener("click", () => testApiConnection(true));
  }

  if (clearLogsBtn) {
    clearLogsBtn.addEventListener("click", () => {
      appState.recentLogs = [];
      renderLogsConsole();
    });
  }

  eventBus.on("modal:logs:open", () => openLogsModal());
  eventBus.on("logs:updated", () => renderLogsConsole());
}

export function openLogsModal() {
  const logsModal = document.getElementById("logsModal");
  if (logsModal) logsModal.style.display = "flex";
  renderLogsConsole();
}

export function renderLogsConsole() {
  const liveLogsConsole = document.getElementById("liveLogsConsole");
  if (!liveLogsConsole) return;

  if (appState.recentLogs.length === 0) {
    liveLogsConsole.innerHTML = `<div class="log-line text-muted">No diagnostic logs recorded yet.</div>`;
    return;
  }

  liveLogsConsole.innerHTML = "";
  appState.recentLogs.forEach(l => {
    const div = document.createElement("div");
    div.className = `log-line ${l.type === "error" ? "error" : (l.type === "warning" ? "warning" : "")}`;
    div.textContent = l.text;
    liveLogsConsole.appendChild(div);
  });
  liveLogsConsole.scrollTop = liveLogsConsole.scrollHeight;
}
