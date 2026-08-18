/**
 * Object-Oriented Markdown Rendering Service for GooseQuill
 * Encapsulates an isolated marked.Marked instance and DOMPurify sanitization.
 */
class MarkdownRenderer {
  constructor(options = {}) {
    this.options = {
      gfm: true,
      breaks: true,
      sanitize: true,
      ...options
    };

    // Initialize an isolated instance of Marked (avoiding global mutation)
    if (typeof marked !== "undefined" && marked.Marked) {
      this.markedInstance = new marked.Marked();
    } else if (typeof marked !== "undefined") {
      this.markedInstance = marked;
    } else {
      console.warn("MarkdownRenderer: marked.js is not loaded.");
      this.markedInstance = null;
    }

    this._configureRenderers();
    this._configurePurifyHooks();
  }

  _configureRenderers() {
    if (!this.markedInstance || !this.markedInstance.use) return;

    this.markedInstance.use({
      renderer: {
        // Safe image rendering (transforms missing/relative OCR images into clean badges)
        image(tokenOrHref, title, text) {
          let imgHref = "";
          let imgTitle = "";
          let imgText = "";

          if (tokenOrHref && typeof tokenOrHref === "object") {
            imgHref = (tokenOrHref.href || "").trim();
            imgTitle = (tokenOrHref.title || "").trim();
            imgText = (tokenOrHref.text || "").trim();
          } else {
            imgHref = typeof tokenOrHref === "string" ? tokenOrHref.trim() : "";
            imgTitle = typeof title === "string" ? title.trim() : "";
            imgText = typeof text === "string" ? text.trim() : "";
          }

          // Only allow real server API paths or valid complete external HTTPS URLs
          const isServerApi = imgHref.startsWith("/api/");
          const isCompleteHttps = imgHref.startsWith("https://") && !imgHref.includes("placeholder") && !imgHref.includes("example.com");
          const isValidDataUri = imgHref.startsWith("data:image/") && imgHref.length > 100 && !imgHref.includes("…") && !imgHref.includes("...");

          if (isServerApi || isCompleteHttps || isValidDataUri) {
            return `<img src="${imgHref}" alt="${imgText}" title="${imgTitle}" class="markdown-img" loading="lazy" onerror="this.style.display='none'" />`;
          }

          // Relative/missing filenames (e.g. barcode.png, logo.jpg) -> Render pleasant badge instead of 404
          const label = imgText || imgTitle || imgHref.split("/").pop() || "Document Graphic";
          return `<span class="badge" style="font-size: 12.5px; font-family: var(--font-sans); background: rgba(255,255,255,0.07); color: var(--text-secondary); border: 1px solid rgba(255,255,255,0.1); padding: 3px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 5px;" title="${imgHref}">🖼️ ${label}</span>`;
        },

        // Responsive table wrapper for financial statements & data tables
        table(headerOrToken, rows) {
          if (headerOrToken && typeof headerOrToken === "object" && headerOrToken.header) {
            const headerCells = headerOrToken.header.map(h => `<th>${h.text}</th>`).join("");
            const rowRows = headerOrToken.rows.map(r => `<tr>${r.map(c => `<td>${c.text}</td>`).join("")}</tr>`).join("");
            return `
              <div class="table-responsive-wrapper" style="overflow-x: auto; margin: 16px 0;">
                <table class="documents-table" style="width: 100%; border-collapse: collapse;">
                  <thead><tr>${headerCells}</tr></thead>
                  <tbody>${rowRows}</tbody>
                </table>
              </div>
            `;
          }
          
          return `
            <div class="table-responsive-wrapper" style="overflow-x: auto; margin: 16px 0;">
              <table class="documents-table" style="width: 100%; border-collapse: collapse;">
                ${headerOrToken || ""}
                ${rows || ""}
              </table>
            </div>
          `;
        },

        // Styled notes and blockquotes
        blockquote(quoteOrToken) {
          const content = typeof quoteOrToken === "object" ? (quoteOrToken.text || "") : (quoteOrToken || "");
          return `<blockquote class="statutory-note" style="border-left: 3px solid var(--primary); padding-left: 14px; margin: 14px 0; color: var(--text-secondary);">${content}</blockquote>`;
        }
      }
    });
  }

  _configurePurifyHooks() {
    if (typeof DOMPurify === "undefined") return;

    // Sanitize raw HTML <img> elements inserted directly in markdown
    DOMPurify.addHook("uponSanitizeElement", (node, data) => {
      if (data.tagName === "img") {
        const src = (node.getAttribute("src") || "").trim();
        const isServerApi = src.startsWith("/api/");
        const isCompleteHttps = src.startsWith("https://") && !src.includes("placeholder") && !src.includes("example.com");
        const isValidDataUri = src.startsWith("data:image/") && src.length > 100 && !src.includes("…") && !src.includes("...");

        if (!isServerApi && !isCompleteHttps && !isValidDataUri) {
          // Replace raw <img> with a clean span badge
          const label = node.getAttribute("alt") || src.split("/").pop() || "Document Graphic";
          const span = document.createElement("span");
          span.className = "badge";
          span.style.cssText = "font-size: 12.5px; background: rgba(255,255,255,0.07); color: #cbd5e1; border: 1px solid rgba(255,255,255,0.1); padding: 3px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 5px;";
          span.textContent = `🖼️ ${label}`;
          if (node.parentNode) {
            node.parentNode.replaceChild(span, node);
          }
        }
      }
    });
  }

  /**
   * Render markdown string into safe, sanitized HTML
   * @param {string} markdownText 
   * @returns {string} Safe HTML string
   */
  render(markdownText) {
    if (!markdownText) return "";

    let rawHtml = "";
    if (this.markedInstance) {
      try {
        rawHtml = this.markedInstance.parse(markdownText);
      } catch (err) {
        console.error("Markdown parse error:", err);
        rawHtml = `<pre class="error-pre">${this._escapeHtml(markdownText)}</pre>`;
      }
    } else {
      rawHtml = `<pre>${this._escapeHtml(markdownText)}</pre>`;
    }

    // Sanitize with DOMPurify if available
    if (typeof DOMPurify !== "undefined" && this.options.sanitize) {
      return DOMPurify.sanitize(rawHtml, {
        ADD_ATTR: ["target", "data-page", "class", "loading", "onerror"],
        ADD_TAGS: ["table", "thead", "tbody", "tr", "th", "td", "span"]
      });
    }

    return rawHtml;
  }

  _escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

// Attach to window and export for ES6 modules
export const markdownRenderer = new MarkdownRenderer();
window.MarkdownRenderer = MarkdownRenderer;
window.markdownRenderer = markdownRenderer;
