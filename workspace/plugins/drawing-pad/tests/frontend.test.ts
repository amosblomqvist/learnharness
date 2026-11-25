import assert from "node:assert/strict";
import { it } from "node:test";
import type { PluginAction, PluginActionContext, PluginFrontendContext, PluginNotification, PluginSettingsSchema, PluginSurfaceProps } from "learnharness-plugin-api";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { activate } from "../src/main.ts";
import type { SessionSheet, Sheets } from "../src/state.ts";
import type { Stroke } from "../src/strokes.ts";
import { appPalette } from "../src/theme.ts";
function fixture() {
  const signal = new AbortController(), notifications = new Set<(event: PluginNotification) => void>(), events = new Set<(event: unknown) => void>(), resyncs = new Set<() => void>();
  const actions = new Map<string, PluginAction>(); let schema: PluginSettingsSchema | undefined, surface: PluginSurfaceProps | undefined;
  let closes = 0, disposedSettings = 0;
  let saved = { revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 };
  const calls: { name: string; value: unknown }[] = [];
  let read: () => unknown | Promise<unknown> = () => ({ ...saved });
  const ctx = {
    manifest: { id: "drawing-pad" }, signal: signal.signal, cleanup() {},
    registerAction(action: PluginAction) { actions.set(action.id, action); return () => { actions.delete(action.id); }; },
    placeAction() { return () => {}; }, registerSubmissionInterceptor() { return () => {}; }, refreshActions() {}, refreshSubmissions() {},
    registerSettings(value: PluginSettingsSchema) { schema = value; return { update(value: PluginSettingsSchema) { schema = value; }, dispose() { disposedSettings++; schema = undefined; } }; },
    async call(name: string, value: unknown) {
      calls.push({ name, value });
      if (name === "get-settings") return await read();
      if (name === "set-ink-color" || name === "set-image-scale") {
        saved = { ...saved, ...(value as Partial<typeof saved>), revision: saved.revision + 1 };
        return { ...saved };
      }
      throw new Error(name);
    },
    onNotification(fn: (event: PluginNotification) => void) { notifications.add(fn); return () => notifications.delete(fn); },
    onAppEvent(fn: (event: unknown) => void) { events.add(fn); return () => events.delete(fn); },
    onResync(fn: () => void) { resyncs.add(fn); return () => resyncs.delete(fn); },
    app: { pathname: () => "/opaque-path" },
    ui: { openSurface(_target: unknown, props: PluginSurfaceProps) { surface = props; return { update() {}, dispose() { closes++; surface = undefined; } }; } },
  } as unknown as PluginFrontendContext;
  return { ctx, actions, signal, notifications, events, resyncs, calls,
    schema: () => schema, surface: () => surface, closes: () => closes, disposedSettings: () => disposedSettings,
    setRead(fn: typeof read) { read = fn; },
    notify(value: unknown) { for (const fn of notifications) fn({ pluginId: "drawing-pad", topic: "settings-changed", data: value }); },
  };
}
it("frontend activates without browser globals and registers controlled color and scale settings", async () => {
  const f = fixture(), off = await activate(f.ctx);
  try {
    assert.equal(f.actions.get("draw")!.name, "Draw"); assert.equal(f.schema()!.rows.length, 3);
    assert.deepEqual(f.schema()!.rows.map(row => [row.type, row.label, row.value]), [
      ["text", "Dark mode ink color", "#ffffff"], ["text", "Light mode ink color", "#000000"], ["number", "Image scale", 50],
    ]);
    for (const [index, key, color] of [[0, "darkInkColor", "#123456"], [1, "lightInkColor", "#abcdef"]] as const) {
      const row = f.schema()!.rows[index]!;
      assert.ok(row.validate?.("invalid" as never)); assert.equal(row.validate?.(color as never), undefined);
      await row.onChange(color as never);
      assert.deepEqual(f.calls.at(-1), { name: "set-ink-color", value: { [key]: color } });
      assert.equal(f.schema()!.rows[index]!.value, color);
    }
    const scale = f.schema()!.rows[2]!;
    assert.ok(scale.validate?.(0 as never)); assert.equal(scale.validate?.(25 as never), undefined);
    await scale.onChange(25 as never); assert.equal(f.schema()!.rows[2]!.value, 25);
    assert.deepEqual(f.schema()!.rows.slice(0, 2).map(row => row.value), ["#123456", "#abcdef"]);
  } finally { off(); }
});
it("older settings notifications/reads cannot replace a newer accepted value", async () => {
  const f = fixture(), off = await activate(f.ctx);
  try {
    f.notify({ revision: 2, darkInkColor: "#123456", lightInkColor: "#abcdef", imageScale: 25 });
    f.notify({ revision: 1, darkInkColor: "#000000", lightInkColor: "#ffffff", imageScale: 100 });
    assert.deepEqual(f.schema()!.rows.map(row => row.value), ["#123456", "#abcdef", 25]);
    f.setRead(() => ({ revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 }));
    for (const fn of f.resyncs) fn(); await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.deepEqual(f.schema()!.rows.map(row => row.value), ["#123456", "#abcdef", 25]);
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
  f.signal.abort(); finish({ revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 }); const off = await activating;
  assert.equal(f.actions.size, 0); assert.equal(f.schema(), undefined); off();
});

// Host refresh economy. Only browser mounting and PNG export are replaced (as in
// theme-races.test.ts) so the real Sheets instance can be driven directly.
const project = fileURLToPath(new URL("../", import.meta.url));
const refreshBundle = await build({ stdin: { contents: `export {activate} from ${JSON.stringify(path.join(project, "src/main.ts"))};`,
  resolveDir: project, loader: "ts" }, bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "controlled-mount-and-export", setup(builder) {
    builder.onLoad({ filter: /\/src\/capture\.ts$/ }, () => ({ loader: "js", contents: `
      export const exportSheet=async()=>({type:'image',mimeType:'image/png',data:'controlled-png'});
      export const captureBackground=async()=>{throw new Error('not used');};` }));
    builder.onLoad({ filter: /\/src\/sheet\.ts$/ }, () => ({ loader: "js", contents: `
      export const mountSheet=(_container,_ctx,sheets,state)=>{Object.assign(globalThis.__drawingRefreshProbe,{sheets,state});
        return {flush(){},dispose(){},canUseEditingShortcuts(){return false},canUndo(){return false},undo(){},togglePenEraser(){},selectHand(){}};};` }));
  } }] });
