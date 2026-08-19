/**
 * GooseQuill - Folder Sidebar & Upload Component
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";

// Generates consistent initials from entity names
function getInitials(name) {
  if (!name || name === "ALL") return "ALL";
  const words = name.replace(/[^a-zA-Z0-9\s]/g, "").trim().split(/\s+/);
  if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Generates pleasant hue from name hash
function getAvatarColor(name) {
  if (name === "ALL") return { bg: "rgba(59, 130, 246, 0.2)", text: "#60a5fa" };
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hues = [210, 225, 260, 280, 160, 180, 330];
  const hue = hues[Math.abs(hash) % hues.length];
  return {
    bg: `hsla(${hue}, 70%, 50%, 0.2)`,
    text: `hsl(${hue}, 80%, 75%)`
  };
}

export function initFolderSidebar() {
  const refreshBtn = document.getElementById("refreshBtn");
  const newFolderBtn = document.getElementById("newFolderBtn");
  const folderSearchInput = document.getElementById("folderSearchInput");
  const sidebarQuickUploadBtn = document.getElementById("sidebarQuickUploadBtn");

  // Upload Modal Elements
  const uploadModal = document.getElementById("uploadModal");
  const closeUploadModalBtn = document.getElementById("closeUploadModalBtn");
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");
  const uploadTargetFolderSelect = document.getElementById("uploadTargetFolderSelect");

  if (folderSearchInput) {
    folderSearchInput.addEventListener("input", () => {
      appState.folderSearchQuery = folderSearchInput.value.trim().toLowerCase();
      renderSidebarFolders();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => eventBus.emit("documents:reload"));
  }

  if (newFolderBtn) {
    newFolderBtn.addEventListener("click", () => eventBus.emit("modal:new_folder:open"));
  }

  if (sidebarQuickUploadBtn) {
    sidebarQuickUploadBtn.addEventListener("click", () => openUploadModal());
  }

  if (closeUploadModalBtn) {
    closeUploadModalBtn.addEventListener("click", () => {
      if (uploadModal) uploadModal.style.display = "none";
    });
  }

  // Upload Drag & Drop in Upload Modal
  if (dropZone && fileInput) {
    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      if (e.dataTransfer.files.length > 0) {
        handleUploadFiles(e.dataTransfer.files);
      }
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files.length > 0) {
        handleUploadFiles(fileInput.files);
      }
    });
  }

  eventBus.on("modal:upload:open", () => openUploadModal());

  eventBus.on("folders:updated", () => {
    renderSidebarFolders();
    renderStats();
    populateUploadTargetFolders();
  });
}

function openUploadModal() {
  const uploadModal = document.getElementById("uploadModal");
  populateUploadTargetFolders();
  if (uploadModal) uploadModal.style.display = "flex";
}

function populateUploadTargetFolders() {
  const uploadTargetFolderSelect = document.getElementById("uploadTargetFolderSelect");
  if (!uploadTargetFolderSelect) return;

  const currentSelected = uploadTargetFolderSelect.value || appState.activeFolder;
  uploadTargetFolderSelect.innerHTML = "";

  appState.folders.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f.name;
    opt.textContent = `${f.name} (${f.documents.length} docs)`;
    uploadTargetFolderSelect.appendChild(opt);
  });

  if (currentSelected && currentSelected !== "ALL") {
    uploadTargetFolderSelect.value = currentSelected;
  }
}

export function renderSidebarFolders() {
  const folderListEl = document.getElementById("folderList");
  if (!folderListEl) return;
  folderListEl.innerHTML = "";

  const query = appState.folderSearchQuery || "";
  const totalDocs = appState.folders.reduce((acc, f) => acc + f.documents.length, 0);
  const totalConverted = appState.folders.reduce((acc, f) => acc + f.documents.filter(d => d.is_converted).length, 0);
  const totalBatchActive = appState.folders.reduce((acc, f) => acc + (f.batch_active_count || 0), 0);

  // 1. "All Documents" Item
  if (!query || "all documents all folders".includes(query)) {
    const allLi = document.createElement("li");
    allLi.className = `entity-item ${appState.activeFolder === "ALL" ? "active" : ""}`;
    const allColors = getAvatarColor("ALL");

    allLi.innerHTML = `
      <div class="entity-left">
        <div class="entity-avatar" style="background: ${allColors.bg}; color: ${allColors.text};">ALL</div>
        <span class="entity-name">All Folders</span>
      </div>
      <div class="entity-right">
        ${totalBatchActive > 0 ? `<span class="progress-pill batch" title="${totalBatchActive} in Gemini Batch"><svg class="pill-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10M7 21h10"></path><path d="M8 3v4.5a4 4 0 0 0 1.6 3.2L12 12l-2.4 1.3A4 4 0 0 0 8 16.5V21"></path><path d="M16 3v4.5a4 4 0 0 1-1.6 3.2L12 12l2.4 1.3a4 4 0 0 1 1.6 3.2V21"></path></svg>${totalBatchActive}</span>` : ""}
        <span class="progress-pill ${totalConverted === totalDocs && totalDocs > 0 ? 'completed' : ''}">${totalConverted}/${totalDocs}</span>
      </div>
    `;
    allLi.addEventListener("click", () => {
      appState.activeFolder = "ALL";
      renderSidebarFolders();
      eventBus.emit("documents:render");
    });
    folderListEl.appendChild(allLi);
  }

  // 2. Individual Entities
  const matchingFolders = query
    ? appState.folders.filter(f => f.name.toLowerCase().includes(query))
    : appState.folders;

  if (matchingFolders.length === 0 && query) {
    const emptyLi = document.createElement("li");
    emptyLi.className = "text-muted text-xs text-center";
    emptyLi.style.padding = "24px 10px";
    emptyLi.textContent = `No corporate entities match "${query}"`;
    folderListEl.appendChild(emptyLi);
    return;
  }

  matchingFolders.forEach(f => {
    const li = document.createElement("li");
    li.className = `entity-item ${appState.activeFolder === f.name ? "active" : ""}`;
    li.title = f.name;

    const count = f.documents.length;
    const converted = f.documents.filter(d => d.is_converted).length;
    const batchActive = f.batch_active_count || 0;
    const initials = getInitials(f.name);
    const colors = getAvatarColor(f.name);

    let progressClass = "progress-pill";
    if (converted === count && count > 0) {
      progressClass += " completed";
    } else if (converted === 0 && count > 0) {
      progressClass += " unconverted";
    }

    li.innerHTML = `
      <div class="entity-left">
        <div class="entity-avatar" style="background: ${colors.bg}; color: ${colors.text};">${initials}</div>
        <span class="entity-name">${f.name}</span>
      </div>
      <div class="entity-right">
        ${batchActive > 0 ? `<span class="progress-pill batch" title="${batchActive} in batch"><svg class="pill-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10M7 21h10"></path><path d="M8 3v4.5a4 4 0 0 0 1.6 3.2L12 12l-2.4 1.3A4 4 0 0 0 8 16.5V21"></path><path d="M16 3v4.5a4 4 0 0 1-1.6 3.2L12 12l2.4 1.3a4 4 0 0 1 1.6 3.2V21"></path></svg>${batchActive}</span>` : ""}
        <span class="${progressClass}">${converted === count && count > 0 ? `${converted}/${count}<svg class="pill-glyph" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>` : `${converted}/${count}`}</span>
      </div>
    `;

    li.addEventListener("click", () => {
      appState.activeFolder = f.name;
      renderSidebarFolders();
      eventBus.emit("documents:render");
    });

    folderListEl.appendChild(li);
  });
}

export function renderStats() {
  const totalReportsCountEl = document.getElementById("totalReportsCount");
  const convertedReportsCountEl = document.getElementById("convertedReportsCount");
  const topNavConvertedBadge = document.getElementById("topNavConvertedBadge");
  const topNavBatchActiveBadge = document.getElementById("topNavBatchActiveBadge");

  // Economics View stats
  const econTotalDocs = document.getElementById("econTotalDocs");
  const econTotalPages = document.getElementById("econTotalPages");
  const econStandardCost = document.getElementById("econStandardCost");
  const econBatchCost = document.getElementById("econBatchCost");

  let totalReports = 0;
  let convertedReports = 0;
  let totalPages = 0;
  let totalBatchActive = 0;

  appState.folders.forEach(f => {
    totalBatchActive += (f.batch_active_count || 0);
    f.documents.forEach(d => {
      totalReports++;
      if (d.is_converted) convertedReports++;
      totalPages += d.total_pages || 0;
    });
  });

  if (totalReportsCountEl) totalReportsCountEl.textContent = totalReports;
  if (convertedReportsCountEl) convertedReportsCountEl.textContent = convertedReports;

  if (topNavConvertedBadge) {
    if (convertedReports > 0) {
      topNavConvertedBadge.textContent = `${convertedReports}`;
      topNavConvertedBadge.style.display = "inline-block";
    } else {
      topNavConvertedBadge.style.display = "none";
    }
  }

  if (topNavBatchActiveBadge) {
    if (totalBatchActive > 0) {
      topNavBatchActiveBadge.textContent = `${totalBatchActive} active`;
      topNavBatchActiveBadge.style.display = "inline-block";
    } else {
      topNavBatchActiveBadge.style.display = "none";
    }
  }

  // Token calculation factors:
  const inputTokens = totalPages * 400;
  const outputTokens = totalPages * 850;

  const currentModelKey = appState.model || "gemini-3.1-flash-lite";
  const modelRates = (appState.pricing && appState.pricing[currentModelKey]) || {
    name: "Gemini 3.1 Flash-Lite",
    input_standard: 0.25,
    output_standard: 1.50,
    input_batch: 0.125,
    output_batch: 0.75
  };

  const standardCost = (inputTokens / 1_000_000 * modelRates.input_standard) +
                       (outputTokens / 1_000_000 * modelRates.output_standard);
  const batchCost = (inputTokens / 1_000_000 * modelRates.input_batch) +
                    (outputTokens / 1_000_000 * modelRates.output_batch);

  if (econTotalDocs) econTotalDocs.textContent = totalReports.toLocaleString();
  if (econTotalPages) econTotalPages.textContent = totalPages.toLocaleString();
  if (econStandardCost) econStandardCost.textContent = `$${standardCost.toFixed(3)} USD`;
  if (econBatchCost) econBatchCost.textContent = `$${batchCost.toFixed(3)} USD`;
}

async function handleUploadFiles(fileList) {
  const uploadModal = document.getElementById("uploadModal");
  const uploadTargetFolderSelect = document.getElementById("uploadTargetFolderSelect");
  const folder = (uploadTargetFolderSelect && uploadTargetFolderSelect.value) || (appState.folders.length > 0 ? appState.folders[0].name : "General");

  let uploadedCount = 0;
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (!file.name.toLowerCase().endsWith(".pdf")) continue;

    const formData = new FormData();
    formData.append("file", file);
    formData.append("folder_name", folder);

    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      if (res.ok) uploadedCount++;
    } catch (e) {
      console.error(e);
    }
  }

  if (uploadedCount > 0) {
    if (uploadModal) uploadModal.style.display = "none";
    showToast("Upload Successful", `Uploaded ${uploadedCount} PDF(s) to ${folder}`);
    appState.recentLogs.push({ text: `[INFO] Uploaded ${uploadedCount} filing(s) to ${folder}`, type: "normal" });
    eventBus.emit("logs:updated");
    eventBus.emit("documents:reload");
  } else {
    showToast("Upload Error", "No valid PDF files were uploaded.", true);
  }
}
