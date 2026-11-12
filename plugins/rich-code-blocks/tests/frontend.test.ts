import test from "node:test";
import assert from "node:assert/strict";
import type { PluginCodeBlockRenderer, PluginFrontendContext, PluginNotification, PluginSettingsSchema } from "learnharness-plugin-api";
import { activate } from "../src/main.ts";
import { DEFAULT_SETTINGS } from "../src/contract.ts";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const controller = new AbortController();
  const renderers = new Map<string, PluginCodeBlockRenderer>();
  const notifications = new Set<(event: PluginNotification) => void>(), reconnects = new Set<() => void>();
  let schema: PluginSettingsSchema | undefined;
  const calls: { operation: string; input: unknown; result: ReturnType<typeof deferred<unknown>> }[] = [];
  let cleanup!: () => void;
  const ctx = {
    signal: controller.signal, cleanup(fn: () => void) { cleanup = fn; },
    call(operation: string, input: unknown) { const result = deferred<unknown>(); calls.push({ operation, input, result }); return result.promise; },
    registerCodeBlock(value: PluginCodeBlockRenderer) { assert.ok(!renderers.has(value.language)); renderers.set(value.language, value); return () => { renderers.delete(value.language); }; },
    registerSettings(value: PluginSettingsSchema) { schema = value; return { update(value: PluginSettingsSchema) { schema = value; }, dispose() { schema = undefined; } }; },
    onNotification(fn: (event: PluginNotification) => void) { notifications.add(fn); return () => { notifications.delete(fn); }; },
    onResync(fn: () => void) { reconnects.add(fn); return () => { reconnects.delete(fn); }; },
  } as unknown as PluginFrontendContext;
  return { controller, renderers, notifications, reconnects, calls, get schema() { return schema; }, activate: () => activate(ctx), cleanup: () => cleanup(),
    publish(value: unknown) { notifications.forEach(fn => fn({ pluginId: "rich-code-blocks", topic: "settings-changed", data: value })); },
    reconnect() { reconnects.forEach(fn => fn()); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("all-off registrations and accepted cross-window revisions alone control families and settings", async () => {
  const host = fixture(); const activation = host.activate(); await flush();
  assert.equal(host.calls[0]!.operation, "get-settings"); host.calls[0]!.result.resolve(DEFAULT_SETTINGS); const dispose = await activation;
  assert.equal(host.renderers.size, 0); assert.deepEqual(host.schema!.rows.map(row => [row.label, row.value]), [["Chemical structures", false], ["Musical notation", false], ["Technical diagrams", false]]);
  const save = host.schema!.rows[0]!.onChange(true as never);
  assert.deepEqual(host.calls[1]!.input, { family: "chemicalStructures", enabled: true }); assert.equal(host.renderers.size, 0);
  host.calls[1]!.result.reject(new Error("disk failure")); await assert.rejects(Promise.resolve(save), /disk failure/);
  assert.equal(host.schema!.rows[0]!.value, false);
  host.publish({ ...DEFAULT_SETTINGS, revision: 2, chemicalStructures: true, technicalDiagrams: true });
  assert.deepEqual([...host.renderers.keys()], ["smiles", "tikz"]);
  host.reconnect(); await flush();
  host.publish({ ...DEFAULT_SETTINGS, revision: 3, musicalNotation: true });
  host.calls[2]!.result.resolve({ ...DEFAULT_SETTINGS, revision: 1, chemicalStructures: true }); await flush();
  assert.deepEqual([...host.renderers.keys()], ["abc"], "An older reconnect snapshot cannot roll back accepted settings.");
  dispose(); dispose(); assert.equal(host.renderers.size, 0); assert.equal(host.schema, undefined); assert.equal(host.notifications.size, 0); assert.equal(host.reconnects.size, 0);
});

test("legacy ink snapshots expose only family toggles and do not replace renderer registrations", async () => {
  const host = fixture(); const activation = host.activate(); await flush();
  host.calls[0]!.result.resolve({ ...DEFAULT_SETTINGS, technicalDiagrams: true, inkColor: "black" }); const dispose = await activation;
  const renderer = host.renderers.get("tikz");
  assert.deepEqual(host.schema!.rows.map(row => row.key), ["chemicalStructures", "musicalNotation", "technicalDiagrams"]);
  host.publish({ ...DEFAULT_SETTINGS, revision: 2, technicalDiagrams: true, inkColor: "white" });
  assert.equal(host.renderers.get("tikz"), renderer);
  assert.equal(host.schema!.rows.some(row => row.key === "inkColor"), false);
  host.publish({ ...DEFAULT_SETTINGS, revision: 1, technicalDiagrams: false, inkColor: "black" });
  assert.equal(host.renderers.get("tikz"), renderer, "older snapshots still cannot roll back family choices");
  assert.equal(host.calls.length, 1, "no ink write or extra settings read is needed");
  dispose();
});

test("a reconnect during an earlier snapshot gets its own fresh read; disable fences late activation", async () => {
  const host = fixture(); const activation = host.activate(); await flush(); host.reconnect();
  host.calls[0]!.result.resolve(DEFAULT_SETTINGS); await activation; await flush();
  assert.equal(host.calls.length, 2); host.calls[1]!.result.resolve({ ...DEFAULT_SETTINGS, revision: 1, musicalNotation: true }); await flush();
  assert.deepEqual([...host.renderers.keys()], ["abc"]); host.cleanup();
  const late = fixture(); const pending = late.activate(); await flush(); late.controller.abort(); late.cleanup();
  late.calls[0]!.result.resolve({ ...DEFAULT_SETTINGS, revision: 1, chemicalStructures: true }); const dispose = await pending;
  assert.equal(late.renderers.size, 0); assert.equal(late.schema, undefined); dispose();
});
