/**
 * GooseQuill — Studio State
 *
 * The Studio's own mutable state, in one object every Studio module reads and
 * writes rather than each keeping a private copy. This used to be a wall of
 * module-level `let`s in a single 1,700-line file; splitting that file up meant
 * the state had to become something shared explicitly.
 *
 * Document-level facts (which document, which page, how many pages) stay in
 * `appState` — they are not the Studio's alone.
 */

export const studio = {
  /** "rendered" | "raw" — the transcript, or the Markdown behind it. */
  format: "rendered",

  /** "all" | "page" — the whole document, or only the page on screen. */
  scope: "all",

  /** Whether scrolling the transcript moves the scan with it. */
  autoSync: true,

  /** `{ [pageNumber]: markdown }` for the active document, plus `preamble`. */
  pagesMap: {},

  /**
   * What each block calls itself, when that differs from its key.
   *
   * Null for a filing, where the key is the page number. Set for a
   * consolidation, whose blocks are keyed by position because every source
   * document in it starts again at page 1.
   */
  pageLabels: null,

  /** The virtualised transcript for pane A. */
  transcript: null,

  /** Pane B. Null until Compare is switched on. */
  comparePane: null,
  compareEnabled: false,
  linkPages: true,

  /** Change highlighting between pane A and pane B. */
  diffEnabled: false,
  /**
   * "source" | "prose" — whether the comparison runs over the Markdown as
   * written, or over the words it renders to.
   *
   * Source catches a changed table row or a restructured heading, which for
   * accounts is usually the point. Prose reads far more like the document, at
   * the cost of not showing you formatting changes at all. Neither is right for
   * every comparison, so the choice belongs to whoever is reading.
   */
  diffMode: "source",
  diffChangedPages: [],

  /** Whether the raw editor holds edits that are not on disk yet. */
  rawEditorDirty: false
};

/** The find bar's state, shared between the rendered and raw search paths. */
export const searchState = {
  isOpen: false,
  query: "",
  matchCase: false,
  /**
   * Which pane is being searched: "A" or "B".
   *
   * Find only ever looked at pane A, so with two documents open half of what
   * was on screen was unsearchable.
   */
  pane: "A",

  /** {start, end} offsets — raw editor mode only. */
  rawMatches: [],
  currentIndex: -1,
  debounceTimer: null
};
