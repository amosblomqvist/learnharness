import test from "node:test";
import assert from "node:assert/strict";
import { CACHE_BYTES, CACHE_ENTRIES, DEFAULT_SETTINGS, INSTRUCTIONS, SOURCE_LIMITS, SVG_LIMIT, checkSource, checkSvgSize, parseChange, parseInkChange, parseSettings } from "../src/contract.ts";
import { RenderCache } from "../src/render.ts";

test("strict versioned settings/change contracts retain false and reject unknown or malformed fields", () => {
  assert.deepEqual(parseSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  for (const invalid of [null, [], {}, { ...DEFAULT_SETTINGS, version: 2 }, { ...DEFAULT_SETTINGS, revision: -1 }, { ...DEFAULT_SETTINGS, revision: 0.5 }, { ...DEFAULT_SETTINGS, musicalNotation: "false" }, { ...DEFAULT_SETTINGS, extra: true }]) assert.throws(() => parseSettings(invalid));
  assert.deepEqual(parseChange({ family: "technicalDiagrams", enabled: false }), { family: "technicalDiagrams", enabled: false });
  for (const invalid of [null, {}, { family: "tikz", enabled: true }, { family: "musicalNotation", enabled: 0 }, { family: "musicalNotation", enabled: true, extra: false }]) assert.throws(() => parseChange(invalid));
});

test("ink settings accept existing v1 files and strictly validate the new choice", () => {
  const { inkColor: _inkColor, ...legacy } = DEFAULT_SETTINGS;
  assert.deepEqual(parseSettings(legacy), DEFAULT_SETTINGS);
  assert.equal(parseSettings({ ...legacy, inkColor: "black" }).inkColor, "black");
  for (const inkColor of [null, undefined, true, "auto", "White", "", 0]) {
    assert.throws(() => parseSettings({ ...legacy, inkColor }));
    assert.throws(() => parseInkChange({ inkColor }));
  }
  assert.equal(parseInkChange({ inkColor: "white" }), "white");
  assert.equal(parseInkChange({ inkColor: "black" }), "black");
  for (const input of [null, [], {}, "white", { inkColor: "white", enabled: true }]) assert.throws(() => parseInkChange(input));
});

test("technical-diagram instructions cover the observed TeX authoring failures", () => {
  const instructions = INSTRUCTIONS.technicalDiagrams;
  assert.match(instructions, /self-contained TeX with \\begin\{document\} and \\end\{document\}/);
  assert.match(instructions, /already supplies the standalone document class: never include \\documentclass or \\documentstyle/);
  assert.match(instructions, /Before \\begin\{document\}, explicitly load all packages/);
  for (const name of ["tikz", "circuitikz", "tikz-cd", "pgfplots", "amsmath"]) {
    assert.ok(instructions.includes(`\\usepackage{${name}}`), `Missing explicit package declaration: ${name}`);
  }
  assert.match(instructions, /\\text\{\.\.\.\} or aligned equations, also load \\usepackage\{amsmath\}/);
  assert.match(instructions, /\\usetikzlibrary in that same preamble/);
  assert.match(instructions, /available, not automatically loaded; do not rely on declarations from another block/);
});

test("UTF-8 source/output bounds are enforced without trimming valid payloads", () => {
  checkSource("smiles", "C".repeat(SOURCE_LIMITS.smiles));
  assert.throws(() => checkSource("smiles", "C".repeat(SOURCE_LIMITS.smiles + 1)));
  assert.throws(() => checkSource("smiles", "é".repeat(SOURCE_LIMITS.smiles)));
  assert.throws(() => checkSource("abc", " \n\t"));
  checkSvgSize("x".repeat(SVG_LIMIT)); assert.throws(() => checkSvgSize("x".repeat(SVG_LIMIT + 1)));
});

test("volatile LRU bounds include keys, recency, replacement and clear", () => {
  const cache = new RenderCache();
  for (let i = 0; i < CACHE_ENTRIES; i++) cache.set(String(i), "svg");
  assert.equal(cache.get("0"), "svg"); cache.set("new", "value");
  assert.equal(cache.get("1"), undefined); assert.equal(cache.get("0"), "svg");
  cache.set("new", "replacement"); assert.equal(cache.get("new"), "replacement");
  cache.set("big", "x".repeat(CACHE_BYTES - 3));
  assert.equal(cache.get("0"), undefined); assert.equal(cache.get("big")?.length, CACHE_BYTES - 3);
  cache.set("oversize", "x".repeat(CACHE_BYTES)); assert.equal(cache.get("oversize"), undefined);
  cache.clear(); assert.equal(cache.get("big"), undefined);
});
