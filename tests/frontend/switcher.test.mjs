/**
 * Ranking for the Cmd+P document switcher.
 *
 * The ranking is the whole feature: a switcher that makes you type the filename
 * exactly is no faster than the sidebar it replaces.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { rankDocuments, distinguishingName } from "../../web/js/studio/switcher.js";

const docs = [
  { folder: "Northwind Properties PLC", name: "Northwind Properties PLC - Annual Report 2025.pdf", path: "a" },
  { folder: "Northwind Properties PLC", name: "Northwind Properties PLC - Annual Report 2026.pdf", path: "b" },
  { folder: "Kingsmere Resort Operations Limited", name: "Kingsmere Resort - Mortgage or Charge 1.pdf", path: "c" },
  { folder: "Thistle MidCo 1 Limited", name: "Thistle MidCo 1 Limited - Annual Report 2025.pdf", path: "d" }
];

const paths = (query) => rankDocuments(docs, query).map((d) => d.path);

test("an empty query offers everything", () => {
  assert.equal(rankDocuments(docs, "").length, docs.length);
});

test("terms may be given in any order", () => {
  // "2025 northwind" is as reasonable a way to think of it as the reverse.
  assert.deepEqual(paths("northwind 2025"), paths("2025 northwind"));
  assert.deepEqual(paths("northwind 2025"), ["a"]);
});

test("every term has to match, so terms narrow rather than widen", () => {
  assert.deepEqual(paths("northwind 2026"), ["b"]);
  assert.deepEqual(paths("northwind thistle"), []);
});

test("matching is case insensitive", () => {
  assert.deepEqual(paths("NORTHWIND 2025"), ["a"]);
});

test("a partial word matches", () => {
  assert.deepEqual(paths("north 2026"), ["b"]);
});

test("an entity match outranks the same word buried in a filename", () => {
  const mixed = [
    { folder: "Holdings Ltd", name: "Report about Kingsmere Resort.pdf", path: "buried" },
    { folder: "Kingsmere Resort Operations Limited", name: "Mortgage or Charge 1.pdf", path: "entity" }
  ];
  assert.equal(rankDocuments(mixed, "kingsmere")[0].path, "entity");
});

test("nothing matching gives an empty list rather than everything", () => {
  assert.deepEqual(paths("nonexistent filing"), []);
});

test("results are capped so the list stays navigable", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    folder: "Bulk Entity",
    name: `Filing ${i}.pdf`,
    path: String(i)
  }));
  assert.ok(rankDocuments(many, "").length <= 40);
  assert.ok(rankDocuments(many, "filing").length <= 40);
});

test("documents with no entity or name do not throw", () => {
  assert.doesNotThrow(() => rankDocuments([{ path: "x" }], "anything"));
});


/* ------------------------------------------------------ what a row displays */

const named = (folder, name) => ({ folder, name });

test("the entity is dropped from the name when it only repeats the folder", () => {
  // Twenty years of one entity produced twenty identical truncated rows.
  assert.equal(
    distinguishingName(named("Kingsmere Resort Operations Limited",
                             "Kingsmere Resort Operations Limited - Annual Report 2019.pdf")),
    "Annual Report 2019"
  );
});

test("the separator between entity and title goes with it", () => {
  const folder = "Acme Holdings Limited";
  for (const sep of ["-", "–", "—", "_", ":", "."]) {
    assert.equal(distinguishingName(named(folder, `${folder} ${sep} Annual Report 2020.pdf`)), "Annual Report 2020");
  }
});

test("matching ignores case and extra spacing", () => {
  assert.equal(
    distinguishingName(named("Acme Holdings Limited", "ACME  Holdings   Limited - Annual Report 2021.pdf")),
    "Annual Report 2021"
  );
});

test("a name that does not start with the entity is left whole", () => {
  assert.equal(
    distinguishingName(named("Acme Holdings Limited", "Mortgage or Charge 3.pdf")),
    "Mortgage or Charge 3"
  );
});

test("a name that is only the entity keeps it, rather than becoming blank", () => {
  assert.equal(
    distinguishingName(named("Acme Holdings Limited", "Acme Holdings Limited.pdf")),
    "Acme Holdings Limited"
  );
});

test("the .md extension is dropped too, for consolidated documents", () => {
  assert.equal(
    distinguishingName(named("Acme Holdings Limited", "Acme Holdings Limited - Consolidated 2008-2025.md")),
    "Consolidated 2008-2025"
  );
});

test("a document with no folder keeps its full name", () => {
  assert.equal(distinguishingName({ name: "Some Filing 2020.pdf" }), "Some Filing 2020");
});
