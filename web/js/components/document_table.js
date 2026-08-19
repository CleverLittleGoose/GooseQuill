/**
 * GooseQuill - Document Data Grid & Selection Table Component
 */

import { appState, eventBus } from "../state.js";
import { startConversion } from "./header.js";
import { switchStudioView } from "./header.js";

function extractYear(name) {
  const matches = name.match(/(?:^|[^\d])(19\d\d|20\d\d)(?:[^\d]|$)/g);
  if (matches && matches.length > 0) {
    const last = matches[matches.length - 1].replace(/[^\d]/g, "");
    return parseInt(last, 10);
  }
  return 0;
}

export function initDocumentTable() {
  const selectAllBtn = document.getElementById("selectAllBtn");
  const deselectAllBtn = document.getElementById("deselectAllBtn");
  const convertScopeBtn = document.getElementById("convertScopeBtn");
  const submitOvernightBatchBtn = document.getElementById("submitOvernightBatchBtn");
  const combineFolderBtn = document.getElementById("combineFolderBtn");
  const floatingBatchBtn = document.getElementById("floatingBatchBtn");
  const floatingClearSelectionBtn = document.getElementById("floatingClearSelectionBtn");
  const convertSelectedBtn = document.getElementById("convertSelectedBtn");
  const combineSelectedBtn = document.getElementById("combineSelectedBtn");
  const documentSearchInput = document.getElementById("documentSearchInput");
  const documentSortSelect = document.getElementById("documentSortSelect");
  const masterTableCheckbox = document.getElementById("masterTableCheckbox");
  const filterTabBtns = document.querySelectorAll(".filter-tab-btn");

  // Filter Tabs
  filterTabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      filterTabBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      appState.filterStatus = btn.dataset.filter || "all";
      renderDocuments();
    });
  });

  // Search Input
  if (documentSearchInput) {
    documentSearchInput.addEventListener("input", () => {
      appState.searchQuery = documentSearchInput.value.trim().toLowerCase();
      renderDocuments();
    });
  }

  // Sort Select
  if (documentSortSelect) {
    documentSortSelect.addEventListener("change", () => {
      renderDocuments();
    });
  }

  // Master Checkbox
  if (masterTableCheckbox) {
    masterTableCheckbox.addEventListener("change", (e) => {
      const visibleDocs = getFilteredAndSortedDocs();
      if (e.target.checked) {
        visibleDocs.forEach(d => appState.selectedFiles.add(d.path));
      } else {
        visibleDocs.forEach(d => appState.selectedFiles.delete(d.path));
      }
      renderDocuments();
    });
  }

  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", selectAllCurrent);
  }
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener("click", deselectAllCurrent);
  }

  if (convertScopeBtn) {
    convertScopeBtn.addEventListener("click", convertCurrentFolderScope);
  }

  if (submitOvernightBatchBtn) {
    submitOvernightBatchBtn.addEventListener("click", () => {
      let docs = [];
      if (appState.activeFolder === "ALL" || !appState.activeFolder) {
        appState.folders.forEach(f => docs.push(...f.documents));
      } else {
        const f = appState.folders.find(f => f.name === appState.activeFolder);
        if (f) docs = f.documents;
      }
      const files = docs.map(d => d.path);
      if (files.length > 0) {
        eventBus.emit("batch:submit", files);
      }
    });
  }

  if (combineFolderBtn) {
    combineFolderBtn.addEventListener("click", () => {
      switchStudioView("combiner");
    });
  }

  if (convertSelectedBtn) {
    convertSelectedBtn.addEventListener("click", () => {
      const files = Array.from(appState.selectedFiles);
      if (files.length > 0) startConversion(files);
    });
  }

  if (floatingBatchBtn) {
    floatingBatchBtn.addEventListener("click", () => {
      const files = Array.from(appState.selectedFiles);
      if (files.length > 0) eventBus.emit("batch:submit", files);
    });
  }

  if (combineSelectedBtn) {
    combineSelectedBtn.addEventListener("click", () => {
      switchStudioView("combiner");
    });
  }

  if (floatingClearSelectionBtn) {
    floatingClearSelectionBtn.addEventListener("click", deselectAllCurrent);
  }

  eventBus.on("documents:render", () => renderDocuments());
  eventBus.on("selection:updated", () => updateSelectedUI());
}

