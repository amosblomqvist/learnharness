import assert from "node:assert/strict";
import { it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { PluginAction, PluginFrontendContext, PluginNotification } from "learnharness-plugin-api";
import type { Capture, Draft, SessionSheet, Sheets } from "../src/state.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
// Original frontend/state/pose/submission code; only browser mounting, palette
// reads, raster I/O and export I/O are controlled. No production test hooks.
const bundle = await build({ stdin: { contents: `export {activate} from ${JSON.stringify(path.join(project, "src/main.ts"))};`,
  resolveDir: project, loader: "ts" }, bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "controlled-theme-io", setup(builder) {
    builder.onLoad({ filter: /\/src\/theme\.ts$/ }, () => ({ loader: "js", contents: `
      export const appPalette=()=>globalThis.__drawingThemeRace.palette;
      export const recolorReference=(draft,ctx,signal)=>globalThis.__drawingThemeRace.render(draft,signal);` }));
    builder.onLoad({ filter: /\/src\/capture\.ts$/ }, () => ({ loader: "js", contents: `
      export const exportSheet=async(captured,signal)=>{signal.throwIfAborted();const probe=globalThis.__drawingThemeRace;
        probe.exports.push(captured);if(probe.exportWait)await probe.exportWait;
        return {type:'image',mimeType:'image/png',data:'controlled-png'};};` }));
    builder.onLoad({ filter: /\/src\/sheet\.ts$/ }, () => ({ loader: "js", contents: `
      export const mountSheet=(_container,_ctx,sheets,state)=>{Object.assign(globalThis.__drawingThemeRace,{sheets,state});
        return {flush(){},dispose(){},canUseEditingShortcuts(){return false},canUndo(){return false},undo(){},togglePenEraser(){},selectHand(){}};};` }));
  } }] });
