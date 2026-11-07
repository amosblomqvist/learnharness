import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { colorError, imageScaleError, parseColor, parseImageScale, parseSettings } from "../src/settings.ts";

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
it("validates stored settings and does not coerce revisions", () => {
  assert.deepEqual(parseSettings({ revision: 3, inkColor: "#ABCDEF" }), { revision: 3, inkColor: "#abcdef", imageScale: 50 });
  for (const revision of [-1, .5, "1", Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseSettings({ revision, inkColor: "#facc15" }));
  assert.throws(() => parseSettings({ revision: 0, inkColor: "#facc15", draft: [] }));
});
it("loads defaults without creating any data or draft file", () => {
  const f = fixture(); try {
    f.start(); assert.deepEqual(f.call("get-settings"), { revision: 0, inkColor: "#facc15", imageScale: 50 }); assert.equal(fs.existsSync(f.directory), false);
  } finally { f.close(); }
});
it("persists accepted preferences atomically and emits only accepted snapshots", () => {
  const f = fixture(); try {
    f.start(); const result = f.call("set-ink-color", { inkColor: "#ABCDEF" });
    assert.deepEqual(result, { revision: 1, inkColor: "#abcdef", imageScale: 50 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, "settings.json"), "utf8")), result);
    assert.deepEqual(fs.readdirSync(f.directory), ["settings.json"]); assert.equal(f.events.length, 1);
    assert.deepEqual(f.call("set-ink-color", { inkColor: "#abcdef" }), result); assert.equal(f.events.length, 1);
    f.stop(); f.start(); assert.deepEqual(f.call("get-settings"), result);
  } finally { f.close(); }
});
it("invalid writes do not publish or persist changes", () => {
  const f = fixture(); try {
    f.start(); for (const input of [null, {}, { inkColor: "#abc" }, { inkColor: "#ffffff", draft: {} }]) assert.throws(() => f.call("set-ink-color", input));
    assert.equal(fs.existsSync(f.directory), false); assert.equal(f.events.length, 0);
    assert.deepEqual(f.call("get-settings"), { revision: 0, inkColor: "#facc15", imageScale: 50 });
  } finally { f.close(); }
});
it("write failures retain the accepted color and publish no success", () => {
  const f = fixture(); try {
    f.start(); fs.writeFileSync(f.directory, "not a directory");
    assert.throws(() => f.call("set-ink-color", { inkColor: "#ffffff" }));
    assert.equal(f.events.length, 0); assert.deepEqual(f.call("get-settings"), { revision: 0, inkColor: "#facc15", imageScale: 50 });
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
    assert.throws(() => parseSettings({ revision: 0, inkColor: "#facc15", imageScale: value }));
  }
  for (const value of [.5, 25, 50, 100]) assert.equal(parseImageScale(value), value);
});
it("reads legacy color preferences as 50 percent without overwriting the existing file", () => {
  const f = fixture(); try {
    fs.mkdirSync(f.directory); const file = path.join(f.directory, "settings.json"), legacy = '{"revision":4,"inkColor":"#abcdef"}\n';
    fs.writeFileSync(file, legacy); f.start();
    assert.deepEqual(f.call("get-settings"), { revision: 4, inkColor: "#abcdef", imageScale: 50 });
    assert.equal(fs.readFileSync(file, "utf8"), legacy);
    f.call("set-image-scale", { imageScale: 25 }); f.call("set-ink-color", { inkColor: "#ffffff" });
    const expected = { revision: 6, inkColor: "#ffffff", imageScale: 25 };
    assert.deepEqual(f.call("get-settings"), expected); f.stop(); f.start(); assert.deepEqual(f.call("get-settings"), expected);
  } finally { f.close(); }
});
it("scale changes persist atomically, preserve color, and refuse invalid writes or I/O failures", () => {
  const f = fixture(); try {
    f.start();
    for (const input of [null, {}, { imageScale: 0 }, { imageScale: 50, extra: true }]) assert.throws(() => f.call("set-image-scale", input));
    assert.equal(fs.existsSync(f.directory), false); assert.equal(f.events.length, 0);
    const value = f.call("set-image-scale", { imageScale: 12.5 });
    assert.deepEqual(value, { revision: 1, inkColor: "#facc15", imageScale: 12.5 });
    assert.deepEqual(f.call("set-image-scale", { imageScale: 12.5 }), value); assert.equal(f.events.length, 1);
    fs.rmSync(f.directory, { recursive: true }); fs.writeFileSync(f.directory, "blocked");
    assert.throws(() => f.call("set-image-scale", { imageScale: 50 }));
    assert.deepEqual(f.call("get-settings"), value); assert.equal(f.events.length, 1);
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
