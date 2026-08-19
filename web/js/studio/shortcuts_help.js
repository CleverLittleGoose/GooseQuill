/**
 * GooseQuill — Keyboard Shortcuts Help
 *
 * Shortcuts nobody knows about are shortcuts nobody uses. Press `?`.
 *
 * The list is built from one table so the overlay cannot drift from what the
 * handlers actually do — the usual failure of a help screen written by hand
 * once and never revisited.
 */

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
const MOD = IS_MAC ? "⌘" : "Ctrl";

export const SHORTCUTS = [
  {
    group: "Getting around",
    items: [
      { keys: [MOD, "K"], what: "Open a document" },
      { keys: [MOD, "⇧", "F"], what: "Search every document" },
      { keys: ["["], what: "Previous open document" },
      { keys: ["]"], what: "Next open document" },
      { keys: ["←"], what: "Previous page", also: ["PgUp"] },
      { keys: ["→"], what: "Next page", also: ["PgDn"] }
    ]
  },
  {
    group: "In this document",
    items: [
      { keys: [MOD, "F"], what: "Find in this document" },
      { keys: ["↵"], what: "Next match" },
      { keys: ["⇧", "↵"], what: "Previous match" },
      { keys: [MOD, "S"], what: "Save edits (Markdown view)" },
      { keys: ["Esc"], what: "Close the find bar" }
    ]
  },
  {
    group: "Comparing",
    items: [
      { keys: ["n"], what: "Next change" },
      { keys: ["p"], what: "Previous change" }
    ]
  }
];

let overlay = null;

export function isShortcutsHelpOpen() {
  return Boolean(overlay && overlay.style.display !== "none");
}

export function toggleShortcutsHelp() {
  isShortcutsHelpOpen() ? closeShortcutsHelp() : openShortcutsHelp();
}

export function openShortcutsHelp() {
  if (!overlay) build();
  overlay.style.display = "flex";
  overlay.querySelector(".shortcuts-close")?.focus();
}

export function closeShortcutsHelp() {
  if (overlay) overlay.style.display = "none";
}

function keyRow({ keys, what, also }) {
  const render = (list) => list.map((k) => `<kbd>${k}</kbd>`).join("");
  const alternative = also ? `<span class="shortcuts-or">or</span>${render(also)}` : "";
  return `
    <div class="shortcuts-row">
      <span class="shortcuts-what">${what}</span>
      <span class="shortcuts-keys">${render(keys)}${alternative}</span>
    </div>
  `;
}

function build() {
  overlay = document.createElement("div");
  overlay.className = "shortcuts-overlay";
  overlay.style.display = "none";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Keyboard shortcuts");

  overlay.innerHTML = `
    <div class="shortcuts-panel">
      <div class="shortcuts-header">
        <h2>Keyboard shortcuts</h2>
        <button class="btn btn-icon shortcuts-close" aria-label="Close">&times;</button>
      </div>
      <div class="shortcuts-body">
        ${SHORTCUTS.map(
          (section) => `
          <section class="shortcuts-group">
            <h3>${section.group}</h3>
            ${section.items.map(keyRow).join("")}
          </section>`
        ).join("")}
      </div>
      <div class="shortcuts-footer">
        Press <kbd>?</kbd> any time to see this again.
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closeShortcutsHelp();
  });
  overlay.querySelector(".shortcuts-close").addEventListener("click", closeShortcutsHelp);
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeShortcutsHelp();
    }
  });
}
