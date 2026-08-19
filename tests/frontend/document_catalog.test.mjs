/**
 * The catalogue of documents the Studio can open.
 *
 * One list, built one way, so both compare panes and the Cmd+P switcher offer
 * the same documents in the same order. Pane A and pane B were asymmetric while
 * only B had a picker, and this module is what keeps them equals.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appState } from "../../web/js/state.js";
import {
  listConvertedDocuments,
  findDocumentByPath,
  resolvePdfPath
} from "../../web/js/services/document_catalog.js";

const doc = (folder, name, is_converted = true) => ({
  folder,
  name,
  is_converted,
  path: `/docs/${folder}/${name}`
});

function withFolders(folders, run) {
  const previous = appState.folders;
  appState.folders = folders;
  try {
    run();
  } finally {
    appState.folders = previous;
  }
}

test("only converted documents are offered", () => {
  withFolders(
    [{ documents: [doc("Acme", "a.pdf"), doc("Acme", "b.pdf", false)] }],
    () => {
      const names = listConvertedDocuments().map((d) => d.name);
      assert.deepEqual(names, ["a.pdf"]);
    }
  );
});

test("documents are ordered by entity, then by name", () => {
  withFolders(
    [
      { documents: [doc("Zeta", "b.pdf"), doc("Zeta", "a.pdf")] },
      { documents: [doc("Alpha", "z.pdf")] }
    ],
    () => {
      assert.deepEqual(
        listConvertedDocuments().map((d) => `${d.folder}/${d.name}`),
        ["Alpha/z.pdf", "Zeta/a.pdf", "Zeta/b.pdf"]
      );
    }
  );
});

test("an empty or absent workspace gives an empty list, not an error", () => {
  withFolders([], () => assert.deepEqual(listConvertedDocuments(), []));
  withFolders(undefined, () => assert.deepEqual(listConvertedDocuments(), []));
  withFolders([{}], () => assert.deepEqual(listConvertedDocuments(), []));
});

test("a path resolves back to its document, and an unknown one to null", () => {
  withFolders([{ documents: [doc("Acme", "a.pdf")] }], () => {
    assert.equal(findDocumentByPath("/docs/Acme/a.pdf").name, "a.pdf");
    assert.equal(findDocumentByPath("/docs/Acme/missing.pdf"), null);
    assert.equal(findDocumentByPath(""), null);
    assert.equal(findDocumentByPath(null), null);
  });
});

test("a .md path resolves to the scan it was transcribed from", () => {
  assert.equal(
    resolvePdfPath({ path: "/docs/Acme/Markdown/Annual Report.md" }),
    "/docs/Acme/Annual Report.pdf"
  );
});

test("a path that is already a PDF is left alone", () => {
  assert.equal(resolvePdfPath({ path: "/docs/Acme/Annual Report.pdf" }), "/docs/Acme/Annual Report.pdf");
});

test("resolving a missing path gives null rather than undefined", () => {
  assert.equal(resolvePdfPath(null), null);
  assert.equal(resolvePdfPath({}), null);
});
