import React, { act } from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { FACTORY_SETTINGS, resolveSettings, sanitizeUserSettings, type AppearanceSettings } from "../src/core/index.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";
import { AppearanceProvider, appearanceVars, resolveAppearance, useAppearance } from "../components/settings/appearance.tsx";
import { AppearanceSection } from "../components/settings/appearance-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

(globalThis as Record<string, unknown>).React = React;

it("code ligatures default OFF in factory, existing records, and both resolution paths", () => {
  assert.equal(FACTORY_SETTINGS.appearance.codeLigatures, false);
  for (const appearance of [undefined, {}, { proseFontSize: 20 }]) {
    assert.equal(resolveSettings({ version: 1, appearance }).appearance.codeLigatures, false);
    assert.equal(resolveAppearance(appearance).codeLigatures, false);
  }
  for (const codeLigatures of [true, false]) {
    const appearance = { codeLigatures, fontFamily: "Georgia", proseFontSize: 20 };
    const parsed = parseAppearanceSettingsBody(appearance);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.settings, appearance);
    const record = sanitizeUserSettings({ version: 1, appearance });
    assert.deepEqual(record?.appearance, appearance);
    assert.equal(resolveSettings(record).appearance.codeLigatures, codeLigatures);
    assert.equal(resolveAppearance(record?.appearance).codeLigatures, codeLigatures);
  }
});

it("invalid writes are rejected; invalid historical disk values are dropped, never coerced ON", () => {
  for (const value of [null, "true", "false", 0, 1, [], {}]) {
    const parsed = parseAppearanceSettingsBody({ codeLigatures: value });
    assert.equal(parsed.ok, false, JSON.stringify(value));
    if (!parsed.ok) assert.equal(parsed.error, "codeLigatures must be a boolean");
    const record = sanitizeUserSettings({ version: 1, appearance: { codeLigatures: value, proseFontSize: 20 } });
    assert.deepEqual(record?.appearance, { proseFontSize: 20 });
    assert.equal(resolveSettings(record).appearance.codeLigatures, false);
  }
});

it("the appearance mapping changes ONLY the shared code token, normal permits rather than forces ligatures", () => {
  const off = appearanceVars(resolveAppearance(undefined));
  const on = appearanceVars(resolveAppearance({ codeLigatures: true }));
  assert.equal(off["--lh-code-ligatures"], "none");
  assert.equal(on["--lh-code-ligatures"], "normal");
  assert.deepEqual(on, { ...off, "--lh-code-ligatures": "normal" });
  assert.deepEqual(appearanceVars(resolveAppearance({ codeLigatures: false })), off);
});

it("native inline/fenced code and both CodeMirror modes opt in without changing prose or diagrams", () => {
  const native = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const plugin = readFileSync(new URL("../plugins/coding-questions/src/styles.css", import.meta.url), "utf8");
  const rule = /([^{}]+)\{[^{}]*font-variant-ligatures:\s*var\(--lh-code-ligatures, none\);[^{}]*\}/g;
  const selectors = [...native.matchAll(rule)].map(match => match[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim());
  assert.deepEqual(selectors, ['[data-streamdown="inline-code"],\n[data-streamdown="code-block"] :is(pre, code)']);
  const pluginSelectors = [...plugin.matchAll(rule)].map(match => match[1]!.trim());
  assert.deepEqual(pluginSelectors, [".lh-coding-question .cm-scroller"]);
  assert.equal((native.match(/font-variant-ligatures:/g) ?? []).length, 1);
  assert.equal((plugin.match(/font-variant-ligatures:/g) ?? []).length, 1);
  assert.ok(!pluginSelectors[0]!.includes("contenteditable"), "the same rule covers editable and read-only editors");
});

it("the Appearance switch preserves siblings, applies immediately through the provider, and toggles back OFF", async () => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  const globals = globalThis as Record<string, unknown>;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string) => {
      assert.equal(url, "/api/settings");
      return new Response(JSON.stringify({ settings: { appearance: { proseFontSize: 20, fontFamily: "Georgia" } } }));
    },
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const writes: AppearanceSettings[] = [];
  function Panel() {
    const { appearance, onAppearanceChange } = useAppearance();
    return <AppearanceSection appearance={appearance} onSectionChange={next => { writes.push(next); onAppearanceChange(next); return true; }} />;
  }
  const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Code ligatures"]')!;
  const token = () => document.documentElement.style.getPropertyValue("--lh-code-ligatures");
  try {
    await act(async () => root.render(<InteractionLayersProvider><AppearanceProvider><Panel /></AppearanceProvider></InteractionLayersProvider>));
    assert.equal(toggle().getAttribute("aria-checked"), "false");
    assert.equal(token(), "none");
    assert.equal(document.querySelectorAll('[data-testid="row-code-ligatures"]').length, 1);
    const proseFont = document.documentElement.style.getPropertyValue("--font-prose");
    for (const value of [true, false, true]) {
      await act(async () => toggle().click());
      assert.equal(toggle().getAttribute("aria-checked"), String(value));
      assert.equal(token(), value ? "normal" : "none");
      assert.equal(writes.at(-1)?.codeLigatures, value);
      assert.equal(writes.at(-1)?.proseFontSize, 20);
      assert.equal(writes.at(-1)?.fontFamily, "Georgia");
      assert.equal(document.documentElement.style.getPropertyValue("--font-prose"), proseFont);
      assert.equal(document.documentElement.style.getPropertyValue("font-variant-ligatures"), "", "no global prose shaping override");
    }
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
});
