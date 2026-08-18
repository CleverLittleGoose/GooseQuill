/**
 * GooseQuill - New Folder Creation Modal Component
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";

export function initNewFolderModal() {
  const newFolderModal = document.getElementById("newFolderModal");
  const closeNewFolderBtn = document.getElementById("closeNewFolderBtn");
  const cancelNewFolderBtn = document.getElementById("cancelNewFolderBtn");
  const saveNewFolderBtn = document.getElementById("confirmCreateFolderBtn") || document.getElementById("saveNewFolderBtn");
  const newFolderNameInput = document.getElementById("newFolderNameInput");


  if (closeNewFolderBtn) {
    closeNewFolderBtn.addEventListener("click", () => {
      if (newFolderModal) newFolderModal.style.display = "none";
    });
  }

  if (cancelNewFolderBtn) {
    cancelNewFolderBtn.addEventListener("click", () => {
      if (newFolderModal) newFolderModal.style.display = "none";
    });
  }

  if (saveNewFolderBtn) {
    saveNewFolderBtn.addEventListener("click", async () => {
      const name = newFolderNameInput ? newFolderNameInput.value.trim() : "";
      if (!name) {
        showToast("Invalid Name", "Please enter a folder name.", true);
        return;
      }
      try {
        const res = await fetch("/api/create_folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder_name: name })
        });
        if (res.ok) {
          showToast("Folder Created", `Created folder ${name}`);
          if (newFolderNameInput) newFolderNameInput.value = "";
          if (newFolderModal) newFolderModal.style.display = "none";
          appState.activeFolder = name;
          eventBus.emit("documents:reload");
        } else {
          const data = await res.json();
          showToast("Error", data.detail || "Failed to create folder", true);
        }
      } catch (e) {
        showToast("Error", e.message, true);
      }
    });
  }

  eventBus.on("modal:new_folder:open", () => {
    if (newFolderNameInput) newFolderNameInput.value = "";
    if (newFolderModal) newFolderModal.style.display = "flex";
  });
}