function getFilteredAndSortedDocs() {
  let docs = [];
  if (appState.activeFolder === "ALL" || !appState.activeFolder) {
    appState.folders.forEach(f => docs.push(...f.documents));
  } else {
    const folderObj = appState.folders.find(f => f.name === appState.activeFolder);
    if (folderObj) docs = [...folderObj.documents];
  }

  // 1. Status Filter
  const statusFilter = appState.filterStatus || "all";
  if (statusFilter === "ready") {
    docs = docs.filter(d => !d.is_converted && d.batch_status !== "JOB_STATE_RUNNING" && d.batch_status !== "JOB_STATE_PENDING");
  } else if (statusFilter === "converted") {
    docs = docs.filter(d => d.is_converted);
  } else if (statusFilter === "batch") {
    docs = docs.filter(d => d.batch_status === "JOB_STATE_RUNNING" || d.batch_status === "JOB_STATE_PENDING");
  }

  // 2. Search Query Filter
  const query = appState.searchQuery || "";
  if (query) {
    docs = docs.filter(d => d.name.toLowerCase().includes(query) || (d.folder && d.folder.toLowerCase().includes(query)));
  }

  // 3. Sorting
  const sortSelect = document.getElementById("documentSortSelect");
  const sortMode = (sortSelect && sortSelect.value) || "year_desc";

  docs.sort((a, b) => {
    const yearA = extractYear(a.name);
    const yearB = extractYear(b.name);

    if (sortMode === "year_desc") {
      return (yearB - yearA) || a.name.localeCompare(b.name);
    } else if (sortMode === "year_asc") {
      return (yearA - yearB) || a.name.localeCompare(b.name);
    } else if (sortMode === "name_asc") {
      return a.name.localeCompare(b.name);
    } else if (sortMode === "pages_desc") {
      return (b.total_pages || 0) - (a.total_pages || 0);
    } else if (sortMode === "size_desc") {
      return (b.file_size || 0) - (a.file_size || 0);
    }
    return 0;
  });

  return docs;
}

function convertCurrentFolderScope() {
  let filesToConvert = [];
  if (appState.activeFolder === "ALL" || !appState.activeFolder) {
    appState.folders.forEach(f => {
      f.documents.forEach(d => {
        if (!d.is_converted) filesToConvert.push(d.path);
      });
    });
  } else {
    const folderObj = appState.folders.find(f => f.name === appState.activeFolder);
    if (folderObj) {
      folderObj.documents.forEach(d => {
        if (!d.is_converted) filesToConvert.push(d.path);
      });
    }
  }

  if (filesToConvert.length > 0) {
    startConversion(filesToConvert);
  } else {
    // If all are already converted, allow re-converting with confirmation
    let allInFolder = [];
    if (appState.activeFolder === "ALL" || !appState.activeFolder) {
      appState.folders.forEach(f => f.documents.forEach(d => allInFolder.push(d.path)));
    } else {
      const folderObj = appState.folders.find(f => f.name === appState.activeFolder);
      if (folderObj) folderObj.documents.forEach(d => allInFolder.push(d.path));
    }
    if (allInFolder.length > 0 && confirm("All documents in this view are already converted. Re-convert them now?")) {
      startConversion(allInFolder);
    }
  }
}

