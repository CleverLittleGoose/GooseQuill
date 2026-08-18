/**
 * GooseQuill - Settings & Configuration Modal Component
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { apiClient } from "../services/api_client.js";
import { testApiConnection } from "./header.js";

export function initSettingsModal() {
  const settingsModal = document.getElementById("settingsModal");
  const openSettingsBtn = document.getElementById("openSettingsBtn") || document.getElementById("openSettingsModalBtn");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  const modelSelect = document.getElementById("modelSelect");
  const concurrencySelect = document.getElementById("concurrencySelect");
  const forceReprocessCheckbox = document.getElementById("forceReprocessCheckbox");
  const presetPills = document.querySelectorAll(".preset-pill");
  const systemPromptTextarea = document.getElementById("systemPromptTextarea");
  const workingDirInput = document.getElementById("workingDirInput");
  const changeWorkingDirBtn = document.getElementById("changeWorkingDirBtn");

  const settingsSyncPricingBtn = document.getElementById("settingsSyncPricingBtn");
  const settingsSyncSpinner = document.getElementById("settingsSyncSpinner");
  const econSyncPricingBtn = document.getElementById("econSyncPricingBtn");
  const econSyncSpinner = document.getElementById("econSyncSpinner");

  function updateModelSpecs(modelKey) {
    const key = modelKey || (modelSelect ? modelSelect.value : appState.model);
    const pricingData = appState.pricing && appState.pricing[key];

    const specModelName = document.getElementById("specModelName");
    const specModelTier = document.getElementById("specModelTier");
    const specModelContext = document.getElementById("specModelContext");
    const specModelDesc = document.getElementById("specModelDesc");
    const specStdInput = document.getElementById("specStdInput");
    const specStdOutput = document.getElementById("specStdOutput");
    const specBatchRate = document.getElementById("specBatchRate");
    const specCacheRate = document.getElementById("specCacheRate");
    const specModelRec = document.getElementById("specModelRec");

    if (pricingData) {
      if (specModelName) specModelName.textContent = pricingData.name || key;
      if (specModelTier) specModelTier.textContent = pricingData.tier || (key.includes("pro") ? "Pro" : (key.includes("3.7") ? "Frontier" : "Economy"));
      if (specModelContext) specModelContext.textContent = `Context: ${pricingData.context_window || "1M tokens"}`;
      if (specModelDesc) specModelDesc.textContent = pricingData.description || "High-performance multimodal model for PDF OCR and document extraction.";
      if (specStdInput) specStdInput.textContent = `$${pricingData.input_standard.toFixed(2)} / 1M`;
      if (specStdOutput) specStdOutput.textContent = `$${pricingData.output_standard.toFixed(2)} / 1M`;
      if (specBatchRate) specBatchRate.textContent = `$${pricingData.input_batch.toFixed(3)} / $${pricingData.output_batch.toFixed(3)} (50% Off)`;
      if (specCacheRate) specCacheRate.textContent = `$${pricingData.context_cache.toFixed(3)} / 1M`;
      if (specModelRec) specModelRec.textContent = pricingData.recommended_for || "Statutory filings, OCR document parsing, and markdown generation.";
    }
  }

  function openSettings() {
    if (modelSelect) {
      modelSelect.value = appState.model;
      updateModelSpecs(appState.model);
    }
    if (concurrencySelect) concurrencySelect.value = appState.concurrency || 5;
    if (forceReprocessCheckbox) forceReprocessCheckbox.checked = appState.forceReprocess;
    if (systemPromptTextarea) systemPromptTextarea.value = appState.systemPrompt;
    if (workingDirInput) workingDirInput.value = appState.rootDirectory;

    presetPills.forEach(p => {
      p.classList.toggle("active", p.dataset.preset === appState.currentPreset);
    });

    if (settingsModal) settingsModal.style.display = "flex";
  }

  if (modelSelect) {
    modelSelect.addEventListener("change", (e) => {
      updateModelSpecs(e.target.value);
    });
  }

  if (openSettingsBtn) {
    openSettingsBtn.addEventListener("click", openSettings);
  }

  eventBus.on("modal:settings:open", openSettings);

  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener("click", () => {
      if (settingsModal) settingsModal.style.display = "none";
    });
  }

  presetPills.forEach(pill => {
    pill.addEventListener("click", () => {
      presetPills.forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      const key = pill.dataset.preset;
      appState.currentPreset = key;
      if (appState.presets && appState.presets[key] && systemPromptTextarea) {
        systemPromptTextarea.value = appState.presets[key].prompt;
      }
    });
  });

  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", async () => {
      const oldModel = appState.model;
      if (modelSelect) appState.model = modelSelect.value;
      if (concurrencySelect) appState.concurrency = parseInt(concurrencySelect.value, 10);
      if (forceReprocessCheckbox) appState.forceReprocess = forceReprocessCheckbox.checked;
      if (systemPromptTextarea) appState.systemPrompt = systemPromptTextarea.value;

      const newPath = workingDirInput ? workingDirInput.value.trim() : "";
      let dirChanged = false;
      if (newPath && newPath !== appState.rootDirectory) {
        try {
          const res = await apiClient.setRootFolder(newPath);
          if (res && res.status === "success") {
            appState.rootDirectory = res.root_directory;
            dirChanged = true;
          }
        } catch (dirErr) {
          showToast("Directory Error", dirErr.message, true);
          return;
        }
      }

      if (settingsModal) settingsModal.style.display = "none";
      showToast("Settings Saved", dirChanged ? `Workspace set to ${appState.rootDirectory}` : `Model set to ${appState.model}.`);

      if (dirChanged || oldModel !== appState.model) {
        if (oldModel !== appState.model) await testApiConnection(true);
        eventBus.emit("documents:reload");
      }
    });
  }

  // Pricing Synchronization Handler
  async function handleSyncPricing(triggerBtn, spinnerEl) {
    if (triggerBtn) triggerBtn.disabled = true;
    if (spinnerEl) spinnerEl.classList.add("spinning");

    try {
      const res = await apiClient.syncPricing();
      if (res && res.status === "success") {
        if (res.pricing) {
          appState.pricing = res.pricing;
          updateModelSpecs(modelSelect ? modelSelect.value : appState.model);
          eventBus.emit("documents:reload");
        }
        showToast("Pricing Updated", res.message || "Live pricing successfully synchronized from Google AI.");
      } else if (res && res.status === "warning") {
        showToast("Pricing Synced", res.message || "Pricing check completed.", false);
      } else {
        showToast("Sync Error", (res && res.message) || "Could not fetch pricing.", true);
      }
    } catch (err) {
      showToast("Sync Error", err.message || "Failed to reach pricing endpoint.", true);
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
      if (spinnerEl) spinnerEl.classList.remove("spinning");
    }
  }

  if (settingsSyncPricingBtn) {
    settingsSyncPricingBtn.addEventListener("click", () => {
      handleSyncPricing(settingsSyncPricingBtn, settingsSyncSpinner);
    });
  }

  if (econSyncPricingBtn) {
    econSyncPricingBtn.addEventListener("click", () => {
      handleSyncPricing(econSyncPricingBtn, econSyncSpinner);
    });
  }

  if (changeWorkingDirBtn) {
    changeWorkingDirBtn.addEventListener("click", async () => {
      const newPath = workingDirInput ? workingDirInput.value.trim() : "";
      if (!newPath) return;

      try {
        const res = await apiClient.setRootFolder(newPath);
        if (res && res.status === "success") {
          appState.rootDirectory = res.root_directory;
          showToast("Workspace Switched", `Active directory set to ${res.root_directory}`);
          eventBus.emit("documents:reload");
          if (settingsModal) settingsModal.style.display = "none";
        } else {
          showToast("Directory Error", (res && res.detail) || "Invalid path", true);
        }
      } catch (e) {
        showToast("Error", e.message, true);
      }
    });
  }

  // Initial update of specs card
  updateModelSpecs(appState.model);
}

