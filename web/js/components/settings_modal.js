/**
 * GooseQuill - Settings & Configuration Modal Component
 */

import { appState, eventBus } from "../state.js";
import { showToast } from "../services/notifications.js";
import { apiClient } from "../services/api_client.js";
import { testApiConnection } from "./header.js";
import { money } from "../format.js";

/**
 * Which generation a model belongs to: "gemini-3.1-flash-lite" → 3.
 *
 * `null` for anything that is not a numbered Gemini, so it gets its own
 * heading rather than being dropped off the list.
 */
function generationOf(key) {
  const match = /^gemini-(\d+)/.exec(String(key));
  return match ? Number(match[1]) : null;
}

/**
 * What one model reads as in the dropdown.
 *
 * The rates come from the registry rather than the markup, which is the whole
 * point: these used to be typed into the `<option>` labels, where a sync could
 * not reach them and the spec card below could contradict them.
 *
 * Exported for testing.
 */
export function modelOptionLabel(key, model, defaultModel) {
  const spec = model || {};
  const name = spec.name || key;
  const note = spec.recommended_for || spec.tier || "";

  // The registry's own note for the default model usually says so already
  // ("Default / Recommended — …"), and marking it again would read
  // "Default — $0.25 in / $1.50 out · Default / Recommended — …".
  const marker = key === defaultModel && !/\bdefault\b/i.test(note) ? "Default — " : "";

  const rates = `${money(spec.input_standard)} in / ${money(spec.output_standard)} out`;
  return note ? `${name} (${marker}${rates} · ${note})` : `${name} (${marker}${rates})`;
}

/**
 * The registry, arranged into the optgroups the dropdown draws.
 *
 * Newest generation first, models in the order the registry lists them — which
 * is the default first and then by rising cost. A generation nobody has heard
 * of yet groups itself, so a model added upstream needs no change here.
 *
 * Exported for testing.
 */
export function groupModelsForSelect(pricing, defaultModel) {
  const entries = Object.entries(pricing || {});
  if (entries.length === 0) return [];

  const byGeneration = new Map();
  for (const [key, model] of entries) {
    const generation = generationOf(key);
    if (!byGeneration.has(generation)) byGeneration.set(generation, []);
    byGeneration.get(generation).push({
      value: key,
      label: modelOptionLabel(key, model, defaultModel)
    });
  }

  const generations = [...byGeneration.keys()].sort((a, b) => {
    // Unnumbered models go last rather than sorting as generation zero.
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a;
  });

  return generations.map((generation, index) => ({
    label: generation === null
      ? "Other Models"
      : `Gemini ${generation}.x Models${index === 0 ? " (Latest Generation)" : ""}`,
    models: byGeneration.get(generation)
  }));
}

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

    const specModelName = document.getElementById("specModelName");
    const specModelTier = document.getElementById("specModelTier");
    const specModelContext = document.getElementById("specModelContext");
    const specModelDesc = document.getElementById("specModelDesc");
    const specStdInput = document.getElementById("specStdInput");
    const specStdOutput = document.getElementById("specStdOutput");
    const specBatchRate = document.getElementById("specBatchRate");
    const specCacheRate = document.getElementById("specCacheRate");
    const specModelRec = document.getElementById("specModelRec");

    // Empty for a model the registry has no entry for. Leaving the previous
    // model's figures on screen under this model's name is the one thing this
    // card must not do, so it goes blank instead — and `money` prints the same
    // dash for a rate that came back missing.
    const spec = (appState.pricing && appState.pricing[key]) || {};

    if (specModelName) specModelName.textContent = spec.name || key || "—";
    if (specModelTier) specModelTier.textContent = spec.tier || "—";
    if (specModelContext) specModelContext.textContent = `Context: ${spec.context_window || "—"}`;
    if (specModelDesc) specModelDesc.textContent = spec.description || "";
    if (specStdInput) specStdInput.textContent = `${money(spec.input_standard)} / 1M`;
    if (specStdOutput) specStdOutput.textContent = `${money(spec.output_standard)} / 1M`;
    if (specBatchRate) specBatchRate.textContent = `${money(spec.input_batch)} / ${money(spec.output_batch)} (50% Off)`;
    if (specCacheRate) specCacheRate.textContent = `${money(spec.context_cache)} / 1M`;
    if (specModelRec) specModelRec.textContent = spec.recommended_for || "";
  }

  /**
   * Rebuild the model dropdown from the registry we currently hold.
   *
   * Called every time the modal opens, and again after a sync, so the labels
   * are the same figures the estimates are costed against — and a model the
   * registry gains appears without anyone editing the markup.
   */
  function populateModelOptions(preferred) {
    if (!modelSelect) return;

    const previous = modelSelect.value;
    const groups = groupModelsForSelect(appState.pricing, appState.defaultModel || appState.model);

    modelSelect.innerHTML = "";

    if (groups.length === 0) {
      // The rates never arrived. An empty dropdown would leave nothing to pick
      // and nothing to save, so keep the model we are actually running with
      // and say its price is unknown rather than print one we do not have.
      const fallback = document.createElement("option");
      fallback.value = appState.model;
      fallback.textContent = `${appState.model} (rates unavailable)`;
      modelSelect.appendChild(fallback);
      modelSelect.value = appState.model;
      return;
    }

    for (const group of groups) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const model of group.models) {
        const option = document.createElement("option");
        option.value = model.value;
        option.textContent = model.label;
        optgroup.appendChild(option);
      }
      modelSelect.appendChild(optgroup);
    }

    // Assigning a value no option carries silently blanks a `<select>`, and the
    // save handler would then store an empty model. Only restore a choice that
    // survived the rebuild.
    const has = (value) => value && groups.some((g) => g.models.some((m) => m.value === value));
    const wanted = [preferred, previous, appState.model, appState.defaultModel].find(has);
    if (wanted) modelSelect.value = wanted;
  }

  /** Name the release in the footer, once the boot payload has said which. */
  function showVersion() {
    const el = document.getElementById("settingsVersion");
    if (!el) return;
    el.textContent = appState.version ? `GooseQuill ${appState.version}` : "";
  }

  function openSettings() {
    showVersion();

    if (modelSelect) {
      populateModelOptions(appState.model);
      updateModelSpecs(modelSelect.value);
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
      if (modelSelect && modelSelect.value) appState.model = modelSelect.value;
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
          // The rate card reports this next to the button that was just pressed,
          // so a successful sync has to move it — otherwise the card still says
          // "never synced" over figures that have this moment been fetched.
          appState.pricingSyncedAt = res.synced_at || null;
          // The option labels carry the rates as well, so they have to be
          // rebuilt — otherwise the dropdown still quotes the prices the sync
          // has just replaced, and disagrees with the card below it.
          populateModelOptions();
          updateModelSpecs(modelSelect ? modelSelect.value : appState.model);
          // The Economics rate card is drawn from this same registry, so it has
          // to be redrawn — otherwise the sync reports success over a table
          // still showing the figures it just replaced.
          eventBus.emit("pricing:updated");
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

  // The rates arrive after this runs, so this first pass usually draws the
  // "rates unavailable" fallback; opening the modal rebuilds it from whatever
  // has landed by then.
  populateModelOptions(appState.model);
  updateModelSpecs(appState.model);
}

