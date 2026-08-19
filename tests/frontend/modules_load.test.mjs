/**
 * Every frontend module parses, loads, and has no broken import.
 *
 * Cheap insurance for a codebase of ES modules with no build step: nothing
 * would otherwise catch a typo in an import path or a circular import until the
 * browser hit it, and a module that fails to load takes the whole app with it.
 *
 * The globals below are the smallest browser stub that lets a module body
 * evaluate. They deliberately do nothing useful — this test is about whether a
 * module loads, not what it does once loaded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");

const noop = () => {};
const stubElement = () => ({
  style: {},
  dataset: {},
  classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
  addEventListener: noop,
  removeEventListener: noop,
  appendChild: noop,
  append: noop,
  insertBefore: noop,
  setAttribute: noop,
  querySelector: () => null,
  querySelectorAll: () => []
});

globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: stubElement,
  createDocumentFragment: stubElement,
  createTextNode: stubElement,
  body: stubElement(),
  addEventListener: noop
};
globalThis.window = { addEventListener: noop, requestAnimationFrame: noop };
globalThis.localStorage = { getItem: () => null, setItem: noop };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.DOMPurify = { sanitize: (s) => s, addHook: noop };
globalThis.marked = { parse: (s) => s, setOptions: noop, use: noop };

function jsFilesUnder(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "vendor") found.push(...jsFilesUnder(full));
    } else if (name.endsWith(".js")) {
      found.push(full);
    }
  }
  return found;
}

const modules = [...jsFilesUnder(join(webRoot, "js")), join(webRoot, "app.js")];

test("there are modules to check at all", () => {
  // Guards against the walk silently finding nothing and the suite passing vacuously.
  assert.ok(modules.length > 10, `expected the frontend to have modules, found ${modules.length}`);
});

for (const file of modules) {
  const label = file.slice(webRoot.length + 1);
  test(`${label} loads`, async () => {
    await import(pathToFileURL(file).href);
  });
}
