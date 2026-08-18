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

  async syncPricing() {
    return this._request("/api/sync_pricing", { method: "POST" });
  }

  async createFolder(folderName) {
    return this._request("/api/create_folder", {
      method: "POST",
      body: JSON.stringify({ folder_name: folderName })
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
}

// Attach to window for global access
window.ApiClient = ApiClient;
