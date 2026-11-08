import assert from "node:assert/strict";
import { it } from "node:test";
import type { PluginAction, PluginActionContext, PluginFrontendContext, PluginNotification, PluginSettingsSchema, PluginSurfaceProps } from "learnharness-plugin-api";
import { activate } from "../src/main.ts";
function fixture() {
  const signal = new AbortController(), notifications = new Set<(event: PluginNotification) => void>(), events = new Set<(event: unknown) => void>(), resyncs = new Set<() => void>();
  const actions = new Map<string, PluginAction>(); let schema: PluginSettingsSchema | undefined, surface: PluginSurfaceProps | undefined;
  let closes = 0, disposedSettings = 0;
  let read: () => unknown | Promise<unknown> = () => ({ revision: 0, inkColor: "#facc15" });
  const ctx = {
    manifest: { id: "drawing-pad" }, signal: signal.signal, cleanup() {},
    registerAction(action: PluginAction) { actions.set(action.id, action); return () => { actions.delete(action.id); }; },
    placeAction() { return () => {}; }, registerSubmissionInterceptor() { return () => {}; }, refreshActions() {}, refreshSubmissions() {},
    registerSettings(value: PluginSettingsSchema) { schema = value; return { update(value: PluginSettingsSchema) { schema = value; }, dispose() { disposedSettings++; schema = undefined; } }; },
    async call(name: string) { if (name === "get-settings") return await read(); if (name === "set-ink-color") return { revision: 1, inkColor: "#ffffff", imageScale: 50 }; if (name === "set-image-scale") return { revision: 3, inkColor: "#ffffff", imageScale: 25 }; throw new Error(name); },
    onNotification(fn: (event: PluginNotification) => void) { notifications.add(fn); return () => notifications.delete(fn); },
    onAppEvent(fn: (event: unknown) => void) { events.add(fn); return () => events.delete(fn); },
    onResync(fn: () => void) { resyncs.add(fn); return () => resyncs.delete(fn); },
    app: { pathname: () => "/opaque-path" },
    ui: { openSurface(_target: unknown, props: PluginSurfaceProps) { surface = props; return { update() {}, dispose() { closes++; surface = undefined; } }; } },
  } as unknown as PluginFrontendContext;
  return { ctx, actions, signal, notifications, events, resyncs,
    schema: () => schema, surface: () => surface, closes: () => closes, disposedSettings: () => disposedSettings,
    setRead(fn: typeof read) { read = fn; },
    notify(value: unknown) { for (const fn of notifications) fn({ pluginId: "drawing-pad", topic: "settings-changed", data: value }); },
  };
}
it("frontend activates without browser globals and registers controlled color and scale settings", async () => {
  const f = fixture(), off = await activate(f.ctx);
  try {
    assert.equal(f.actions.get("draw")!.name, "Draw"); assert.equal(f.schema()!.rows.length, 2);
    const row = f.schema()!.rows[0]!; assert.equal(row.type, "text"); assert.equal(row.label, "Ink color"); assert.equal(row.value, "#facc15");
    assert.ok(row.validate?.("invalid" as never));
    const scale = f.schema()!.rows[1]!; assert.equal(scale.type, "number"); assert.equal(scale.label, "Image scale"); assert.equal(scale.value, 50);
    assert.ok(scale.validate?.(0 as never)); assert.equal(scale.validate?.(25 as never), undefined);
    await scale.onChange(25 as never); assert.equal(f.schema()!.rows[1]!.value, 25);
  } finally { off(); }
});
it("older settings notifications/reads cannot replace a newer accepted value", async () => {
  const f = fixture(), off = await activate(f.ctx);
  try {
    f.notify({ revision: 2, inkColor: "#ffffff", imageScale: 25 }); f.notify({ revision: 1, inkColor: "#000000", imageScale: 100 });
    assert.equal(f.schema()!.rows[1]!.value, 25);
    assert.equal(f.schema()!.rows[0]!.value, "#ffffff");
    f.setRead(() => ({ revision: 0, inkColor: "#facc15" }));
    for (const fn of f.resyncs) fn(); await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.equal(f.schema()!.rows[0]!.value, "#ffffff"); assert.equal(f.schema()!.rows[1]!.value, 25);
  } finally { off(); }
});
it("Draw declares the approved session shortcut and keyboard invocation toggles the same surface", async () => {
  const f = fixture(), off = await activate(f.ctx);
  try {
    const draw = f.actions.get("draw")!, undo = f.actions.get("undo")!, toggle = f.actions.get("toggle-pen-eraser")!;
    assert.deepEqual(draw.shortcut, { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+d" });
    assert.deepEqual(undo.shortcut, { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+z" });
    assert.deepEqual(toggle.shortcut, { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+e" });
    const hand = f.actions.get("hand")!;
    assert.deepEqual(hand.shortcut, { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+h" });
    const context = { placement: "keyboard", surface: "session", sessionId: "a", kind: "teaching", surfaceTarget: {},
      view: { messages: [], input: { type: "unavailable" } } } as unknown as PluginActionContext;
    const disabled = undo.disabled as (context: PluginActionContext) => boolean;
    assert.equal((toggle.disabled as (context: PluginActionContext) => boolean)(context), true);
    await toggle.run(context);
    assert.equal((hand.disabled as (context: PluginActionContext) => boolean)(context), true); await hand.run(context);
    assert.equal(disabled(context), true); await undo.run(context); assert.equal(f.surface(), undefined);
    await draw.run(context); assert.equal(f.surface()?.title, "Drawing pad");
    assert.equal(disabled(context), true, "an unmounted/not-ready surface cannot claim drawing Undo");
    await draw.run(context); assert.equal(f.surface(), undefined); assert.equal(f.closes(), 1);
    assert.equal(disabled({ placement: "keyboard", surface: "app", pathname: "/" }), true);
    assert.equal((hand.disabled as (context: PluginActionContext) => boolean)({ placement: "keyboard", surface: "app", pathname: "/" }), true);
  } finally { off(); }
});
it("disposal removes registrations/listeners exactly once", async () => {
  const f = fixture(), off = await activate(f.ctx); off(); off();
  assert.equal(f.actions.size, 0); assert.equal(f.notifications.size, 0); assert.equal(f.events.size, 0); assert.equal(f.resyncs.size, 0);
  assert.equal(f.disposedSettings(), 1);
});
it("late initial settings after activation cancellation cannot create UI registrations", async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.setRead(() => new Promise(resolve => { finish = resolve; }));
  const activating = activate(f.ctx); await new Promise<void>(resolve => queueMicrotask(resolve));
  f.signal.abort(); finish({ revision: 0, inkColor: "#facc15" }); const off = await activating;
  assert.equal(f.actions.size, 0); assert.equal(f.schema(), undefined); off();
});