const { activate } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`) as {
  activate: typeof import("../src/main.ts").activate;
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
type Raster = Pick<Draft, "background" | "backgroundColor">;
type Render = ReturnType<typeof deferred<Raster>> & { draft: Draft; signal: AbortSignal };
async function fixture(kind: "teaching" | "practice" = "practice") {
  const observers = new Set<() => void>(), actions = new Map<string, PluginAction>();
  const owner = new AbortController(), errors: unknown[][] = [];
  const probe = { palette: { key: "dark", mode: "dark" }, renders: [] as Render[], exports: [] as Capture[],
    sheets: undefined as Sheets | undefined, state: undefined as SessionSheet | undefined, exportWait: undefined as Promise<void> | undefined,
    render(draft: Draft, signal: AbortSignal) {
      const pending = { ...deferred<Raster>(), draft, signal }; this.renders.push(pending);
      const abort = () => pending.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      return pending.promise.finally(() => signal.removeEventListener("abort", abort));
    },
  };
  const originals = ["document", "MutationObserver", "__drawingThemeRace"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: { documentElement: {} } },
    MutationObserver: { configurable: true, value: class {
      constructor(private callback: () => void) {} observe() { observers.add(this.callback); } disconnect() { observers.delete(this.callback); }
    } },
    __drawingThemeRace: { configurable: true, value: probe },
  });
  const previousError = console.error; console.error = (...values: unknown[]) => { errors.push(values); };
  let interceptor!: Parameters<PluginFrontendContext["registerSubmissionInterceptor"]>[0];
  let poseRead = () => Promise.resolve({ sessionId: "s", poses: [] as string[] });
  const ctx = {
    manifest: { id: "drawing-pad" }, signal: owner.signal, cleanup() {}, refreshActions() {}, refreshSubmissions() {},
    app: { pathname: () => "/controlled-session" }, onNotification(_fn: (event: PluginNotification) => void) { return () => {}; },
    onAppEvent() { return () => {}; }, onResync() { return () => {}; }, registerSettings() { return { update() {}, dispose() {} }; },
    registerAction(value: PluginAction) { actions.set(value.id, value); return () => actions.delete(value.id); }, placeAction() { return () => {}; },
    registerSubmissionInterceptor(value: typeof interceptor) { interceptor = value; return () => {}; },
    ui: { openSurface(_target: unknown, props: { content: (container: HTMLElement, signal: AbortSignal) => unknown }) {
      props.content({} as HTMLElement, owner.signal); return { update() {}, dispose() {} };
    } },
    async call(name: string) {
      if (name === "get-settings") return { revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 };
      if (name === "get-session-poses") return poseRead();
      throw new Error(name);
    },
  } as unknown as PluginFrontendContext;
  const off = await activate(ctx);
  await actions.get("draw")!.run({ surface: "session", surfaceTarget: {} as never, sessionId: "s", kind,
    view: { messages: [], input: { type: "text" } } } as never);
  const sheets = probe.sheets!, state = probe.state!;
  const create = (palette = "dark", backgroundColor = "#141414", question = "ORIGINAL") => {
    sheets.create(state, { background: "reference-" + palette, backgroundColor, width: 600, height: 100, pixelRatio: 1, palette,
      reference: { label: "Question", question, options: [], multiple: false } });
    sheets.update(state, [{ tool: "pen", points: [{ x: 20, y: 20, pressure: .5 }, { x: 100, y: 100, pressure: .5 }] }]);
  };
  create();
  return { probe, sheets, state, create, errors,
    setPoseRead(read: typeof poseRead) { poseRead = read; },
    async theme(key: string, mode: string) { probe.palette = { key, mode }; for (const fn of observers) fn(); await settle(); },
    async submit() { return interceptor.intercept({ type: "text", content: { text: "controlled", images: [] } }, {
      sessionId: "s", signal: owner.signal, messages: [], onAccepted() {},
    } as never); },
    async dispose() {
      off(); await settle(); assert.equal(observers.size, 0); console.error = previousError;
      for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    },
  };
}
it("DP-IR-1: a mode change during practice pose synchronization waits for the current raster at capture, then freezes that attempt", async () => {
  const f = await fixture(), pose = deferred<{ sessionId: string; poses: string[] }>(), exporting = deferred<void>();
  try {
    f.setPoseRead(() => pose.promise); f.probe.exportWait = exporting.promise;
    const sending = f.submit(); await settle(); assert.equal(f.probe.exports.length, 0);
    await f.theme("light", "light"); assert.equal(f.probe.renders.length, 1);
    pose.resolve({ sessionId: "s", poses: [] }); await settle();
    assert.equal(f.probe.exports.length, 0, "export must not capture the old dark palette while the light raster is pending");
    f.probe.renders[0]!.resolve({ background: "light-original", backgroundColor: "#ffffff" }); await settle();
    const captured = f.probe.exports[0]!; assert.ok(captured);
    assert.equal(captured.draft.palette, "light"); assert.equal(captured.draft.background, "light-original"); assert.equal(captured.color, "#000000");
    await f.theme("new-dark", "dark"); f.probe.renders[1]!.resolve({ background: "new-dark-original", backgroundColor: "#202020" }); await settle();
    assert.equal(captured.draft.background, "light-original"); assert.equal(captured.color, "#000000", "later palette edits cannot mutate the attempt snapshot");
    exporting.resolve(); await sending;
  } finally { pose.resolve({ sessionId: "s", poses: [] }); exporting.resolve(); await f.dispose(); }
});
it("DP-IR-2: a fresh new-problem sheet pairs its current background and ink despite an obsolete repaint pending and failing", async () => {
  const f = await fixture();
  try {
    await f.theme("light", "light"); assert.equal(f.probe.renders.length, 1); const oldId = f.state.draft!.id;
    f.sheets.observePoses(f.state, ["new-problem"]); f.create("light", "#ffffff", "NEW PROBLEM");
    f.sheets.setPan(f.state, { x: 17, y: -23 });
    const fresh = f.sheets.capture(f.state)!; assert.notEqual(fresh.draft.id, oldId);
    assert.equal(fresh.draft.backgroundColor, "#ffffff"); assert.equal(fresh.color, "#000000", "new light paper must never be published with old dark-mode white ink");
    f.probe.renders[0]!.reject(new Error("Obsolete old-reference render failed")); await settle();
    f.sheets.setPan(f.state, { x: 18, y: -24 }); await settle();
    const retained = f.sheets.capture(f.state)!;
    assert.equal(retained.draft.id, fresh.draft.id); assert.equal(retained.draft.background, "reference-light"); assert.equal(retained.color, "#000000");
    assert.equal(retained.draft.reference!.question, "NEW PROBLEM"); assert.equal(retained.draft.strokes.length, 1);
    assert.deepEqual(f.state.pan, { x: 18, y: -24 });
    assert.deepEqual([retained.draft.width, retained.draft.height, retained.draft.pixelRatio], [600, 100, 1]);
  } finally { await f.dispose(); }
});
