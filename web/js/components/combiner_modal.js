/**
 * GooseQuill - Markdown Consolidator & Combiner Studio Component
 * General Purpose Document Processing
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { markdownRenderer } from "../services/markdown_renderer.js";
import { TranscriptView } from "../services/transcript_view.js";
import { splitSequential } from "../services/page_splitter.js";
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

  const includeConsolidated = document.getElementById("studioCombinerIncludeConsolidated");
  if (includeConsolidated) {
    includeConsolidated.addEventListener("change", () => {
      appState.combiner.includeConsolidated = includeConsolidated.checked;
      // Anything already picked that is no longer offered must go with it,
      // or the selection would silently keep a file the list denies exists.
      if (!includeConsolidated.checked) {
        appState.combiner.selectedItems = appState.combiner.selectedItems.filter((f) => !f.isConsolidated);
      }
      renderCombinerFileList();
      updateCombinerSourceSummary();
      triggerCombinerPreviewDebounced();
    });
  }

  eventBus.on("studio:combiner:activated", () => openCombinerStudio());
  eventBus.on("modal:combiner:open", (paths) => openCombinerStudio(paths));
}

/**
 * The documents that may be consolidated.
 *
 * A consolidation of a folder contains every document in that folder, so
 * leaving them in the list means "Select Entity" quietly includes yesterday's
 * consolidation alongside the documents it was made from — everything appears
 * twice, and the file grows every time it is rebuilt. Combining consolidations
 * is occasionally what someone wants, so this is a default rather than a rule.
 */
function updateCombinerSourceSummary() {
  const el = document.getElementById("studioCombinerSourceSummary");
  if (el) el.textContent = `${combinableFiles().length} converted`;
}

function combinableFiles() {
  const all = appState.combiner.availableFiles || [];
  return appState.combiner.includeConsolidated ? all : all.filter((f) => !f.isConsolidated);
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
        year: year,
        isConsolidated: Boolean(f.is_consolidated)
      };
    });

    if (sourceSummary) {
      sourceSummary.textContent = `${combinableFiles().length} converted`;
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
  appState.combiner.selectedItems = combinableFiles().filter(f => f.folder === sourceFolder);
  sortCombinerItems("chronological_asc", false);
  renderCombinerFileList();
  autoSuggestCombinerTitleAndFilename();
  updateCombinerDestinationText();
  triggerCombinerPreviewDebounced();
}

function selectCombinerAllDocs() {
  const sourceFolder = appState.combiner.sourceFolder || "ALL";
  if (sourceFolder === "ALL") {
    appState.combiner.selectedItems = [...combinableFiles()];
  } else {
    appState.combiner.selectedItems = combinableFiles().filter(f => f.folder === sourceFolder);
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
    ? combinableFiles()
    : combinableFiles().filter(f => f.folder === sourceFolder);

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
          <button class="btn btn-sm btn-secondary btn-switch-all-now">View all converted (${combinableFiles().length})</button>
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
          ${sourceFolder === "ALL" ? `<span>•</span><span class="combiner-item-folder">${doc.folder}</span>` : ""}
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

/**
 * The consolidated preview, drawn a page at a time.
 *
 * This was the last render path still building one `innerHTML` for the whole
 * document. Combining a handful of 200-page filings makes that string tens of
 * megabytes of HTML, and the browser lays all of it out before showing
 * anything — the exact stutter the Studio transcript used to have.
 *
 * `TranscriptView` already solves it, so the preview borrows it rather than
 * growing its own copy. The one thing it cannot borrow is page numbering: a
 * consolidated file restarts at page 1 for every source document, so blocks are
 * keyed by position and labelled with the page they claim to be.
 */
let combinerTranscript = null;

/**
 * How much of a large selection the preview assembles up front.
 *
 * This tool exists because a browser could not do this work: consolidating a
 * whole workspace is 43MB of Markdown, and asking the browser to fetch it,
 * hold it as a string, split it and lay it out is the same mistake in a
 * different place. So the preview shows the opening documents, immediately,
 * whatever is selected — and building the whole thing is a deliberate act.
 *
 * The page limit is a second guard for one document that is enormous on its
 * own: every page reserves its estimated height even unrendered, and browsers
 * cap an element at about 33.5 million pixels. Past that, scroll positions stop
 * mapping to pages and the pane goes blank rather than slow.
 */
const PREVIEW_DOCUMENT_LIMIT = 10;
const PREVIEW_PAGE_LIMIT = 2000;

/** Blank the counts, which only mean anything once something has been built. */
function resetCombinerStats() {
  ["studioCombinerStatDocs", "studioCombinerStatPages", "studioCombinerStatWords", "studioCombinerStatChars"]
    .forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = "0";
    });
  const raw = document.getElementById("studioCombinerRawMarkdownTextarea");
  if (raw) raw.value = "";
}

