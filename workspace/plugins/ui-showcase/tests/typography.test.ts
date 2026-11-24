import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { example, family, note, readout, Scope } from "../src/dom.ts";
import { createFixture } from "./fixture.ts";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, selector);
  return match[1]!;
}

test("showcase explanatory copy follows appearance reading tokens without changing the gallery baseline", () => {
  const prose = rule(".ui-showcase-note");
  assert.match(prose, /font-family:\s*var\(--font-prose\)/);
  assert.match(prose, /font-size:\s*var\(--lh-prose-size\)/);
  assert.match(prose, /line-height:\s*var\(--lh-prose-leading\)/);
  assert.doesNotMatch(rule(".ui-showcase"), /font(?:-family|-size)?\s*:/);
  for (const selector of [".ui-showcase-heading", ".ui-showcase-label", ".ui-showcase-state"]) {
    assert.doesNotMatch(rule(selector), /font-size:|font-weight:|line-height:/, `${selector}: use canonical UI utilities`);
  }
});

test("headings use compact settings chrome and labels/readouts use the UI ladder", () => {
  const f = createFixture();
  const scope = new Scope(f.controller.signal);
  try {
    note(f.root, "Reading explanation");
    family(f.ui, f.root, scope, "typography", "Compact heading", (body) => {
      example(body, "fixture", "Compact label");
      readout(body, "typography")({ local: true });
    });
    for (const [selector, tokens] of [
      ["h2", ["font-ui", "text-sm", "uppercase", "tracking-widest"]],
      [".ui-showcase-label", ["font-ui", "text-xs"]],
      [".ui-showcase-state", ["font-ui", "text-xs"]],
    ] as const) {
      const node = f.root.querySelector(selector)!;
      assert.ok(node, selector);
      for (const token of tokens) assert.ok(node.classList.contains(token), `${selector}: ${token}`);
    }
    assert.equal(f.root.querySelector(".lh-prose"), null, "no gallery-wide prose inheritance");
    assert.equal(f.root.querySelector(".ui-showcase-note")!.textContent, "Reading explanation");
    assert.equal(f.root.querySelector('[data-example="fixture"] > div:last-child')!.className, "", "widget slot stays neutral");
  } finally { scope.dispose(); f.restore(); }
});

test("session surface styling is transparent while the gallery retains its background", () => {
  assert.match(rule(".ui-showcase-surface"), /background:\s*transparent/);
  assert.match(rule(".ui-showcase"), /background:\s*var\(--background\)/);
});
