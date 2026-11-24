import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { colorError, imageScaleError, parseColor, parseColorChange, parseImageScale, parseSettings } from "../src/settings.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-pad-test-"));
  const directory = path.join(root, "data"), controller = new AbortController();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const events: unknown[] = [], records = new Map<string, unknown>();
  const ctx = { dataDirectory: directory, signal: controller.signal,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    events: { emit(topic: string, data: unknown) { events.push({ topic, data }); } },
    learning: { getSession(id: string) { return records.get(id) ?? null; } },
  } as unknown as PluginBackendContext;
  let off: (() => void) | undefined;
  return { directory, events, records, controller, handlers,
    start() { off = activate(ctx); },
    call(name: string, input?: unknown) { return handlers.get(name)!(input); },
    stop() { off?.(); },
    close() { off?.(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
it("accepts only six-digit hex colors and normalizes case", () => {
  assert.equal(parseColor("#FaCc15"), "#facc15");
  for (const value of ["#abc", "#ffffffff", "facc15", " #facc15", "red", "var(--ink)", "#facc15;", 1, null]) {
    assert.ok(colorError(value)); assert.throws(() => parseColor(value));
  }
});
it("validates both stored colors and does not coerce revisions", () => {
  const colors = { darkInkColor: "#ABCDEF", lightInkColor: "#FEDCBA" };
  assert.deepEqual(parseSettings({ revision: 3, ...colors }), { revision: 3, darkInkColor: "#abcdef", lightInkColor: "#fedcba", imageScale: 50 });
  for (const revision of [-1, .5, "1", Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseSettings({ revision, ...colors }));
  assert.throws(() => parseSettings({ revision: 0, ...colors, draft: [] }));
  for (const field of ["darkInkColor", "lightInkColor"] as const) {
    for (const value of ["#abc", "#ffffffff", "ffffff", "red", " #ffffff", "#ffffff;", 1, null, undefined]) {
      assert.throws(() => parseSettings({ revision: 0, ...colors, [field]: value }));
      assert.throws(() => parseColorChange({ [field]: value }));
    }
  }
  assert.deepEqual(parseColorChange({ darkInkColor: "#ABCDEF" }), { darkInkColor: "#abcdef" });
  assert.deepEqual(parseColorChange({ lightInkColor: "#FEDCBA" }), { lightInkColor: "#fedcba" });
});
it("loads defaults without creating any data or draft file", () => {
  const f = fixture(); try {
    f.start(); assert.deepEqual(f.call("get-settings"), { revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 });
    assert.equal(fs.existsSync(f.directory), false); assert.deepEqual(f.events, []);
  } finally { f.close(); }
});
for (const field of ["darkInkColor", "lightInkColor"] as const) {
  it(`persists ${field} independently and emits only accepted snapshots`, () => {
    const f = fixture(); try {
      f.start(); const result = f.call("set-ink-color", { [field]: "#ABCDEF" });
      assert.deepEqual(result, { revision: 1, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50, [field]: "#abcdef" });
      const file = path.join(f.directory, "settings.json"), saved = fs.readFileSync(file, "utf8");
      assert.deepEqual(JSON.parse(saved), result);
      assert.deepEqual(fs.readdirSync(f.directory), ["settings.json"]);
      assert.deepEqual(f.events, [{ topic: "settings-changed", data: result }]);
      assert.deepEqual(f.call("set-ink-color", { [field]: "#ABCDEF" }), result);
      assert.equal(fs.readFileSync(file, "utf8"), saved); assert.equal(f.events.length, 1);
      f.stop(); f.start(); assert.deepEqual(f.call("get-settings"), result);
      assert.equal(f.events.length, 1);
    } finally { f.close(); }
  });
}
it("requires exactly one theme color and never publishes or persists invalid writes", () => {
  const f = fixture(); try {
    f.start();
    const invalid = [null, [], {}, { inkColor: "#ffffff" }, { darkInkColor: "#ffffff", lightInkColor: "#000000" },
      { darkInkColor: "#ffffff", inkColor: "#abcdef" }, { lightInkColor: "#000000", inkColor: "#abcdef" },
      { darkInkColor: "#abc" }, { lightInkColor: "red" }, { darkInkColor: "#ffffff", draft: {} },
      { lightInkColor: "#000000", imageScale: 50 }];
    for (const input of invalid) {
      assert.throws(() => parseColorChange(input));
      assert.throws(() => f.call("set-ink-color", input));
    }
    assert.equal(fs.existsSync(f.directory), false); assert.equal(f.events.length, 0);
    assert.deepEqual(f.call("get-settings"), { revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 });
    const accepted = f.call("set-ink-color", { lightInkColor: "#123456" });
    const file = path.join(f.directory, "settings.json"), saved = fs.readFileSync(file, "utf8");
    for (const input of invalid) assert.throws(() => f.call("set-ink-color", input));
    assert.deepEqual(f.call("get-settings"), accepted); assert.equal(fs.readFileSync(file, "utf8"), saved); assert.equal(f.events.length, 1);
  } finally { f.close(); }
});
it("write failures retain both accepted colors and publish no success", () => {
  const f = fixture(); try {
    f.start(); fs.writeFileSync(f.directory, "not a directory");
    for (const field of ["darkInkColor", "lightInkColor"]) assert.throws(() => f.call("set-ink-color", { [field]: "#abcdef" }));
    assert.equal(f.events.length, 0);
    assert.deepEqual(f.call("get-settings"), { revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 });
    fs.rmSync(f.directory); fs.mkdirSync(path.join(f.directory, "settings.json"), { recursive: true });
    assert.throws(() => f.call("set-ink-color", { darkInkColor: "#abcdef" }));
    assert.deepEqual(fs.readdirSync(f.directory), ["settings.json"]); assert.equal(f.events.length, 0);
    assert.deepEqual(f.call("get-settings"), { revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 });
  } finally { f.close(); }
});
it("malformed stored preferences fail rather than silently overwrite user data", () => {
  const f = fixture(); try {
    fs.mkdirSync(f.directory); const file = path.join(f.directory, "settings.json"); fs.writeFileSync(file, "broken");
    assert.throws(() => f.start()); assert.equal(fs.readFileSync(file, "utf8"), "broken");
  } finally { f.close(); }
});
it("validates a positive downscaling percentage, including fractions, without coercion", () => {
  for (const value of [0, -1, 101, Infinity, NaN, "50", null, undefined]) {
    assert.ok(imageScaleError(value)); assert.throws(() => parseImageScale(value));
    assert.throws(() => parseSettings({ revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: value }));
  }
  for (const value of [.5, 25, 50, 100]) assert.equal(parseImageScale(value), value);
});
it("rejects legacy, mixed, and incomplete color schemas without overwriting stored data", () => {
  for (const input of [
    { revision: 4, inkColor: "#abcdef" }, { revision: 4, inkColor: "#abcdef", imageScale: 25 },
    { revision: 4, darkInkColor: "#ffffff", lightInkColor: "#000000", inkColor: "#abcdef", imageScale: 50 },
    { revision: 4, darkInkColor: "#ffffff" }, { revision: 4, lightInkColor: "#000000" }, { revision: 4 },
  ]) {
    const f = fixture(); try {
      fs.mkdirSync(f.directory); const file = path.join(f.directory, "settings.json"), saved = JSON.stringify(input) + "\n";
      fs.writeFileSync(file, saved);
      assert.throws(() => parseSettings(input)); assert.throws(() => f.start());
      assert.equal(fs.readFileSync(file, "utf8"), saved); assert.equal(f.handlers.size, 0); assert.equal(f.events.length, 0);
    } finally { f.close(); }
  }
});
it("keeps no-op revisions at the limit and refuses changes before writing or notifying", () => {
  const f = fixture(); try {
    fs.mkdirSync(f.directory); const file = path.join(f.directory, "settings.json");
    const settings = { revision: Number.MAX_SAFE_INTEGER, darkInkColor: "#abcdef", lightInkColor: "#123456", imageScale: 25 };
    const saved = JSON.stringify(settings) + "\n"; fs.writeFileSync(file, saved); f.start();
    for (const field of ["darkInkColor", "lightInkColor"] as const) {
      assert.deepEqual(f.call("set-ink-color", { [field]: settings[field].toUpperCase() }), settings);
      assert.throws(() => f.call("set-ink-color", { [field]: "#fedcba" }), /revision limit/);
    }
    assert.deepEqual(f.call("set-image-scale", { imageScale: 25 }), settings);
    assert.throws(() => f.call("set-image-scale", { imageScale: 50 }), /revision limit/);
    assert.deepEqual(f.call("get-settings"), settings); assert.equal(fs.readFileSync(file, "utf8"), saved);
    assert.deepEqual(fs.readdirSync(f.directory), ["settings.json"]); assert.equal(f.events.length, 0);
  } finally { f.close(); }
});
it("scale changes persist atomically, preserve independent colors, and refuse invalid writes or I/O failures", () => {
  const f = fixture(); try {
    f.start();
    for (const input of [null, {}, { imageScale: 0 }, { imageScale: 50, extra: true }, { imageScale: 50, darkInkColor: "#abcdef" }])
      assert.throws(() => f.call("set-image-scale", input));
    assert.equal(fs.existsSync(f.directory), false); assert.equal(f.events.length, 0);
    f.call("set-ink-color", { darkInkColor: "#abcdef" }); f.call("set-ink-color", { lightInkColor: "#123456" });
    const value = f.call("set-image-scale", { imageScale: 12.5 });
    assert.deepEqual(value, { revision: 3, darkInkColor: "#abcdef", lightInkColor: "#123456", imageScale: 12.5 });
    const file = path.join(f.directory, "settings.json"), saved = fs.readFileSync(file, "utf8");
    assert.deepEqual(JSON.parse(saved), value); assert.deepEqual(fs.readdirSync(f.directory), ["settings.json"]);
    assert.deepEqual(f.events, [
      { topic: "settings-changed", data: { revision: 1, darkInkColor: "#abcdef", lightInkColor: "#000000", imageScale: 50 } },
      { topic: "settings-changed", data: { revision: 2, darkInkColor: "#abcdef", lightInkColor: "#123456", imageScale: 50 } },
      { topic: "settings-changed", data: value },
    ]);
    assert.deepEqual(f.call("set-image-scale", { imageScale: 12.5 }), value);
    assert.equal(fs.readFileSync(file, "utf8"), saved); assert.equal(f.events.length, 3);
    f.stop(); f.start(); assert.deepEqual(f.call("get-settings"), value);
    const changed = f.call("set-ink-color", { darkInkColor: "#fedcba" });
    assert.deepEqual(changed, { revision: 4, darkInkColor: "#fedcba", lightInkColor: "#123456", imageScale: 12.5 });
    fs.rmSync(f.directory, { recursive: true }); fs.writeFileSync(f.directory, "blocked");
    assert.throws(() => f.call("set-image-scale", { imageScale: 50 }));
    assert.deepEqual(f.call("get-settings"), changed); assert.equal(f.events.length, 4);
  } finally { f.close(); }
});
it("exposes read-only pose identities, never solutions or learner input", () => {
  const f = fixture(); try {
    f.records.set("a", { kind: "practice", messages: [
      { role: "assistant", id: "m", content: [{ type: "toolCall", name: "problem", id: "p", arguments: { statement: "secret", modelSolution: "secret" } }] },
      { role: "toolResult", toolName: "problem", toolCallId: "p" },
    ] }); f.start();
    assert.deepEqual(f.call("get-session-poses", { sessionId: "a" }), { sessionId: "a", poses: ['["m",0,"p","problem"]'] });
    assert.equal(fs.existsSync(f.directory), false); assert.equal(f.events.length, 0);
    for (const input of [null, { sessionId: "../a" }, { sessionId: "a", extra: 1 }]) assert.throws(() => f.call("get-session-poses", input));
  } finally { f.close(); }
});
it("cleanup is idempotent and captured operations refuse after disable", () => {
  const f = fixture(); try {
    f.start(); const operation = f.handlers.get("get-settings")!; f.stop(); f.stop();
    assert.equal(f.handlers.size, 0); assert.throws(() => operation(undefined), /disabled/);
  } finally { f.close(); }
});
