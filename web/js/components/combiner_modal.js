/**
 * GooseQuill - Markdown Consolidator & Combiner Studio Component
 * General Purpose Document Processing
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { markdownRenderer } from "../services/markdown_renderer.js";
import { startConversion } from "./header.js";
import { switchStudioView } from "./header.js";

function extractYear(name) {
  const matches = name.match(/(?:^|[^\d])(19\d\d|20\d\d)(?:[^\d]|$)/g);
  if (matches && matches.length > 0) {
    const last = matches[matches.length - 1].replace(/[^\d]/g, "");
    return parseInt(last, 10);
  }
  return 9999;
}

export function initCombinerModal() {
  const sourceFolderSelect = document.getElementById("studioCombinerSourceFolderSelect");
  const searchInput = document.getElementById("studioCombinerSearchInput");
  const selectFolderBtn = document.getElementById("studioCombinerSelectFolderBtn");
  const selectAllBtn = document.getElementById("studioCombinerSelectAllBtn");
  const deselectBtn = document.getElementById("studioCombinerDeselectBtn");
  const sortChronoAscBtn = document.getElementById("studioCombinerSortChronoAscBtn");
  const sortChronoDescBtn = document.getElementById("studioCombinerSortChronoDescBtn");
  const sortAlphaBtn = document.getElementById("studioCombinerSortAlphaBtn");
  const masterTitleInput = document.getElementById("studioCombinerMasterTitleInput");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const includeToc = document.getElementById("studioCombinerIncludeToc");
  const includeSourceMeta = document.getElementById("studioCombinerIncludeSourceMeta");
  const stripHeaders = document.getElementById("studioCombinerStripHeaders");
  const previewTabs = document.querySelectorAll("#studioCombinerPreviewTabs .tab-btn");
  const tabRendered = document.getElementById("studioCombinerTabRendered");
  const tabRaw = document.getElementById("studioCombinerTabRaw");
  const copyBtn = document.getElementById("studioCombinerCopyBtn");
  const downloadBtn = document.getElementById("studioCombinerDownloadBtn");
  const saveBtn = document.getElementById("studioCombinerSaveBtn");

  if (sourceFolderSelect) {
    sourceFolderSelect.addEventListener("change", () => {
      appState.combiner.sourceFolder = sourceFolderSelect.value;
      applyCombinerSourceFolderFilter();
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderCombinerFileList();
    });
  }

  if (selectFolderBtn) selectFolderBtn.addEventListener("click", () => selectCombinerFolderDocs());
  if (selectAllBtn) selectAllBtn.addEventListener("click", () => selectCombinerAllDocs());
  if (deselectBtn) deselectBtn.addEventListener("click", () => clearCombinerSelection());

  if (sortChronoAscBtn) sortChronoAscBtn.addEventListener("click", () => sortCombinerItems("chronological_asc"));
  if (sortChronoDescBtn) sortChronoDescBtn.addEventListener("click", () => sortCombinerItems("chronological_desc"));
  if (sortAlphaBtn) sortAlphaBtn.addEventListener("click", () => sortCombinerItems("alpha_asc"));

  if (masterTitleInput) masterTitleInput.addEventListener("input", triggerCombinerPreviewDebounced);
  if (outputFilenameInput) outputFilenameInput.addEventListener("input", updateCombinerDestinationText);

  if (targetFolderSelect) {
    targetFolderSelect.addEventListener("change", () => {
      updateCombinerDestinationText();
      autoSuggestCombinerTitleAndFilename();
      triggerCombinerPreviewDebounced();
    });
  }

  if (includeToc) includeToc.addEventListener("change", triggerCombinerPreviewDebounced);
  if (includeSourceMeta) includeSourceMeta.addEventListener("change", triggerCombinerPreviewDebounced);
  if (stripHeaders) stripHeaders.addEventListener("change", triggerCombinerPreviewDebounced);

  previewTabs.forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = btn.dataset.tab;
      if (!target) return;
      previewTabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (target === "rendered") {
        if (tabRendered) tabRendered.classList.add("active");
        if (tabRaw) tabRaw.classList.remove("active");
      } else {
        if (tabRaw) tabRaw.classList.add("active");
        if (tabRendered) tabRendered.classList.remove("active");
      }
    });
  });

  if (copyBtn) copyBtn.addEventListener("click", copyCombinedMarkdown);
  if (downloadBtn) downloadBtn.addEventListener("click", downloadCombinedMarkdown);
  if (saveBtn) saveBtn.addEventListener("click", saveCombinedMarkdown);

  eventBus.on("studio:combiner:activated", () => openCombinerStudio());
  eventBus.on("modal:combiner:open", (paths) => openCombinerStudio(paths));
}

export async function refreshCombinerAvailableFiles() {
  const fileList = document.getElementById("studioCombinerFileList");
  const sourceFolderSelect = document.getElementById("studioCombinerSourceFolderSelect");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const sourceSummary = document.getElementById("studioCombinerSourceSummary");

  try {
    const res = await fetch("/api/converted_markdowns");
    const data = await res.json();
    const files = data.files || [];

    const pageMap = {};
    appState.folders.forEach(f => {
      f.documents.forEach(d => {
        if (d.output_path) pageMap[d.output_path] = d.total_pages;
        pageMap[d.path] = d.total_pages;
      });
    });

    appState.combiner.availableFiles = files.map(f => {
      const year = extractYear(f.name);
      const pages = pageMap[f.path] || Math.max(1, Math.round(f.size / 2800));
      return {
        name: f.name,
        stem: f.stem,
        path: f.path,
        folder: f.folder,
        size: f.size,
        pages: pages,
        year: year
      };
    });

    if (sourceSummary) {
      sourceSummary.textContent = `${files.length} converted`;
    }

    // Discover all unique folder names
    const folderSet = new Set();
    appState.folders.forEach(f => {
      if (f.name && f.name !== "General / Root" && f.name !== "ALL") {
        folderSet.add(f.name);
      }
    });
    appState.combiner.availableFiles.forEach(f => {
      if (f.folder && f.folder !== "General / Root" && f.folder !== "ALL") {
        folderSet.add(f.folder);
      }
    });
    const allFolderNames = Array.from(folderSet).sort();

    // Populate Source Folder Dropdown
    if (sourceFolderSelect) {
      const currentSelected = sourceFolderSelect.value || appState.combiner.sourceFolder || "ALL";
      sourceFolderSelect.innerHTML = "";

      const allOpt = document.createElement("option");
      allOpt.value = "ALL";
      allOpt.textContent = `All Folders (${files.length} converted)`;
      sourceFolderSelect.appendChild(allOpt);

      allFolderNames.forEach(folderName => {
        const folderConvertedCount = appState.combiner.availableFiles.filter(item => item.folder === folderName).length;
        const opt = document.createElement("option");
        opt.value = folderName;
        opt.textContent = `${folderName} (${folderConvertedCount} converted)`;
        sourceFolderSelect.appendChild(opt);
      });

      if (currentSelected && (currentSelected === "ALL" || folderSet.has(currentSelected))) {
        sourceFolderSelect.value = currentSelected;
      }
      appState.combiner.sourceFolder = sourceFolderSelect.value;
    }

    // Populate Target Folder Dropdown
    if (targetFolderSelect) {
      const currentTarget = targetFolderSelect.value || "General / Root";
      targetFolderSelect.innerHTML = "";
      const allOpt = document.createElement("option");
      allOpt.value = "General / Root";
      allOpt.textContent = "General / Root";
      targetFolderSelect.appendChild(allOpt);

      allFolderNames.forEach(folderName => {
        const opt = document.createElement("option");
        opt.value = folderName;
        opt.textContent = folderName;
        targetFolderSelect.appendChild(opt);
      });

      if (appState.activeFolder && appState.activeFolder !== "ALL" && appState.activeFolder !== "General / Root") {
        targetFolderSelect.value = appState.activeFolder;
      } else if (currentTarget) {
        targetFolderSelect.value = currentTarget;
      }
    }

    renderCombinerFileList();
    autoSuggestCombinerTitleAndFilename();
  } catch (e) {
    if (fileList) {
      fileList.innerHTML = `<div class="text-danger text-center" style="padding: 20px;">Failed to scan markdowns: ${e.message}</div>`;
    }
  }
}

export async function openCombinerStudio(preselectedPaths = null) {
  const sourceFolderSelect = document.getElementById("studioCombinerSourceFolderSelect");
  const folderNotice = document.getElementById("studioCombinerFolderNotice");

  await refreshCombinerAvailableFiles();

  if (preselectedPaths && preselectedPaths.length > 0) {
    const matched = [];
    preselectedPaths.forEach(p => {
      const found = appState.combiner.availableFiles.find(f => f.path === p || f.name === p || p.endsWith(f.name) || (f.path && f.path.includes(p)));
      if (found && !matched.some(m => m.path === found.path)) {
        matched.push(found);
      }
    });
    if (matched.length > 0) {
      appState.combiner.selectedItems = matched;
      appState.combiner.sourceFolder = "ALL";
      if (sourceFolderSelect) sourceFolderSelect.value = "ALL";
      if (folderNotice) folderNotice.style.display = "none";
    } else {
      setupInitialCombinerSelection();
    }
  } else if (appState.selectedFiles.size > 0) {
    const matched = [];
    appState.selectedFiles.forEach(pdfPath => {
      const found = appState.combiner.availableFiles.find(f => f.path === pdfPath || pdfPath.includes(f.stem));
      if (found && !matched.some(m => m.path === found.path)) {
        matched.push(found);
      }
    });
    if (matched.length > 0) {
      appState.combiner.selectedItems = matched;
      appState.combiner.sourceFolder = "ALL";
      if (sourceFolderSelect) sourceFolderSelect.value = "ALL";
      if (folderNotice) folderNotice.style.display = "none";
    } else {
      setupInitialCombinerSelection();
    }
  } else {
    setupInitialCombinerSelection();
  }

  sortCombinerItems("chronological_asc", false);
  renderCombinerFileList();
  autoSuggestCombinerTitleAndFilename();
  triggerCombinerPreviewDebounced();
}

function setupInitialCombinerSelection() {
  const sourceFolderSelect = document.getElementById("studioCombinerSourceFolderSelect");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const folderNotice = document.getElementById("studioCombinerFolderNotice");
  const currentFolder = appState.activeFolder;

  appState.combiner.selectedItems = [];

  if (currentFolder && currentFolder !== "ALL") {
    appState.combiner.sourceFolder = currentFolder;
    if (sourceFolderSelect) sourceFolderSelect.value = currentFolder;
    if (targetFolderSelect) targetFolderSelect.value = currentFolder;
    if (folderNotice) folderNotice.style.display = "none";
  } else {
    appState.combiner.sourceFolder = "ALL";
    if (sourceFolderSelect) sourceFolderSelect.value = "ALL";
    if (folderNotice) folderNotice.style.display = "none";
  }
  updateCombinerDestinationText();
}

function applyCombinerSourceFolderFilter() {
  const sourceFolder = appState.combiner.sourceFolder || "ALL";
  const folderNotice = document.getElementById("studioCombinerFolderNotice");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");

  if (folderNotice) folderNotice.style.display = "none";

  // Auto-sync Save Destination dropdown to match the selected source folder!
  if (sourceFolder !== "ALL" && targetFolderSelect) {
    targetFolderSelect.value = sourceFolder;
  }

  if (sourceFolder !== "ALL") {
    appState.combiner.selectedItems = appState.combiner.selectedItems.filter(s => s.folder === sourceFolder);
  }

  renderCombinerFileList();
  autoSuggestCombinerTitleAndFilename();
  updateCombinerDestinationText();
  triggerCombinerPreviewDebounced();
}

function selectCombinerFolderDocs() {
  const sourceFolder = appState.combiner.sourceFolder || "ALL";
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");

  if (sourceFolder === "ALL") {
    selectCombinerAllDocs();
    return;
  }

  if (targetFolderSelect) targetFolderSelect.value = sourceFolder;
  appState.combiner.selectedItems = appState.combiner.availableFiles.filter(f => f.folder === sourceFolder);
  sortCombinerItems("chronological_asc", false);
  renderCombinerFileList();
  autoSuggestCombinerTitleAndFilename();
  updateCombinerDestinationText();
  triggerCombinerPreviewDebounced();
}

function selectCombinerAllDocs() {
  const sourceFolder = appState.combiner.sourceFolder || "ALL";
  if (sourceFolder === "ALL") {
    appState.combiner.selectedItems = [...appState.combiner.availableFiles];
  } else {
    appState.combiner.selectedItems = appState.combiner.availableFiles.filter(f => f.folder === sourceFolder);
  }
  sortCombinerItems("chronological_asc", false);
  renderCombinerFileList();
  autoSuggestCombinerTitleAndFilename();
  updateCombinerDestinationText();
  triggerCombinerPreviewDebounced();
}

function clearCombinerSelection() {
  appState.combiner.selectedItems = [];
  renderCombinerFileList();
  autoSuggestCombinerTitleAndFilename();
  updateCombinerDestinationText();
  triggerCombinerPreviewDebounced();
}

function autoSuggestCombinerTitleAndFilename() {
  const masterTitleInput = document.getElementById("studioCombinerMasterTitleInput");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const selected = appState.combiner.selectedItems;

  if (selected.length === 0) {
    if (masterTitleInput) masterTitleInput.value = "";
    if (outputFilenameInput) outputFilenameInput.value = "Consolidated_Document.md";
    updateCombinerDestinationText();
    return;
  }

  const folders = Array.from(new Set(selected.map(s => s.folder).filter(Boolean)));
  const years = selected.map(s => s.year).filter(y => y && y !== 9999);
  let yearRange = "";
  if (years.length > 0) {
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    yearRange = minYear === maxYear ? ` ${minYear}` : ` (${minYear}–${maxYear})`;
  }

  let folderLabel = "Documents";
  if (folders.length === 1 && folders[0] && folders[0] !== "Accounts" && folders[0] !== "documents" && folders[0] !== "General / Root") {
    folderLabel = folders[0];
    if (targetFolderSelect) targetFolderSelect.value = folders[0];
  } else if (folders.length > 1) {
    folderLabel = `${folders.length} Folders`;
  }

  const title = `Consolidated Document — ${folderLabel}${yearRange}`;
  const cleanFolderName = folderLabel.replace(/[^\w\s-]/g, "").replace(/\s+/g, "_");
  const cleanYear = yearRange.replace(/[^\w-]/g, "_").replace(/^_+|_+$/g, "");
  const yearSuffix = cleanYear ? `_${cleanYear}` : "";
  const filename = `${cleanFolderName}_Consolidated${yearSuffix}.md`.replace(/__+/g, "_");

  if (masterTitleInput) masterTitleInput.value = title;
  if (outputFilenameInput) outputFilenameInput.value = filename;
  updateCombinerDestinationText();
}

function updateCombinerDestinationText() {
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const saveDestinationText = document.getElementById("studioCombinerSaveDestinationText");

  const folder = (targetFolderSelect && targetFolderSelect.value) || "General / Root";
  let filename = (outputFilenameInput && outputFilenameInput.value.trim()) || "Consolidated_Document.md";
  if (!filename.toLowerCase().endsWith(".md")) filename += ".md";

  const destPath = `/${folder !== "General / Root" ? folder + "/Markdown/" : ""}${filename}`;
  if (saveDestinationText) saveDestinationText.textContent = `Destination: ${destPath}`;
}

export function renderCombinerFileList() {
  const fileList = document.getElementById("studioCombinerFileList");
  const searchInput = document.getElementById("studioCombinerSearchInput");
  const selectedBadge = document.getElementById("studioCombinerSelectedCountBadge");
  const sourceFolder = appState.combiner.sourceFolder || "ALL";

  if (selectedBadge) {
    const count = appState.combiner.selectedItems.length;
    selectedBadge.textContent = `${count} Selected`;
    selectedBadge.style.color = count > 0 ? "#60a5fa" : "var(--text-muted)";
  }

  if (!fileList) return;
  fileList.innerHTML = "";

  const query = (searchInput && searchInput.value.trim().toLowerCase()) || "";

  let filteredAvailableFiles = (sourceFolder === "ALL")
    ? appState.combiner.availableFiles
    : appState.combiner.availableFiles.filter(f => f.folder === sourceFolder);

  if (query) {
    filteredAvailableFiles = filteredAvailableFiles.filter(f => 
      f.name.toLowerCase().includes(query) ||
      f.stem.toLowerCase().includes(query) ||
      (f.folder && f.folder.toLowerCase().includes(query))
    );
  }

  const selectedPaths = new Set(appState.combiner.selectedItems.map(s => s.path));
  const unselectedItems = filteredAvailableFiles.filter(f => !selectedPaths.has(f.path));
  const selectedInFilter = appState.combiner.selectedItems.filter(s => 
    (sourceFolder === "ALL" || s.folder === sourceFolder) &&
    (!query || s.name.toLowerCase().includes(query) || s.stem.toLowerCase().includes(query) || (s.folder && s.folder.toLowerCase().includes(query)))
  );

  const fullDisplayList = [
    ...selectedInFilter.map((item, idx) => ({ ...item, isSelected: true, selectedIndex: idx })),
    ...unselectedItems.map(item => ({ ...item, isSelected: false, selectedIndex: -1 }))
  ];

  if (filteredAvailableFiles.length === 0) {
    const folderObj = appState.folders.find(f => f.name === sourceFolder);
    const pdfCount = folderObj ? folderObj.documents.length : 0;

    fileList.innerHTML = `
      <div style="padding: 36px 18px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px;">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity: 0.4;">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        </svg>
        <div style="font-weight: 600; font-size: 15px; color: var(--text-main);">${query ? 'No matching documents found' : `No markdowns in "${sourceFolder}"`}</div>
        <p class="text-sm text-muted">${pdfCount > 0 ? `Contains ${pdfCount} PDFs that need OCR conversion.` : (query ? 'Try a different search term.' : 'No converted documents in this folder.')}</p>
        <div style="display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 10px;">
          ${pdfCount > 0 && !query ? `<button class="btn btn-sm btn-primary btn-convert-folder-now">🚀 Convert Folder (${pdfCount})</button>` : ''}
          <button class="btn btn-sm btn-secondary btn-switch-all-now">📁 View All Converted (${appState.combiner.availableFiles.length})</button>
        </div>
      </div>
    `;

    const convertNowBtn = fileList.querySelector(".btn-convert-folder-now");
    if (convertNowBtn && folderObj) {
      convertNowBtn.addEventListener("click", () => {
        appState.activeFolder = sourceFolder;
        switchStudioView("workspace");
        eventBus.emit("folders:updated");
        eventBus.emit("documents:render");
        const pdfPaths = folderObj.documents.map(d => d.path);
        startConversion(pdfPaths);
      });
    }

    const switchAllBtn = fileList.querySelector(".btn-switch-all-now");
    if (switchAllBtn) {
      switchAllBtn.addEventListener("click", () => {
        const sourceFolderSelect = document.getElementById("studioCombinerSourceFolderSelect");
        if (sourceFolderSelect) sourceFolderSelect.value = "ALL";
        appState.combiner.sourceFolder = "ALL";
        applyCombinerSourceFolderFilter();
      });
    }

    return;
  }

  fullDisplayList.forEach((doc) => {
    const itemEl = document.createElement("div");
    itemEl.className = `combiner-file-item ${doc.isSelected ? "selected" : ""}`;

    const yearBadge = (doc.year && doc.year !== 9999)
      ? `<span class="badge" style="font-size: 12px; font-family: var(--font-mono); font-weight: 600; background: rgba(16, 185, 129, 0.18); color: #34d399; padding: 2px 7px; border-radius: 4px;">${doc.year}</span>`
      : "";

    const sizeKb = (doc.size / 1024).toFixed(0);

    let orderButtons = "";
    if (doc.isSelected) {
      const isFirst = doc.selectedIndex === 0;
      const isLast = doc.selectedIndex === appState.combiner.selectedItems.length - 1;
      orderButtons = `
        <div class="combiner-order-actions">
          <button class="btn-order btn-move-up" title="Move Up" ${isFirst ? "disabled style='opacity: 0.25; cursor: not-allowed;'" : ""}>▲</button>
          <button class="btn-order btn-move-down" title="Move Down" ${isLast ? "disabled style='opacity: 0.25; cursor: not-allowed;'" : ""}>▼</button>
        </div>
      `;
    }

    // Smart title: if stem starts with folder name, highlight the distinct document descriptor
    let displayTitle = doc.stem;
    if (doc.folder && doc.folder !== "General / Root" && doc.folder !== "ALL") {
      const cleanFolder = doc.folder.trim();
      if (displayTitle.toLowerCase().startsWith(cleanFolder.toLowerCase())) {
        let remainder = displayTitle.slice(cleanFolder.length).trim();
        remainder = remainder.replace(/^[-–—_:\s]+/, "").trim();
        if (remainder) displayTitle = remainder;
      }
    }

    itemEl.innerHTML = `
      ${orderButtons}
      <input type="checkbox" class="doc-chk" ${doc.isSelected ? "checked" : ""}>
      <div class="combiner-file-info">
        <div class="combiner-file-title" title="${doc.name}">
          ${doc.isSelected ? `<strong style="color: #60a5fa;">${doc.selectedIndex + 1}.</strong> ` : ""}${displayTitle}
        </div>
        <div class="combiner-file-meta">
          ${yearBadge}
          <span>${doc.pages} pgs</span>
          <span>•</span>
          <span>${sizeKb} KB</span>
          ${sourceFolder === "ALL" ? `<span>•</span><span>📁 ${doc.folder}</span>` : ""}
        </div>
      </div>
      ${doc.isSelected ? `<button class="btn-icon btn-remove" title="Exclude file" style="font-size: 18px; padding: 4px 8px; line-height: 1; flex-shrink: 0;">&times;</button>` : ""}
    `;

    const chk = itemEl.querySelector(".doc-chk");
    chk.addEventListener("change", (e) => {
      e.stopPropagation();
      toggleCombinerDoc(doc.path, e.target.checked);
    });

    const removeBtn = itemEl.querySelector(".btn-remove");
    if (removeBtn) {
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleCombinerDoc(doc.path, false);
      });
    }

    const upBtn = itemEl.querySelector(".btn-move-up");
    if (upBtn && doc.selectedIndex > 0) {
      upBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        moveCombinerDoc(doc.selectedIndex, -1);
      });
    }

    const downBtn = itemEl.querySelector(".btn-move-down");
    if (downBtn && doc.selectedIndex < appState.combiner.selectedItems.length - 1) {
      downBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        moveCombinerDoc(doc.selectedIndex, 1);
      });
    }

    fileList.appendChild(itemEl);
  });
}

function toggleCombinerDoc(docPath, isChecked) {
  if (isChecked) {
    const item = appState.combiner.availableFiles.find(f => f.path === docPath);
    if (item && !appState.combiner.selectedItems.some(s => s.path === docPath)) {
      appState.combiner.selectedItems.push(item);
    }
  } else {
    appState.combiner.selectedItems = appState.combiner.selectedItems.filter(s => s.path !== docPath);
  }
  renderCombinerFileList();
  autoSuggestCombinerTitleAndFilename();
  triggerCombinerPreviewDebounced();
}

function moveCombinerDoc(index, direction) {
  const items = appState.combiner.selectedItems;
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= items.length) return;

  const temp = items[index];
  items[index] = items[newIndex];
  items[newIndex] = temp;

  renderCombinerFileList();
  triggerCombinerPreviewDebounced();
}

function sortCombinerItems(mode, triggerPreview = true) {
  appState.combiner.sortMode = mode;
  const items = appState.combiner.selectedItems;

  if (mode === "chronological_asc") {
    items.sort((a, b) => (a.year - b.year) || a.stem.localeCompare(b.stem));
  } else if (mode === "chronological_desc") {
    items.sort((a, b) => (b.year - a.year) || a.stem.localeCompare(b.stem));
  } else if (mode === "alpha_asc") {
    items.sort((a, b) => a.stem.localeCompare(b.stem));
  }

  renderCombinerFileList();
  if (triggerPreview) {
    triggerCombinerPreviewDebounced();
  }
}

function triggerCombinerPreviewDebounced() {
  if (appState.combiner.previewTimer) {
    clearTimeout(appState.combiner.previewTimer);
  }
  appState.combiner.previewTimer = setTimeout(() => {
    generateCombinerPreview();
  }, 250);
}

export async function generateCombinerPreview() {
  const renderedContent = document.getElementById("studioCombinerRenderedContent");
  const rawTextarea = document.getElementById("studioCombinerRawMarkdownTextarea");
  const statDocs = document.getElementById("studioCombinerStatDocs");
  const statPages = document.getElementById("studioCombinerStatPages");
  const statWords = document.getElementById("studioCombinerStatWords");
  const statChars = document.getElementById("studioCombinerStatChars");

  const masterTitleInput = document.getElementById("studioCombinerMasterTitleInput");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const includeToc = document.getElementById("studioCombinerIncludeToc");
  const includeSourceMeta = document.getElementById("studioCombinerIncludeSourceMeta");
  const stripHeaders = document.getElementById("studioCombinerStripHeaders");

  const selected = appState.combiner.selectedItems;
  if (selected.length === 0) {
    if (renderedContent) {
      renderedContent.innerHTML = `
        <div style="padding: 60px 20px; text-align: center;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 14px; opacity: 0.35;">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          <h3 style="font-size: 18px; font-weight: 600; color: var(--text-main);">Ready to Consolidate Documents</h3>
          <p class="text-muted" style="margin-top: 6px; font-size: 14.5px; max-width: 440px; margin-left: auto; margin-right: auto;">
            Select documents on the left to sequence them, or click "Select Entity" to consolidate an entire folder.
          </p>
        </div>
      `;
    }
    if (rawTextarea) rawTextarea.value = "";
    if (statDocs) statDocs.textContent = "0";
    if (statPages) statPages.textContent = "0";
    if (statWords) statWords.textContent = "0";
    if (statChars) statChars.textContent = "0";
    return;
  }

  if (renderedContent) {
    renderedContent.innerHTML = `<div class="text-muted text-center" style="padding: 60px; font-size: 15px;"><span class="spinner" style="width: 16px; height: 16px; display: inline-block; vertical-align: middle; margin-right: 8px;"></span>Generating live consolidated markdown preview...</div>`;
  }

  try {
    const res = await fetch("/api/combine_markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: selected.map(s => s.path),
        master_title: (masterTitleInput && masterTitleInput.value.trim()) || undefined,
        output_filename: (outputFilenameInput && outputFilenameInput.value.trim()) || undefined,
        target_folder: (targetFolderSelect && targetFolderSelect.value) || undefined,
        include_toc: includeToc ? includeToc.checked : true,
        include_source_meta: includeSourceMeta ? includeSourceMeta.checked : true,
        strip_original_headers: stripHeaders ? stripHeaders.checked : true,
        sort_mode: "custom",
        save_to_disk: false
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Consolidation preview failed");

    appState.combiner.cachedResult = data;

    if (renderedContent) renderedContent.innerHTML = markdownRenderer.render(data.content);
    if (rawTextarea) rawTextarea.value = data.content;

    if (statDocs) statDocs.textContent = data.total_documents;
    if (statPages) statPages.textContent = data.total_pages;
    if (statWords) statWords.textContent = data.total_words.toLocaleString();
    if (statChars) statChars.textContent = data.total_chars.toLocaleString();

  } catch (e) {
    if (renderedContent) {
      renderedContent.innerHTML = `<div class="text-danger text-center" style="padding: 40px; font-size: 15px;">Error generating preview: ${e.message}</div>`;
    }
  }
}

async function saveCombinedMarkdown() {
  const saveBtn = document.getElementById("studioCombinerSaveBtn");
  const masterTitleInput = document.getElementById("studioCombinerMasterTitleInput");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const targetFolderSelect = document.getElementById("studioCombinerTargetFolderSelect");
  const includeToc = document.getElementById("studioCombinerIncludeToc");
  const includeSourceMeta = document.getElementById("studioCombinerIncludeSourceMeta");
  const stripHeaders = document.getElementById("studioCombinerStripHeaders");

  const selected = appState.combiner.selectedItems;
  if (selected.length === 0) {
    showToast("Selection Empty", "Please select at least one converted document to combine.", true);
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
  }

  try {
    const res = await fetch("/api/combine_markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: selected.map(s => s.path),
        master_title: (masterTitleInput && masterTitleInput.value.trim()) || undefined,
        output_filename: (outputFilenameInput && outputFilenameInput.value.trim()) || undefined,
        target_folder: (targetFolderSelect && targetFolderSelect.value) || undefined,
        include_toc: includeToc ? includeToc.checked : true,
        include_source_meta: includeSourceMeta ? includeSourceMeta.checked : true,
        strip_original_headers: stripHeaders ? stripHeaders.checked : true,
        sort_mode: "custom",
        save_to_disk: true
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Could not save consolidated file");

    showToast("Consolidated File Saved! 🎉", `Saved to ${data.saved_path}`);
    appState.recentLogs.push({
      text: `[INFO] Consolidated ${data.total_documents} markdown documents (${data.total_pages} pages) into ${data.saved_path}`,
      type: "normal"
    });
    eventBus.emit("logs:updated");
    eventBus.emit("documents:reload");

    if (saveBtn) {
      saveBtn.textContent = "Saved!";
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
          Save to Workspace
        `;
      }, 2500);
    }
  } catch (e) {
    showToast("Save Error", e.message, true);
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save to Workspace";
    }
  }
}

function copyCombinedMarkdown() {
  const rawTextarea = document.getElementById("studioCombinerRawMarkdownTextarea");
  const copyBtn = document.getElementById("studioCombinerCopyBtn");
  const content = rawTextarea ? rawTextarea.value : "";
  if (!content) {
    showToast("Empty Document", "No consolidated content to copy.", true);
    return;
  }
  navigator.clipboard.writeText(content);
  if (copyBtn) {
    copyBtn.textContent = "Copied!";
    setTimeout(() => {
      copyBtn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        Copy Markdown
      `;
    }, 2000);
  }
}

function downloadCombinedMarkdown() {
  const rawTextarea = document.getElementById("studioCombinerRawMarkdownTextarea");
  const outputFilenameInput = document.getElementById("studioCombinerOutputFilenameInput");
  const content = rawTextarea ? rawTextarea.value : "";
  if (!content) {
    showToast("Empty Document", "No consolidated content to download.", true);
    return;
  }

  let filename = (outputFilenameInput && outputFilenameInput.value.trim()) || "Consolidated_Document.md";
  if (!filename.toLowerCase().endsWith(".md")) filename += ".md";

  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Download Started 📥", `Downloading ${filename}`);
}
