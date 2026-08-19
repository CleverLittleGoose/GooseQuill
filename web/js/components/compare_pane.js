/**
 * GooseQuill — Studio Compare Pane
 *
 * The second document in Studio's side-by-side view. Pane A is whatever the
 * Workspace opened; this is pane B, and it carries its own document picker so a
 * filing can be set against another year of the same entity without leaving the
 * Studio.
 *
 * Each pane can show either the transcript or the scanned page, so the same
 * component covers both comparisons people actually want:
 *   - transcript vs transcript, for reading two years of accounts together
 *   - transcript vs scan, for checking a conversion against the original
 *
 * It owns its own TranscriptView, so pane B is virtualised exactly like pane A
 * and opening a 200-page filing beside another stays cheap.
 */

import { TranscriptView } from "../services/transcript_view.js";
import { populateDocumentSelect, findDocumentByPath, resolvePdfPath } from "../services/document_catalog.js";
import { parsePages } from "../services/page_splitter.js";

export class ComparePane {
  /**
   * @param {HTMLElement} container
   * @param {{label?: string, onPageChange?: (page:number)=>void}} options
   */
  constructor(container, options = {}) {
    this.container = container;
    this.label = options.label || "B";
    this.onPageChange = options.onPageChange || (() => {});
    this.onDocumentLoaded = options.onDocumentLoaded || (() => {});

    this.doc = null;
    this.pdfPath = null;
    this.totalPages = 1;
    this.currentPage = 1;
    this.view = "transcript";
    this.transcript = null;
    this.pagesMap = {};

    this._buildDom();
  }

  _buildDom() {
    this.container.innerHTML = `
      <div class="compare-pane-header">
        <span class="compare-pane-label">${this.label}</span>
        <select class="form-select form-select-sm compare-doc-select" aria-label="Choose the document for pane ${this.label}">
          <option value="">Choose a converted document…</option>
        </select>
        <div class="btn-group compare-view-toggle" role="group" aria-label="Pane ${this.label} view">
          <button type="button" class="btn btn-sm btn-secondary active" data-view="transcript" title="Show the converted text">📄 Text</button>
          <button type="button" class="btn btn-sm btn-secondary" data-view="pdf" title="Show the scanned page">🖼️ Scan</button>
        </div>
      </div>
      <div class="compare-pane-body">
        <div class="compare-transcript-pane">
          <div class="markdown-preview prose compare-transcript-content"></div>
        </div>
        <div class="compare-pdf-pane" style="display: none;">
          <div class="pdf-controls-bar">
            <button class="btn btn-xs btn-secondary compare-prev-btn">&larr; Prev</button>
            <span class="text-xs compare-page-indicator">Page 1 of 1</span>
            <button class="btn btn-xs btn-secondary compare-next-btn">Next &rarr;</button>
          </div>
          <div class="pdf-render-canvas-wrapper">
            <img class="pdf-page-image compare-page-image" alt="Scanned page preview for pane ${this.label}">
          </div>
        </div>
      </div>
    `;

    this.select = this.container.querySelector(".compare-doc-select");
    this.transcriptPane = this.container.querySelector(".compare-transcript-pane");
    this.transcriptContent = this.container.querySelector(".compare-transcript-content");
    this.pdfPane = this.container.querySelector(".compare-pdf-pane");
    this.pageImage = this.container.querySelector(".compare-page-image");
    this.pageIndicator = this.container.querySelector(".compare-page-indicator");
    this.prevBtn = this.container.querySelector(".compare-prev-btn");
    this.nextBtn = this.container.querySelector(".compare-next-btn");

    this.transcript = new TranscriptView(this.transcriptPane, this.transcriptContent, {
      onActivePageChange: (page) => {
        this.currentPage = page;
        this._refreshPdf();
        this.onPageChange(page);
      }
    });

    this.select.addEventListener("change", () => {
      const path = this.select.value;
      if (!path) return;
      const doc = this._findDocByPath(path);
      if (doc) this.loadDocument(doc);
    });

    this.container.querySelectorAll(".compare-view-toggle .btn").forEach((btn) => {
      btn.addEventListener("click", () => this.setView(btn.dataset.view));
    });

    this.prevBtn.addEventListener("click", () => this.goToPage(this.currentPage - 1));
    this.nextBtn.addEventListener("click", () => this.goToPage(this.currentPage + 1));

    let ticking = false;
    this.transcriptPane.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          if (this.transcript) this.transcript.syncActivePageFromScroll();
          ticking = false;
        });
      },
      { passive: true }
    );
  }

  /** Fill the picker from the shared catalogue. */
  populateDocuments() {
    this.documents = populateDocumentSelect(this.select);
  }

  _findDocByPath(path) {
    return findDocumentByPath(path);
  }

  async loadDocument(doc) {
    this.doc = doc;
    this.totalPages = doc.total_pages || 1;
    this.currentPage = 1;

    this.pdfPath = resolvePdfPath(doc);

    if (this.select.value !== doc.path) this.select.value = doc.path;

    this.transcriptContent.innerHTML =
      '<div class="text-muted text-center" style="padding: 40px;">Loading transcript…</div>';

    try {
      const res = await fetch(`/api/markdown?path=${encodeURIComponent(doc.path)}`);
      if (!res.ok) throw new Error("Could not load markdown");
      const data = await res.json();

      this.pagesMap = parsePages(data.content);
      this.transcript.setDocument(this.pagesMap, { restrictToPage: null });
    } catch (e) {
      this.transcriptContent.innerHTML = `<div class="text-danger text-center" style="padding: 40px;">Error loading transcript: ${e.message}</div>`;
    }

    this._refreshPdf();
    this.onDocumentLoaded(doc);
  }

  setView(view) {
    this.view = view === "pdf" ? "pdf" : "transcript";
    const isPdf = this.view === "pdf";

    this.transcriptPane.style.display = isPdf ? "none" : "flex";
    this.pdfPane.style.display = isPdf ? "flex" : "none";

    this.container.querySelectorAll(".compare-view-toggle .btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === this.view);
    });

    if (isPdf) {
      this._refreshPdf();
    } else if (this.transcript && this.doc) {
      // The transcript kept whatever position it had while hidden; bring it to
      // the page this pane is actually on, or the two halves disagree.
      this.transcript.scrollToPage(this.currentPage);
    }
  }

  /**
   * Move this pane to a page. Clamped, so linking to a longer document simply
   * stops at the end rather than blanking the pane.
   */
  goToPage(page) {
    if (!this.doc) return;
    const target = Math.max(1, Math.min(page, this.totalPages));
    if (target === this.currentPage && this.view === "pdf") return;

    this.currentPage = target;
    if (this.view === "pdf") {
      this._refreshPdf();
    } else if (this.transcript) {
      this.transcript.scrollToPage(target);
      this._refreshPdf();
    }
  }

  _refreshPdf() {
    if (!this.pdfPath) return;
    this.pageIndicator.textContent = `Page ${this.currentPage} of ${this.totalPages}`;
    this.prevBtn.disabled = this.currentPage <= 1;
    this.nextBtn.disabled = this.currentPage >= this.totalPages;

    // Only fetch the image when it is actually on screen.
    if (this.view !== "pdf") return;
    const url = `/api/page_image?path=${encodeURIComponent(this.pdfPath)}&page=${this.currentPage}`;
    if (this.pageImage.getAttribute("src") !== url) this.pageImage.src = url;
  }

  destroy() {
    if (this.transcript) this.transcript.destroy();
    this.transcript = null;
    this.container.innerHTML = "";
  }
}
