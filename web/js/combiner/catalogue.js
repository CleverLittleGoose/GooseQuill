/**
 * GooseQuill — What There Is To Combine
 *
 * Loading the converted documents, deciding which of them may be consolidated,
 * and filling the two folder pickers.
 */

import { appState } from "../state.js";
import * as dom from "./dom.js";

/** The year a filing covers, taken from the last one in its name. */
function extractYear(name) {
  const matches = name.match(/(?:^|[^\d])(19\d\d|20\d\d)(?:[^\d]|$)/g);
  if (matches && matches.length > 0) {
    const last = matches[matches.length - 1].replace(/[^\d]/g, "");
    return parseInt(last, 10);
  }
  return 9999;
}

/**
 * The documents that may be consolidated.
 *
 * A consolidation of a folder contains every document in that folder, so
 * leaving them in the list means "Select Entity" quietly includes yesterday's
 * consolidation alongside the documents it was made from — everything appears
 * twice, and the file grows every time it is rebuilt. Combining consolidations
 * is occasionally what someone wants, so this is a default rather than a rule.
 *
 * Lightweight copies are held out on the same terms and for the same reason:
 * a deflated filing is its transcript with less in it, so a list carrying both
 * offers the same document twice. Deflate switches this on when it hands a set
 * over, which is the case where the lightweight copies are the point.
 */
export function combinableFiles() {
  const all = appState.combiner.availableFiles || [];
  return all.filter(
    (f) =>
      (appState.combiner.includeConsolidated || !f.isConsolidated) &&
      (appState.combiner.includeLightweight || !f.isLightweight)
  );
}

/** How many documents the source picker is currently offering. */
export function updateCombinerSourceSummary() {
  const el = document.getElementById("studioCombinerSourceSummary");
  if (el) el.textContent = `${combinableFiles().length} converted`;
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
        isConsolidated: Boolean(f.is_consolidated),
        isLightweight: Boolean(f.is_lightweight)
      };
    });

    updateCombinerSourceSummary();

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

  } catch (e) {
    if (fileList) {
      fileList.innerHTML = `<div class="text-danger text-center" style="padding: 20px;">Failed to scan markdowns: ${e.message}</div>`;
    }
  }
}
