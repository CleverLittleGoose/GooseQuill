/**
 * The model dropdown's labels and groupings.
 *
 * Every `<option>` used to carry its own rates as typed text — "$0.25 in /
 * $1.50 out". Sync Rates could not reach them, so pressing it moved the spec
 * card an inch below and left the dropdown quoting the old price: two figures
 * for one model, on one screen, both looking equally authoritative.
 *
 * These tests hold the two properties that fixed it. The labels are built from
 * whatever the registry says, and a model the registry gains lands in the list
 * without anyone editing markup.
 */

import test from "node:test";
import assert from "node:assert/strict";

const noop = () => {};
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild: noop }),
  addEventListener: noop
};
globalThis.window = { addEventListener: noop, requestAnimationFrame: noop };
globalThis.localStorage = { getItem: () => null, setItem: noop };

const { groupModelsForSelect, modelOptionLabel } = await import(
  "../../web/js/components/settings_modal.js"
);

const FLASH_LITE = {
  name: "Gemini 3.1 Flash-Lite",
  input_standard: 0.25,
  output_standard: 1.5,
  recommended_for: "Default / Recommended — Ultra Low Cost & High Speed OCR",
  tier: "Default / Economy"
};

const PRO = {
  name: "Gemini 3.1 Pro Preview",
  input_standard: 2.0,
  output_standard: 12.0,
  recommended_for: "Frontier Multimodal Understanding & Complex Layouts",
  tier: "Frontier Pro"
};

test("a label quotes the registry's rates, not the markup's", () => {
  assert.equal(
    modelOptionLabel("gemini-3.1-pro-preview", PRO, "gemini-3.1-flash-lite"),
    "Gemini 3.1 Pro Preview ($2.00 in / $12.00 out · Frontier Multimodal Understanding & Complex Layouts)"
  );
});

test("a synced rate changes the label, which is the whole point", () => {
  // The same model after a sync that repriced it. Nothing in the dropdown is
  // allowed to still say $2.00.
  const repriced = { ...PRO, input_standard: 2.5, output_standard: 15 };
  const label = modelOptionLabel("gemini-3.1-pro-preview", repriced, "other");
  assert.match(label, /\$2\.50 in \/ \$15\.00 out/);
  assert.doesNotMatch(label, /\$2\.00/);
});

test("the default model is marked as the default", () => {
  const label = modelOptionLabel("gemini-3.7-flash", { name: "Gemini 3.7 Flash", input_standard: 0.75, output_standard: 3.75, recommended_for: "Flagship Hybrid Reasoning" }, "gemini-3.7-flash");
  assert.equal(label, "Gemini 3.7 Flash (Default — $0.75 in / $3.75 out · Flagship Hybrid Reasoning)");
});

test("a model whose own note already says 'default' is not marked twice", () => {
  // Otherwise: "Default — $0.25 in / $1.50 out · Default / Recommended — …".
  const label = modelOptionLabel("gemini-3.1-flash-lite", FLASH_LITE, "gemini-3.1-flash-lite");
  assert.equal(label.match(/default/gi).length, 1);
  assert.equal(
    label,
    "Gemini 3.1 Flash-Lite ($0.25 in / $1.50 out · Default / Recommended — Ultra Low Cost & High Speed OCR)"
  );
});

test("a rate that did not come back is a dash, never a free model", () => {
  const label = modelOptionLabel("gemini-9-mystery", { name: "Mystery" }, "other");
  assert.equal(label, "Mystery (— in / — out)");
  assert.doesNotMatch(label, /\$0\.00/);
});

test("a model with no name at all is listed under its id rather than blank", () => {
  assert.match(modelOptionLabel("gemini-3.4-flash", {}, "other"), /^gemini-3\.4-flash /);
});

test("models are grouped by generation, newest first", () => {
  const groups = groupModelsForSelect(
    {
      "gemini-3.1-flash-lite": FLASH_LITE,
      "gemini-3.1-pro-preview": PRO,
      "gemini-2.5-pro": { name: "Gemini 2.5 Pro", input_standard: 1.25, output_standard: 10 }
    },
    "gemini-3.1-flash-lite"
  );

  assert.deepEqual(groups.map((g) => g.label), [
    "Gemini 3.x Models (Latest Generation)",
    "Gemini 2.x Models"
  ]);
  assert.deepEqual(groups[0].models.map((m) => m.value), [
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview"
  ]);
  assert.deepEqual(groups[1].models.map((m) => m.value), ["gemini-2.5-pro"]);
});

test("a generation nobody has shipped yet groups itself, and leads", () => {
  // The reason the grouping is derived rather than written down: a model added
  // to the registry upstream has to appear here without a markup change.
  const groups = groupModelsForSelect(
    { "gemini-4-flash": { name: "Gemini 4 Flash" }, "gemini-3.1-flash-lite": FLASH_LITE },
    "gemini-3.1-flash-lite"
  );

  assert.equal(groups[0].label, "Gemini 4.x Models (Latest Generation)");
  assert.equal(groups[1].label, "Gemini 3.x Models");
});

test("only the newest group is billed as the latest", () => {
  const groups = groupModelsForSelect(
    { "gemini-3.1-flash-lite": FLASH_LITE, "gemini-2.5-pro": {}, "gemini-1.5-pro": {} },
    "gemini-3.1-flash-lite"
  );
  assert.equal(groups.filter((g) => g.label.includes("Latest Generation")).length, 1);
});

test("the registry's own ordering is preserved within a generation", () => {
  // It is deliberate: the default first, then by rising cost.
  const groups = groupModelsForSelect(
    { "gemini-3.7-flash": {}, "gemini-3.1-flash-lite": FLASH_LITE, "gemini-3.5-flash": {} },
    "gemini-3.1-flash-lite"
  );
  assert.deepEqual(groups[0].models.map((m) => m.value), [
    "gemini-3.7-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash"
  ]);
});

test("a model that is not a numbered Gemini is listed last, not dropped", () => {
  const groups = groupModelsForSelect(
    { "some-other-model": { name: "Something Else" }, "gemini-3.1-flash-lite": FLASH_LITE },
    "gemini-3.1-flash-lite"
  );

  assert.equal(groups.at(-1).label, "Other Models");
  assert.deepEqual(groups.at(-1).models.map((m) => m.value), ["some-other-model"]);
});

test("no pricing yields no groups, so the caller can say so", () => {
  // The dropdown falls back to the model actually in use, labelled as having
  // no known rate. An empty list here is how it knows to.
  assert.deepEqual(groupModelsForSelect({}, "gemini-3.1-flash-lite"), []);
  assert.deepEqual(groupModelsForSelect(null, "gemini-3.1-flash-lite"), []);
  assert.deepEqual(groupModelsForSelect(undefined, ""), []);
});
