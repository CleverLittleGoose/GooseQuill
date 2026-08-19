/**
 * GooseQuill — The Document Sequence List
 *
 * The left-hand list: what is available, what is selected, and in what order it
 * will be combined.
 *
 * What a checkbox or a reorder arrow *does* is passed in rather than imported.
 * The list needs the selection actions and the selection needs the list
 * redrawn, and taking handlers is what keeps that from being a cycle.
 */

import { appState, eventBus } from "../state.js";
import * as dom from "./dom.js";
import { combinableFiles } from "./catalogue.js";
import { startConversion, switchStudioView } from "../components/header.js";

export function renderCombinerFileList({ onToggle, onMove } = {}) {
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
      onToggle(doc.path, e.target.checked);
    });

    const removeBtn = itemEl.querySelector(".btn-remove");
    if (removeBtn) {
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onToggle(doc.path, false);
      });
    }

    const upBtn = itemEl.querySelector(".btn-move-up");
    if (upBtn && doc.selectedIndex > 0) {
      upBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onMove(doc.selectedIndex, -1);
      });
    }

    const downBtn = itemEl.querySelector(".btn-move-down");
    if (downBtn && doc.selectedIndex < appState.combiner.selectedItems.length - 1) {
      downBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onMove(doc.selectedIndex, 1);
      });
    }

    fileList.appendChild(itemEl);
  });
}
