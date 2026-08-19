/**
 * Object-Oriented Markdown Rendering Service for GooseQuill
 * Encapsulates an isolated marked.Marked instance and DOMPurify sanitization.
 */
export class MarkdownRenderer {
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
    MarkdownRenderer._installImageErrorHandler();
  }

  /**
   * Escape a value for interpolation into a double-quoted HTML attribute.
   */
  static escapeAttribute(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * Hide images that fail to load, without an inline onerror attribute.
   *
   * `error` does not bubble, so this listens in the capture phase at the
   * document root. One listener covers every rendered pane, including panes
   * that get their innerHTML replaced later.
   */
  static _installImageErrorHandler() {
    if (MarkdownRenderer._imageErrorHandlerInstalled) return;
    MarkdownRenderer._imageErrorHandlerInstalled = true;

    document.addEventListener(
      "error",
      (event) => {
        const el = event.target;
        if (el && el.tagName === "IMG" && el.classList.contains("markdown-img")) {
          el.style.display = "none";
        }
      },
      true
    );
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
            const attr = MarkdownRenderer.escapeAttribute;
            return `<img src="${attr(imgHref)}" alt="${attr(imgText)}" title="${attr(imgTitle)}" class="markdown-img" loading="lazy" />`;
          }

          // Relative/missing filenames (e.g. barcode.png, logo.jpg) -> Render pleasant badge instead of 404
          const label = imgText || imgTitle || imgHref.split("/").pop() || "Document Graphic";
          const esc = MarkdownRenderer.escapeAttribute;
          return `<span class="badge" style="font-size: 12.5px; font-family: var(--font-sans); background: rgba(255,255,255,0.07); color: var(--text-secondary); border: 1px solid rgba(255,255,255,0.1); padding: 3px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 5px;" title="${esc(imgHref)}">🖼️ ${esc(label)}</span>`;
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
   * Unwrap a code fence that wraps a whole page of markdown.
   *
   * The server strips these at assembly time now, so this only exists for .md
   * files converted before that fix. It deliberately mirrors the server rule
   * (MarkdownAssembler.clean_page_markdown): unwrap only when the opening fence
   * is closed by the very last line, otherwise a page holding two ordinary code
   * blocks gets its outer fences eaten and the prose between them rendered as
   * code.
   *
   * @param {string} markdownText
   * @returns {string} Cleaned markdown
   */
  _preprocessMarkdown(markdownText) {
    if (!markdownText) return "";

    // Page-level wrapper emitted directly after a page header, e.g.
    // `<!-- Page 3 -->\n## Page 3\n\u0060\u0060\u0060markdown\n...\n\u0060\u0060\u0060`
    const processed = markdownText.replace(
      /((?:<!--\s*Page\s+\d+\s*-->\s*(?:##\s*Page\s+\d+\s*)?|##\s*Page\s+\d+\s*))```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```[ \t]*(?=\n|$)/gi,
      (match, prefix, inner) => (inner.includes("```") ? match : `${prefix}\n${inner}\n`)
    );

    return MarkdownRenderer.unwrapWholeDocumentFence(
      MarkdownRenderer.collapseRuleRuns(processed)
    );
  }

  /**
   * Turn an OCR'd rule back into a rule.
   *
   * A signature line, a dotted leader or a table border comes back from the
   * model as the characters it saw: one page of a filing produced a 6,402
   * character run of "- - - - - ". Markdown reads every "- " as a list item, so
   * that one artefact became thousands of empty bullets, filled the pane, and
   * pushed the rest of the page off the bottom.
   *
   * This is not an attempt to anticipate everything the model might do — it
   * cannot be. It bounds the damage from one common shape: a line that is
   * nothing but separator characters is a rule, however long it runs, and there
   * is no information in the length of it. The file on disk is untouched; this
   * is what gets displayed.
   */
  static collapseRuleRuns(text) {
    if (!text) return text;

    // Anything from this many separator characters on a line is scenery.
    const MIN_RUN = 24;

    return text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.length < MIN_RUN) return line;
        // Only separator characters and the spaces between them.
        if (!/^[-–—_.·•*=~]+(?:[ \t]*[-–—_.·•*=~]+)*$/.test(trimmed)) return line;
        return "---";
      })
      .join("\n");
  }

  /**
   * Unwrap a fence enclosing the entire string, or return the string unchanged.
   */
  static unwrapWholeDocumentFence(text) {
    const trimmed = (text || "").trim();
    const lines = trimmed.split("\n");
    if (lines.length < 2) return trimmed;

    const opening = /^(`{3,})[ \t]*([^\s`]*)[ \t]*$/.exec(lines[0].trim());
    if (!opening) return trimmed;

    const [, ticks, info] = opening;
    if (!["", "markdown", "md"].includes(info.toLowerCase())) return trimmed;

    const closing = new RegExp(`^\`{${ticks.length},}[ \\t]*$`);
    let closingIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (closing.test(lines[i].trim())) {
        closingIdx = i;
        break;
      }
    }
    if (closingIdx !== lines.length - 1) return trimmed;

    return lines.slice(1, closingIdx).join("\n").trim();
  }

  /**
   * Render markdown string into safe, sanitized HTML
   * @param {string} markdownText 
   * @returns {string} Safe HTML string
   */
  render(markdownText) {
    if (!markdownText) return "";

    const cleanedMarkdown = this._preprocessMarkdown(markdownText);

    let rawHtml = "";
    if (this.markedInstance) {
      try {
        rawHtml = this.markedInstance.parse(cleanedMarkdown);
      } catch (err) {
        console.error("Markdown parse error:", err);
        rawHtml = `<pre class="error-pre">${this._escapeHtml(cleanedMarkdown)}</pre>`;
      }
    } else {
      rawHtml = `<pre>${this._escapeHtml(cleanedMarkdown)}</pre>`;
    }

    // Sanitize with DOMPurify if available
    if (typeof DOMPurify !== "undefined" && this.options.sanitize) {
      return DOMPurify.sanitize(rawHtml, {
        // No event-handler attributes here, ever. Markdown reaching this point is
        // model output transcribed from third-party PDFs, so an `onerror` in
        // ADD_ATTR is a direct script-execution path. Broken images are hidden by
        // the delegated listener installed in _installImageErrorHandler instead.
        ADD_ATTR: ["target", "data-page", "class", "loading"],
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
