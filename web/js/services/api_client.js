/**
 * Object-Oriented API Client for GooseQuill Backend
 * Encapsulates all REST calls, error handling, and JSON parsing.
 */
class ApiClient {
  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;
  }

  async _request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const defaultHeaders = {};
    if (options.body && !(options.body instanceof FormData)) {
      defaultHeaders["Content-Type"] = "application/json";
    }

    const config = {
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {})
      }
    };

    const response = await fetch(url, config);
    if (!response.ok) {
      let errorDetail = `HTTP Error ${response.status}`;
      try {
        const errorJson = await response.json();
        errorDetail = errorJson.detail || errorJson.message || errorDetail;
      } catch (e) {
        // Not JSON
      }
      const err = new Error(errorDetail);
      err.status = response.status;
      throw err;
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return await response.json();
    }
    return await response.text();
  }

  // Documents & Folders
  async getDocuments(model = "gemini-3.1-flash-lite") {
    return this._request(`/api/documents?model=${encodeURIComponent(model)}`);
  }

  async getPricing() {
    return this._request("/api/pricing");
  }

  async syncPricing() {
    return this._request("/api/sync_pricing", { method: "POST" });
  }

  async createFolder(folderName) {
    return this._request("/api/create_folder", {
      method: "POST",
      body: JSON.stringify({ folder_name: folderName })
    });
  }

  async folderPickerStatus() {
    return this._request("/api/folder_picker");
  }

  async browseForFolder(startDir) {
    return this._request("/api/browse_folder", {
      method: "POST",
      body: JSON.stringify({ start_dir: startDir || null })
    });
  }

  async setRootFolder(rootPath) {
    return this._request("/api/set_root_folder", {
      method: "POST",
      body: JSON.stringify({ root_path: rootPath })
    });
  }

  async uploadFile(formData) {
    return this._request("/api/upload", {
      method: "POST",
      body: formData
    });
  }

  // Conversion Operations
  async startConversion(files, model, systemPrompt, forceReprocess = false, limitPages = null, concurrency = 5) {
    return this._request("/api/convert", {
      method: "POST",
      body: JSON.stringify({
        files,
        model,
        system_prompt: systemPrompt,
        force_reprocess: forceReprocess,
        limit_pages: limitPages,
        concurrency: concurrency
      })
    });
  }

  async getJobStatus() {
    return this._request("/api/job_status");
  }

  async cancelJob() {
    return this._request("/api/cancel", { method: "POST" });
  }

  async testConnection(model = "gemini-3.1-flash-lite") {
    return this._request(`/api/test_connection?model=${encodeURIComponent(model)}`);
  }

  // Markdown View & Edit
  async getMarkdown(path) {
    return this._request(`/api/markdown?path=${encodeURIComponent(path)}`);
  }

  async getMarkdownPage(path, page) {
    return this._request(`/api/markdown/page?path=${encodeURIComponent(path)}&page=${page}`);
  }

  async saveMarkdown(filePath, content) {
    return this._request("/api/markdown", {
      method: "POST",
      body: JSON.stringify({ file_path: filePath, content })
    });
  }

  // Batch API Operations
  async getBatchJobs() {
    return this._request("/api/batch/jobs");
  }

  async submitBatchJob(pdfPaths, model, systemPrompt, displayName = null) {
    return this._request("/api/batch/submit", {
      method: "POST",
      body: JSON.stringify({
        pdf_paths: pdfPaths,
        model,
        system_prompt: systemPrompt,
        display_name: displayName
      })
    });
  }

  async checkBatchJob(jobId) {
    return this._request(`/api/batch/check/${encodeURIComponent(jobId)}`);
  }

  async cancelBatchJob(jobId) {
    return this._request(`/api/batch/cancel/${encodeURIComponent(jobId)}`, {
      method: "POST"
    });
  }

  async deleteBatchJob(jobId) {
    return this._request(`/api/batch/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE"
    });
  }

  // Batch Plans
  //
  // A plan is the whole corpus broken into jobs and driven a step at a time.
  // The same plan files are driven by `goosequill batch run`, so these calls
  // read and write work that may have been started in a terminal.

  async listBatchPlans() {
    return this._request("/api/batch/plans");
  }

  async createBatchPlan({ root = null, model, preset = "financial", force = false, maxEnqueuedTokens = null, files = null } = {}) {
    const body = { model, preset, force };
    if (root) body.root = root;
    if (files) body.files = files;
    if (maxEnqueuedTokens) body.max_enqueued_tokens = maxEnqueuedTokens;
    return this._request("/api/batch/plans", {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async getBatchPlan(planId) {
    return this._request(`/api/batch/plans/${encodeURIComponent(planId)}`);
  }

  /** Take one step. Returns as soon as the step is under way, not when it ends. */
  async advanceBatchPlan(planId, { only = null, maxGroups = null, retryBlocked = false, retryFailed = false } = {}) {
    return this._request(`/api/batch/plans/${encodeURIComponent(planId)}/advance`, {
      method: "POST",
      body: JSON.stringify({
        only,
        max_groups: maxGroups,
        retry_blocked: retryBlocked,
        retry_failed: retryFailed
      })
    });
  }
}

// Attach to window and export for ES6 modules
export const apiClient = new ApiClient();
export { ApiClient };
window.ApiClient = ApiClient;
window.apiClient = apiClient;