const { activate: activateControlled } = await import(`data:text/javascript;base64,${Buffer.from(refreshBundle.outputFiles[0]!.text).toString("base64")}`) as {
  activate: typeof import("../src/main.ts").activate;
};
async function refreshFixture(kind: "teaching" | "practice") {
  const probe = { sheets: undefined as Sheets | undefined, state: undefined as SessionSheet | undefined };
  Object.defineProperty(globalThis, "__drawingRefreshProbe", { configurable: true, value: probe });
  const actions = new Map<string, PluginAction>(), appEvents = new Set<(event: unknown) => void>(), owner = new AbortController();
  let interceptor!: Parameters<PluginFrontendContext["registerSubmissionInterceptor"]>[0], poses: string[] = [];
  const refreshes = { actions: 0, submissions: 0 };
  const ctx = {
    manifest: { id: "drawing-pad" }, signal: owner.signal, cleanup() {},
    refreshActions() { refreshes.actions++; }, refreshSubmissions() { refreshes.submissions++; },
    app: { pathname: () => "/controlled-session" }, onNotification() { return () => {}; },
    onAppEvent(fn: (event: unknown) => void) { appEvents.add(fn); return () => appEvents.delete(fn); }, onResync() { return () => {}; },
    registerSettings() { return { update() {}, dispose() {} }; },
    registerAction(value: PluginAction) { actions.set(value.id, value); return () => actions.delete(value.id); }, placeAction() { return () => {}; },
    registerSubmissionInterceptor(value: typeof interceptor) { interceptor = value; return () => {}; },
    ui: { openSurface(_target: unknown, props: { content: (container: HTMLElement, signal: AbortSignal) => unknown }) {
      props.content({} as HTMLElement, owner.signal); return { update() {}, dispose() {} }; } },
    async call(name: string) {
      if (name === "get-settings") return { revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 };
      if (name === "get-session-poses") return { sessionId: "s", poses };
      throw new Error(name);
    },
  } as unknown as PluginFrontendContext;
  const off = await activateControlled(ctx);
  await actions.get("draw")!.run({ surface: "session", surfaceTarget: {}, sessionId: "s", kind, view: { messages: [], input: { type: "text" } } } as never);
  const sheets = probe.sheets!, state = probe.state!;
  const create = () => sheets.create(state, { background: "", backgroundColor: "#141414", width: 0, height: 0, pixelRatio: 1, palette: appPalette().key });
  create();
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { sheets, state, actions, off, create,
    pairs() { assert.equal(refreshes.actions, refreshes.submissions, "refreshActions and refreshSubmissions stay paired"); return refreshes.actions; },
    reset() { refreshes.actions = 0; refreshes.submissions = 0; },
    draw(x: number): Stroke { const stroke: Stroke = { tool: "pen", points: [{ x, y: 10, pressure: .5 }, { x: x + 5, y: 12, pressure: .5 }] };
      sheets.update(state, [...state.draft!.strokes, stroke]); return stroke; },
    setPoses(next: string[]) { poses = next; },
    async event(type: string) { for (const fn of appEvents) fn({ type, chatId: "s" }); await settle(); },
    async send() {
      const accepted: (() => void)[] = [];
      await interceptor.intercept({ type: "text", content: { text: "controlled", images: [] } } as never,
        { sessionId: "s", signal: owner.signal, messages: [], onAccepted(fn: () => void) { accepted.push(fn); } } as never);
      for (const fn of accepted) fn();
    },
  };
}
it("teaching: only the first stroke, and Undo back to empty, refresh the host; later strokes, pans and tool switches do not", async () => {
  const f = await refreshFixture("teaching");
  try {
    f.reset(); f.draw(0); assert.equal(f.pairs(), 1, "first stroke on an empty sheet"); assert.equal(f.actions.get("draw")!.name, "Draw (unsent)");
    f.reset(); for (let i = 2; i <= 20; i++) f.draw(i * 10); assert.equal(f.pairs(), 0, "strokes 2-20");
    for (let i = 0; i < 50; i++) f.sheets.setPan(f.state, { x: i, y: -i });
    for (const tool of ["eraser", "hand", "pen"] as const) f.sheets.setTool(f.state, tool);
    assert.equal(f.pairs(), 0, "pan x50 and tool switches");
    for (let i = 0; i < 19; i++) f.sheets.undo(f.state); assert.equal(f.pairs(), 0);
    f.sheets.undo(f.state); assert.equal(f.pairs(), 1, "undo back to empty"); assert.equal(f.actions.get("draw")!.name, "Draw");
  } finally { f.off(); }
});
it("practice: sending, the next stroke, and Undo back to the sent drawing each refresh the host once", async () => {
  const f = await refreshFixture("practice");
  try {
    f.draw(0); f.reset();
    await f.send(); assert.equal(f.sheets.pending(f.state), false); assert.equal(f.pairs(), 1, "send accepted");
    f.reset(); f.draw(40); assert.equal(f.sheets.pending(f.state), true); assert.equal(f.pairs(), 1, "next stroke");
    f.reset(); f.sheets.undo(f.state); assert.equal(f.sheets.pending(f.state), false); assert.equal(f.pairs(), 1, "undo back to the sent drawing");
  } finally { f.off(); }
});
it("practice: a silently backfilled pose reaches the host with the next stroke", async () => {
  const f = await refreshFixture("practice");
  try {
    f.setPoses(["pose2"]); await f.event("turn-settled"); assert.equal(f.state.draft, undefined, "an accepted new problem resets the sheet");
    f.create(); f.draw(0);
    f.reset(); f.draw(20); assert.equal(f.pairs(), 0);
    f.setPoses(["pose1", "pose2"]); await f.event("turn-settled"); assert.equal(f.state.seenPoses.size, 2); assert.equal(f.pairs(), 0, "backfill alone publishes nothing");
    f.draw(40); assert.equal(f.pairs(), 1, "the next stroke carries the new pose to the host");
  } finally { f.off(); }
});
