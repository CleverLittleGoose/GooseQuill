/**
 * GooseQuill — Word-level Text Diff
 *
 * Compares two transcripts a page at a time so a filing can be read against
 * another year of itself and the actual changes stand out, rather than being
 * hunted for by eye across two columns.
 *
 * Diffing is word-level, not line-level: OCR output rewraps freely, so a
 * line-based comparison would report every paragraph as changed the moment one
 * word moved. Pages are compared only when they are about to be shown, and a
 * cheap normalised-equality pass decides up front which pages differ at all.
 */

// Beyond this many edits a page has been rewritten rather than amended.
// Reporting it as one wholesale replacement is both faster and more honest than
// a shredded word-by-word trace nobody can read.
const MAX_EDIT_DISTANCE = 800;

/** Split into words and the whitespace between them, keeping both. */
export function tokenise(text) {
  if (!text) return [];
  return text.match(/\s+|[^\s]+/g) || [];
}

/** Collapse whitespace so rewrapping alone never counts as a change. */
export function normalise(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

/**
 * Which pages differ between two documents.
 *
 * @returns {{changedPages:number[], onlyInA:number[], onlyInB:number[], sharedPages:number[]}}
 */
export function comparePageSets(pagesA, pagesB) {
  const numbersA = pageNumbersOf(pagesA);
  const numbersB = pageNumbersOf(pagesB);
  const setB = new Set(numbersB);

  const changedPages = [];
  const sharedPages = [];
  const onlyInA = numbersA.filter((n) => !setB.has(n));
  const onlyInB = numbersB.filter((n) => !new Set(numbersA).has(n));

  numbersA.forEach((page) => {
    if (!setB.has(page)) return;
    sharedPages.push(page);
    if (normalise(pagesA[page]) !== normalise(pagesB[page])) changedPages.push(page);
  });

  return { changedPages, onlyInA, onlyInB, sharedPages };
}

function pageNumbersOf(pages) {
  return Object.keys(pages || {})
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Diff two token arrays.
 *
 * Common prefix and suffix are stripped first — for two years of the same
 * filing most of a page is usually identical, and that reduces the work the
 * edit-distance search has to do enormously.
 *
 * @returns {Array<{op:"=", "-"|"+", tokens:string[]}>}
 */
export function diffTokens(a, b) {
  const ops = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  if (start > 0) ops.push({ op: "=", tokens: a.slice(0, start) });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length === 0 && midB.length === 0) {
    // whole thing matched
  } else if (midA.length === 0) {
    ops.push({ op: "+", tokens: midB });
  } else if (midB.length === 0) {
    ops.push({ op: "-", tokens: midA });
  } else if (midA.length + midB.length > MAX_EDIT_DISTANCE * 2) {
    ops.push({ op: "-", tokens: midA });
    ops.push({ op: "+", tokens: midB });
  } else {
    ops.push(...myers(midA, midB));
  }

  if (endA < a.length) ops.push({ op: "=", tokens: a.slice(endA) });

  return mergeAdjacent(ops);
}

/**
 * Myers' O(ND) difference algorithm, recording each round so the edit script
 * can be recovered by walking the trace backwards.
 */
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const v = new Map([[1, 0]]);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));

    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v.get(k - 1) || 0) < (v.get(k + 1) || 0))) {
        x = v.get(k + 1) || 0;
      } else {
        x = (v.get(k - 1) || 0) + 1;
      }
      let y = x - k;

      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);

      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }

  // Hit the ceiling: treat it as a wholesale replacement.
  return [
    { op: "-", tokens: a },
    { op: "+", tokens: b }
  ];
}

function backtrack(trace, a, b, d) {
  const ops = [];
  let x = a.length;
  let y = b.length;

  for (let step = d; step > 0; step--) {
    const v = trace[step];
    const k = x - y;

    let prevK;
    if (k === -step || (k !== step && (v.get(k - 1) || 0) < (v.get(k + 1) || 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = v.get(prevK) || 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ op: "=", tokens: [a[x - 1]] });
      x--;
      y--;
    }

    if (x === prevX) {
      ops.push({ op: "+", tokens: [b[y - 1]] });
      y--;
    } else {
      ops.push({ op: "-", tokens: [a[x - 1]] });
      x--;
    }
  }

  while (x > 0 && y > 0) {
    ops.push({ op: "=", tokens: [a[x - 1]] });
    x--;
    y--;
  }

  return ops.reverse();
}

function mergeAdjacent(ops) {
  const merged = [];
  ops.forEach((op) => {
    if (!op.tokens.length) return;
    const last = merged[merged.length - 1];
    if (last && last.op === op.op) last.tokens.push(...op.tokens);
    else merged.push({ op: op.op, tokens: [...op.tokens] });
  });
  return merged;
}

/**
 * Render one page pair as two HTML fragments.
 *
 * The A side shows what was removed, the B side what was added, and both keep
 * the unchanged text so each column still reads as a document rather than as a
 * list of fragments.
 *
 * @returns {{aHtml:string, bHtml:string, changed:boolean, added:number, removed:number}}
 */
export function diffPageHtml(markdownA, markdownB) {
  const textA = stripPageHeading(markdownA);
  const textB = stripPageHeading(markdownB);

  if (normalise(textA) === normalise(textB)) {
    const unchanged = `<div class="diff-body diff-unchanged">${escapeHtml(textA)}</div>`;
    return { aHtml: unchanged, bHtml: unchanged, changed: false, added: 0, removed: 0 };
  }

  const ops = diffTokens(tokenise(textA), tokenise(textB));

  let aHtml = "";
  let bHtml = "";
  let added = 0;
  let removed = 0;

  ops.forEach(({ op, tokens }) => {
    const text = escapeHtml(tokens.join(""));
    if (op === "=") {
      aHtml += text;
      bHtml += text;
    } else if (op === "-") {
      aHtml += `<del class="diff-del">${text}</del>`;
      removed += countWords(tokens);
    } else {
      bHtml += `<ins class="diff-ins">${text}</ins>`;
      added += countWords(tokens);
    }
  });

  return {
    aHtml: `<div class="diff-body">${aHtml}</div>`,
    bHtml: `<div class="diff-body">${bHtml}</div>`,
    changed: true,
    added,
    removed
  };
}

function countWords(tokens) {
  return tokens.filter((t) => /\S/.test(t)).length;
}

/**
 * Drop the "<!-- Page N -->" / "## Page N" header the assembler adds.
 * It is scaffolding, and diffing it just reports every page as changed when
 * the two documents have different page counts.
 */
function stripPageHeading(markdown) {
  return (markdown || "")
    .replace(/^<!--\s*Page\s+\d+\s*-->\s*/i, "")
    .replace(/^##\s+Page\s+\d+\s*/i, "")
    .trim();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
