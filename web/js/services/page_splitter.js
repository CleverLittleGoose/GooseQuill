/**
 * GooseQuill — Assembled Document → Page Map
 *
 * One splitter, used by every surface that has to turn an assembled Markdown
 * document back into the pages it was transcribed from. The Studio and the
 * compare pane each carried their own copy of this, which is exactly the sort
 * of duplication that drifts: a fix to one silently left the other reading the
 * same file differently.
 */

// The assembler writes a page as an HTML comment marker, a "## Page N"
// heading, or both. Either one opens a page.
const PAGE_MARKER_RE = /(?:<!--\s*Page\s+(\d+)\s*-->|(?:\n|^)##\s+Page\s+(\d+))/gi;

/**
 * Split an assembled document into page-indexed Markdown.
 *
 * @param {string} fullMarkdown
 * @returns {Object} `{ [pageNumber]: markdown }`, plus a `preamble` key holding
 *   the document header written before the first page, when there is one.
 */
export function parsePages(fullMarkdown) {
  const pages = {};
  if (!fullMarkdown) return pages;

  const pattern = new RegExp(PAGE_MARKER_RE.source, "gi");
  const splits = [];
  let match;

  while ((match = pattern.exec(fullMarkdown)) !== null) {
    splits.push({
      pageNum: parseInt(match[1] || match[2], 10),
      start: match.index
    });
  }

  // No markers at all: a single-page document, or one the assembler did not
  // write. Either way it is one page rather than nothing.
  if (splits.length === 0) {
    pages[1] = fullMarkdown.trim();
    return pages;
  }

  // The assembler writes both "<!-- Page N -->" and "## Page N", and the
  // pattern matches each of them. Left as two splits, page N would be cut in
  // half and the half that survived would lose its comment marker — which is
  // what the fence unwrapper keys on. Keep only the first split per page.
  const deduped = splits.filter(
    (split, i) => i === 0 || split.pageNum !== splits[i - 1].pageNum
  );

  // Everything before the first page marker is the document header the
  // converter writes (title, source file, model). Splitting on markers alone
  // dropped it, so it is carried separately rather than lost.
  const preamble = fullMarkdown.slice(0, deduped[0].start).trim();
  if (preamble) pages.preamble = preamble;

  for (let i = 0; i < deduped.length; i++) {
    const nextStart = i + 1 < deduped.length ? deduped[i + 1].start : fullMarkdown.length;
    let content = fullMarkdown.substring(deduped[i].start, nextStart).trim();
    // A trailing rule is the separator between pages, not part of this one.
    if (content.endsWith("---")) content = content.slice(0, -3).trim();
    pages[deduped[i].pageNum] = content;
  }

  return pages;
}

/** The page numbers in a page map, in order, ignoring `preamble`. */
export function pageNumbersOf(pages) {
  return Object.keys(pages || {})
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Split a *consolidated* document — many source documents in one file — into a
 * sequential list of page blocks.
 *
 * `parsePages` keys by the page number written in the document, which is right
 * for one filing and wrong for a combined one: every source document starts
 * again at page 1, so keying by page number would have each document's page 1
 * overwrite the last. Here the keys are the position in the combined file, and
 * the page number the document claims is carried separately as a label.
 *
 * @returns {{pages: Object, labels: Object}} `pages` is `{1: markdown, ...}` in
 *   file order with a `preamble` entry for the master title and contents;
 *   `labels` maps the same keys to what each block calls itself.
 */
export function splitSequential(fullMarkdown) {
  const pages = {};
  const labels = {};
  if (!fullMarkdown) return { pages, labels };

  const pattern = new RegExp(PAGE_MARKER_RE.source, "gi");
  const splits = [];
  let match;

  while ((match = pattern.exec(fullMarkdown)) !== null) {
    splits.push({ pageNum: parseInt(match[1] || match[2], 10), start: match.index });
  }

  if (splits.length === 0) {
    pages[1] = fullMarkdown.trim();
    labels[1] = "1";
    return { pages, labels };
  }

  // Same duplicate-marker problem as `parsePages`: the assembler writes both
  // forms for one page, and they must not become two blocks.
  const deduped = splits.filter(
    (split, i) => i === 0 || !(split.pageNum === splits[i - 1].pageNum && split.start - splits[i - 1].start < 200)
  );

  const preamble = fullMarkdown.slice(0, deduped[0].start).trim();
  if (preamble) pages.preamble = preamble;

  deduped.forEach((split, i) => {
    const nextStart = i + 1 < deduped.length ? deduped[i + 1].start : fullMarkdown.length;
    let content = fullMarkdown.substring(split.start, nextStart).trim();
    if (content.endsWith("---")) content = content.slice(0, -3).trim();

    const key = i + 1;
    pages[key] = content;
    labels[key] = String(split.pageNum);
  });

  return { pages, labels };
}