/**
 * Say what the pane is showing, and offer the way to see the rest.
 *
 * The offer lives here rather than as a separate screen because the extract is
 * genuinely useful on its own — it is how you check the ordering and the
 * headers look right — and interrupting that with a wall was the wrong way
 * round.
 */
/**
 * What a completed full build looks like.
 *
 * The document is on disk and is not coming back through the tab, so there is
 * nothing to render — and nothing to render is the point. What is useful here
 * is where it went, how big it turned out, and a way to get it.
 */
function renderBuiltDocument(data) {
  const notice = document.getElementById("studioCombinerPreviewNotice");
  if (notice) {
    notice.style.display = "none";
    notice.innerHTML = "";
  }

  appState.combiner.previewIsPartial = false;
  updateCombinerOutputButtons({ builtPath: data.saved_path });

  const stats = [
    [ "studioCombinerStatDocs", data.total_documents ],
    [ "studioCombinerStatPages", data.total_pages ],
    [ "studioCombinerStatWords", (data.total_words || 0).toLocaleString() ],
    [ "studioCombinerStatChars", (data.total_chars || 0).toLocaleString() ]
  ];
  stats.forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });

  const megabytes = ((data.total_chars || 0) / 1048576).toFixed(1);

  clearCombinerPreviewBody(`
    <div style="padding: 56px 20px; text-align: center;">
      <h3 style="font-size: 17px; font-weight: 600; color: var(--text-main);">Document built</h3>
      <p class="text-muted" style="margin: 8px auto 4px; font-size: 14px; max-width: 460px;">
        ${(data.total_documents || 0).toLocaleString()} documents,
        ${(data.total_pages || 0).toLocaleString()} pages, about ${megabytes}MB.
      </p>
      <p class="text-muted text-xs" style="margin: 0 auto 18px; max-width: 520px; word-break: break-all;">
        ${escapeForHtml(data.saved_path || "")}
      </p>
      <a class="btn btn-primary" id="studioCombinerBuiltDownload"
         href="/api/download_markdown?path=${encodeURIComponent(data.saved_path || "")}">Download .md</a>
      <p class="text-muted text-xs" style="margin-top: 14px;">
        Too large to preview in the browser — that is why it was assembled on disk.
      </p>
    </div>
  `);
}

function escapeForHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPreviewNotice(notice, { previewedDocuments, totalDocuments, totalPages }) {
  if (!notice) return;

  const partialDocs = totalDocuments > previewedDocuments;
  const partialPages = totalPages > PREVIEW_PAGE_LIMIT;

  if (!partialDocs && !partialPages) {
    notice.style.display = "none";
    notice.innerHTML = "";
    return;
  }

  const parts = [];
  if (partialDocs) {
    parts.push(
      `Showing the first ${previewedDocuments.toLocaleString()} of ${totalDocuments.toLocaleString()} documents`
    );
  }
  if (partialPages) {
    parts.push(`${PREVIEW_PAGE_LIMIT.toLocaleString()} of ${totalPages.toLocaleString()} pages`);
  }

  notice.style.display = "flex";
  notice.innerHTML = `
    <span>${parts.join(", ")}.</span>
    ${partialDocs ? `<button class="btn btn-xs btn-primary" id="studioCombinerBuildFullBtn">Build full document</button>` : ""}
  `;

  document
    .getElementById("studioCombinerBuildFullBtn")
    ?.addEventListener("click", () => generateCombinerPreview({ full: true }));
}

function renderCombinerPreviewBody(markdown, { previewedDocuments = 0, totalDocuments = 0 } = {}) {
  const pane = document.getElementById("studioCombinerTabRendered");
  const content = document.getElementById("studioCombinerRenderedContent");
  const notice = document.getElementById("studioCombinerPreviewNotice");
  if (!pane || !content) return;

  if (!combinerTranscript) {
    combinerTranscript = new TranscriptView(pane, content, {});
  }

  const { pages, labels } = splitSequential(markdown);
  const total = Object.keys(pages).filter((key) => /^\d+$/.test(key)).length;

  let shown = pages;
  if (total > PREVIEW_PAGE_LIMIT) {
    shown = { preamble: pages.preamble };
    for (let page = 1; page <= PREVIEW_PAGE_LIMIT; page++) shown[page] = pages[page];
  }

  renderPreviewNotice(notice, { previewedDocuments, totalDocuments, totalPages: total });

  combinerTranscript.setDocument(shown, { pageLabels: labels });
}

/** Drop the virtualised preview back to a plain message. */
function clearCombinerPreviewBody(html) {
  const content = document.getElementById("studioCombinerRenderedContent");
  const notice = document.getElementById("studioCombinerPreviewNotice");
  if (notice) notice.style.display = "none";
  if (combinerTranscript) {
    combinerTranscript.destroy();
    combinerTranscript = null;
  }
  if (content) content.innerHTML = html;
}