export function renderDocuments() {
  const documentsTableBody = document.getElementById("documentsTableBody");
  const activeFolderTitleEl = document.getElementById("activeFolderTitle");
  const activeFolderSubtitleEl = document.getElementById("activeFolderSubtitle");
  const convertScopeBtn = document.getElementById("convertScopeBtn");
  const combineFolderBtn = document.getElementById("combineFolderBtn");
  const folderConvertedCount = document.getElementById("folderConvertedCount");
  const scopeDocCount = document.getElementById("scopeDocCount");
  const masterTableCheckbox = document.getElementById("masterTableCheckbox");

  const countFilterAll = document.getElementById("countFilterAll");
  const countFilterReady = document.getElementById("countFilterReady");
  const countFilterConverted = document.getElementById("countFilterConverted");
  const countFilterBatch = document.getElementById("countFilterBatch");

  if (!documentsTableBody) return;

  // Compute folder-level metrics
  let allFolderDocs = [];
  if (appState.activeFolder === "ALL" || !appState.activeFolder) {
    appState.folders.forEach(f => allFolderDocs.push(...f.documents));
  } else {
    const folderObj = appState.folders.find(f => f.name === appState.activeFolder);
    if (folderObj) allFolderDocs = [...folderObj.documents];
  }

  const totalInView = allFolderDocs.length;
  const convertedInView = allFolderDocs.filter(d => d.is_converted).length;
  const readyInView = allFolderDocs.filter(d => !d.is_converted && d.batch_status !== "JOB_STATE_RUNNING" && d.batch_status !== "JOB_STATE_PENDING").length;
  const batchInView = allFolderDocs.filter(d => d.batch_status === "JOB_STATE_RUNNING" || d.batch_status === "JOB_STATE_PENDING").length;
  const totalPagesInView = allFolderDocs.reduce((acc, d) => acc + (d.total_pages || 0), 0);

  // Update filter pills numbers
  if (countFilterAll) countFilterAll.textContent = totalInView;
  if (countFilterReady) countFilterReady.textContent = readyInView;
  if (countFilterConverted) countFilterConverted.textContent = convertedInView;
  if (countFilterBatch) countFilterBatch.textContent = batchInView;

  const isAll = (appState.activeFolder === "ALL" || !appState.activeFolder);
  const folderName = isAll ? "All Folders" : appState.activeFolder;

  if (activeFolderTitleEl) activeFolderTitleEl.textContent = folderName;
  if (activeFolderSubtitleEl) {
    activeFolderSubtitleEl.innerHTML = `
      <strong>${totalInView}</strong> filings • <strong>${totalPagesInView.toLocaleString()}</strong> pages • <span class="text-success"><strong>${convertedInView}</strong> converted</span>
    `;
  }

  if (convertScopeBtn) {
    if (isAll) {
      convertScopeBtn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
        Convert All (${readyInView > 0 ? readyInView : totalInView})
      `;
    } else {
      convertScopeBtn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
        Convert Entity (${readyInView > 0 ? readyInView : totalInView})
      `;
    }
  }

  if (combineFolderBtn) {
    if (convertedInView >= 1) {
      combineFolderBtn.style.display = "inline-flex";
      if (folderConvertedCount) folderConvertedCount.textContent = convertedInView;
    } else {
      combineFolderBtn.style.display = "none";
    }
  }

  // Get filtered and sorted list
  const docsToRender = getFilteredAndSortedDocs();
  documentsTableBody.innerHTML = "";

  if (docsToRender.length === 0) {
    documentsTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center" style="padding: 60px 20px;">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 12px; opacity: 0.4;">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          </svg>
          <div style="font-size: 15px; font-weight: 600; color: var(--text-main);">No filings found matching your filter</div>
          <p class="text-muted text-sm mt-1">Try clearing your search query or selecting a different status tab.</p>
        </td>
      </tr>
    `;
    updateSelectedUI();
    return;
  }

  // Update Master Checkbox state
  if (masterTableCheckbox) {
    const allVisibleSelected = docsToRender.length > 0 && docsToRender.every(d => appState.selectedFiles.has(d.path));
    masterTableCheckbox.checked = allVisibleSelected;
  }

  docsToRender.forEach(doc => {
    const isSelected = appState.selectedFiles.has(doc.path);
    const tr = document.createElement("tr");
    tr.className = isSelected ? "selected" : "";

    const year = extractYear(doc.name);
    const yearBadge = year > 0
      ? `<span class="year-badge has-year">${year}</span>`
      : `<span class="year-badge">—</span>`;

    let statusBadge = `<span class="status-badge ready"><svg class="status-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"></circle></svg>Ready</span>`;
    if (doc.is_converted) {
      statusBadge = `<span class="status-badge converted"><svg class="status-glyph" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>Converted</span>`;
    } else if (doc.batch_status === "JOB_STATE_RUNNING") {
      statusBadge = `<span class="status-badge batch-running"><span class="spinner" style="width: 10px; height: 10px; border-width: 1.5px;"></span>In Batch</span>`;
    } else if (doc.batch_status === "JOB_STATE_PENDING") {
      statusBadge = `<span class="status-badge batch-pending">Queued</span>`;
    }

    const sizeKb = (doc.file_size / 1024).toFixed(0);

    let actionBtn = "";
    if (doc.is_converted) {
      actionBtn = `<button class="btn btn-sm btn-secondary view-btn" style="color: #34d399; border-color: rgba(16, 185, 129, 0.4);">View .md</button>`;
    } else if (doc.batch_status === "JOB_STATE_RUNNING" || doc.batch_status === "JOB_STATE_PENDING") {
      actionBtn = `<button class="btn btn-sm btn-outline-night track-batch-btn">Track Batch</button>`;
    } else {
      actionBtn = `<button class="btn btn-sm btn-primary convert-single-btn">Convert</button>`;
    }

    tr.innerHTML = `
      <td style="text-align: center;">
        <input type="checkbox" class="doc-checkbox doc-chk" ${isSelected ? "checked" : ""}>
      </td>
      <td class="doc-name-col">
        <div class="doc-name-cell">
          <svg class="doc-filing-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          <div>
            <div class="doc-name-text" title="${doc.name}">${doc.name}</div>
            <div class="doc-entity-tag">${doc.folder}</div>
          </div>
        </div>
      </td>
      <td>${yearBadge}</td>
      <td class="doc-size-col">
        <strong style="color: var(--text-main);">${doc.total_pages}</strong> pgs <span class="text-muted">• ${sizeKb} KB</span>
      </td>
      <td>${statusBadge}</td>
      <td style="text-align: right;">${actionBtn}</td>
    `;

    const checkbox = tr.querySelector(".doc-checkbox");
    checkbox.addEventListener("change", (e) => {
      if (e.target.checked) {
        appState.selectedFiles.add(doc.path);
        tr.classList.add("selected");
      } else {
        appState.selectedFiles.delete(doc.path);
        tr.classList.remove("selected");
      }
      updateSelectedUI();
    });

    const viewBtn = tr.querySelector(".view-btn");
    if (viewBtn) {
      viewBtn.addEventListener("click", () => eventBus.emit("modal:viewer:open", doc));
    }

    const singleConvertBtn = tr.querySelector(".convert-single-btn");
    if (singleConvertBtn) {
      singleConvertBtn.addEventListener("click", () => startConversion([doc.path]));
    }

    const trackBatchBtn = tr.querySelector(".track-batch-btn");
    if (trackBatchBtn) {
      trackBatchBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        switchStudioView("batches");
      });
    }

    documentsTableBody.appendChild(tr);
  });

  updateSelectedUI();
}

export function updateSelectedUI() {
  const selectedCountEl = document.getElementById("selectedCount");
  const convertSelectedBtn = document.getElementById("convertSelectedBtn");
  const combineSelectedBtn = document.getElementById("combineSelectedBtn");
  const combineSelectedCount = document.getElementById("combineSelectedCount");
  const floatingSelectionBar = document.getElementById("floatingSelectionBar");
  const floatingSelectedCount = document.getElementById("floatingSelectedCount");

  const count = appState.selectedFiles.size;
  if (selectedCountEl) selectedCountEl.textContent = count;
  if (floatingSelectedCount) floatingSelectedCount.textContent = count;
  if (convertSelectedBtn) convertSelectedBtn.disabled = count === 0;

  // Toggle floating selection dock
  if (floatingSelectionBar) {
    floatingSelectionBar.style.display = count > 0 ? "flex" : "none";
  }

  // Check how many converted documents are currently selected
  let convertedSelected = 0;
  appState.folders.forEach(f => {
    f.documents.forEach(d => {
      if (appState.selectedFiles.has(d.path) && d.is_converted) {
        convertedSelected++;
      }
    });
  });

  if (combineSelectedBtn) {
    if (convertedSelected >= 1) {
      combineSelectedBtn.style.display = "inline-flex";
      if (combineSelectedCount) combineSelectedCount.textContent = convertedSelected;
    } else {
      combineSelectedBtn.style.display = "none";
    }
  }
}

function selectAllCurrent() {
  const visibleDocs = getFilteredAndSortedDocs();
  visibleDocs.forEach(d => appState.selectedFiles.add(d.path));
  renderDocuments();
}

function deselectAllCurrent() {
  appState.selectedFiles.clear();
  renderDocuments();
}
