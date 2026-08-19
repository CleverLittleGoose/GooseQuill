/**
 * GooseQuill — Page Index
 *
 * The thumbnail strip down the left of the Studio.
 *
 * Every row used to read "Page N ✓", with the tick on all of them — a list
 * carrying no information you could navigate by. Rows now show the page itself,
 * fetched only when the row scrolls into view so a 200-page filing does not
 * fire 200 renders on open.
 */

import { appState } from "../state.js";
import * as dom from "./dom.js";

// Thumbnails are rendered server-side at this dpi: about 12KB per page against
// 190KB for a full preview, and legible enough to recognise a page by shape.
const THUMBNAIL_DPI = 20;

let thumbnailObserver = null;

/**
 * Rebuild the index for the active document.
 *
 * @param {{onSelect: (page:number) => void}} handlers — navigation is the
 *   caller's job; the index knows which page was clicked, not what to do about
 *   it, and importing the navigator here would tie the two together for nothing.
 */
export function renderPageList({ onSelect }) {
  const container = dom.pageList();
  const countEl = dom.pageCount();
  if (!container) return;

  if (thumbnailObserver) thumbnailObserver.disconnect();
  container.innerHTML = "";

  const total = appState.totalPdfPages || 1;
  if (countEl) countEl.textContent = total;

  thumbnailObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const img = entry.target.querySelector(".studio-page-thumb");
        if (img && !img.src && img.dataset.src) img.src = img.dataset.src;
        thumbnailObserver.unobserve(entry.target);
      });
    },
    { root: container, rootMargin: "400px 0px" }
  );

  const pdfPath = appState.currentViewingPdfPath;
  const fragment = document.createDocumentFragment();

  for (let page = 1; page <= total; page++) {
    const item = document.createElement("div");
    item.className = `studio-page-item ${page === appState.currentPdfPage ? "active" : ""}`;
    item.dataset.page = page;

    const thumbSrc = pdfPath
      ? `/api/page_image?path=${encodeURIComponent(pdfPath)}&page=${page}&dpi=${THUMBNAIL_DPI}`
      : "";

    item.innerHTML = `
      <div class="studio-page-thumb-frame">
        <img class="studio-page-thumb" data-src="${thumbSrc}" alt="" loading="lazy" decoding="async">
      </div>
      <span class="studio-page-item-label">Page ${page}</span>
    `;

    item.addEventListener("click", () => onSelect(page));
    fragment.appendChild(item);
  }

  container.appendChild(fragment);
  container.querySelectorAll(".studio-page-item").forEach((item) => thumbnailObserver.observe(item));
}

/** Move the highlight to the page that is current, and keep it in view. */
export function updateActiveItem() {
  document.querySelectorAll(".studio-page-item").forEach((item) => {
    const page = parseInt(item.dataset.page, 10);
    const isActive = page === appState.currentPdfPage;
    item.classList.toggle("active", isActive);
    if (isActive && item.scrollIntoViewIfNeeded) item.scrollIntoViewIfNeeded();
  });
}