/**
 * Copy and Download hand over whatever is in the raw pane, so while that is an
 * extract they would quietly give you ten documents instead of four hundred.
 * They are held until the full document exists. Save to Workspace is not: it
 * sends the file list and the server assembles and writes it, which is the
 * whole point of it being the server's job.
 */
function updateCombinerOutputButtons({ builtPath = null } = {}) {
  const partial = Boolean(appState.combiner.previewIsPartial);
  const copyBtn = document.getElementById("studioCombinerCopyBtn");
  const downloadBtn = document.getElementById("studioCombinerDownloadBtn");

  if (copyBtn) {
    // The clipboard route goes through a JavaScript string, so it stays shut
    // for a document that was deliberately never brought into the tab.
    copyBtn.disabled = partial || Boolean(builtPath);
    copyBtn.title = builtPath
      ? "The full document is on disk — download it rather than routing it through the clipboard"
      : partial
        ? "Build the full document first — the preview is only an extract"
        : "";
  }

  if (downloadBtn) {
    downloadBtn.disabled = partial && !builtPath;
    downloadBtn.title = downloadBtn.disabled
      ? "Build the full document first — the preview is only an extract"
      : "";
  }
}

/**
 * @param {{full?: boolean}} options — `full` assembles every selected document
 *   rather than the opening extract, which is what "Build full document" asks
 *   for and what Copy and Download need before they mean anything.
 */
export async function generateCombinerPreview({ full = false } = {}) {
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
    clearCombinerPreviewBody(`
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
    `);
    appState.combiner.previewIsPartial = false;
    updateCombinerOutputButtons();
    resetCombinerStats();
    return;
  }

  // Unless the whole thing was asked for, assemble only the opening documents.
  // The rest stay selected, listed and saved — they are simply not fetched into
  // the tab in order to be glanced at.
  const previewFiles = full ? selected : selected.slice(0, PREVIEW_DOCUMENT_LIMIT);
  const previewIsPartial = previewFiles.length < selected.length;
  appState.combiner.previewIsPartial = previewIsPartial;
  updateCombinerOutputButtons();

  clearCombinerPreviewBody(`
    <div class="text-muted text-center" style="padding: 60px; font-size: 15px;">
      <span class="spinner" style="width: 16px; height: 16px; display: inline-block; vertical-align: middle; margin-right: 8px;"></span>
      ${full ? "Building the full document" : "Preparing a preview"} —
      ${previewFiles.length.toLocaleString()} ${previewFiles.length === 1 ? "document" : "documents"}…
      ${full ? '<div class="text-xs" style="margin-top: 10px;">Assembled and written on the server; this can take a moment for a large workspace.</div>' : ""}
    </div>
  `);

  try {
    const res = await fetch("/api/combine_markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: previewFiles.map(s => s.path),
        master_title: (masterTitleInput && masterTitleInput.value.trim()) || undefined,
        output_filename: (outputFilenameInput && outputFilenameInput.value.trim()) || undefined,
        target_folder: (targetFolderSelect && targetFolderSelect.value) || undefined,
        include_toc: includeToc ? includeToc.checked : true,
        include_source_meta: includeSourceMeta ? includeSourceMeta.checked : true,
        strip_original_headers: stripHeaders ? stripHeaders.checked : true,
        sort_mode: "custom",
        // A full build is written on the server. Anything smaller comes back
        // so the raw pane and the preview have something to show.
        save_to_disk: full,
        return_content: !full
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Consolidation preview failed");

    appState.combiner.cachedResult = data;

    if (full) {
      renderBuiltDocument(data);
      return;
    }

    renderCombinerPreviewBody(data.content, {
      previewedDocuments: previewFiles.length,
      totalDocuments: selected.length
    });
    if (rawTextarea) rawTextarea.value = data.content;

    if (previewIsPartial) {
      // The counts describe what will be saved, not what was assembled to look
      // at. Pages we know from the selection; words and characters we would
      // have to build the whole document to learn, which is the thing being
      // avoided, so they are left blank rather than quietly understated.
      const selectedPages = selected.reduce((total, item) => total + (item.pages || 0), 0);
      if (statDocs) statDocs.textContent = selected.length.toLocaleString();
      if (statPages) statPages.textContent = selectedPages.toLocaleString();
      if (statWords) statWords.textContent = "—";
      if (statChars) statChars.textContent = "—";
    } else {
      if (statDocs) statDocs.textContent = data.total_documents;
      if (statPages) statPages.textContent = data.total_pages;
      if (statWords) statWords.textContent = data.total_words.toLocaleString();
      if (statChars) statChars.textContent = data.total_chars.toLocaleString();
    }

  } catch (e) {
    clearCombinerPreviewBody(`<div class="text-danger text-center" style="padding: 40px; font-size: 15px;">Error generating preview: ${e.message}</div>`);
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
