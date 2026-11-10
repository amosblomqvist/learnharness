import type { PluginAction, PluginActionContext, PluginFrontendContext, PluginSettingsSchema, PluginSurfaceProps, PluginWidgetHandle } from "learnharness-plugin-api";
import { abortable } from "./abort.ts";
import { exportSheet } from "./capture.ts";
import { acceptedPoseKeys, occurrenceKey, parsePoseResponse } from "./poses.ts";
import { colorError, imageScaleError, parseSettings, type Settings } from "./settings.ts";
import { mountSheet, type MountedSheet } from "./sheet.ts";
import { Sheets, type SessionSheet } from "./state.ts";
import { appendDrawing } from "./submission.ts";
import { PEN } from "./icons.ts";
import { appPalette, recolorReference } from "./theme.ts";
type SessionAction = Extract<PluginActionContext, { surface: "session" }>;
interface OpenPad {
  session: SessionSheet;
  controller: AbortController;
  handle?: PluginWidgetHandle<PluginSurfaceProps>;
  mounted?: MountedSheet;
  closed: boolean;
}
export async function activate(ctx: PluginFrontendContext): Promise<() => void> {
  let disposed = false, open: OpenPad | undefined, current: Settings | undefined;
  let settings: PluginWidgetHandle<PluginSettingsSchema> | undefined;
  const cleanups: (() => void)[] = [];
  const paletteController = new AbortController();
  let appliedPalette = appPalette().key, paletteTask: Promise<void> | undefined;
  // Opaque public path strings are associated ONLY on an actual contextual click.
  // No route parsing or global-current-session inference is used for targeting.
  const pageSessions = new Map<string, string>();
  const sheets = new Sheets(() => {
    if (!disposed && !ctx.signal.aborted) {
      ctx.refreshActions(); ctx.refreshSubmissions();
      if (current && [...sheets.sessions.values()].some(state => state.draft && state.draft.palette !== appPalette().key))
        void refreshPalette().catch(report);
    }
  }, state => { if (open?.session === state) close(open); }, activeInk);
  function close(pad: OpenPad): void {
    if (pad.closed) return;
    pad.closed = true;
    if (open === pad) open = undefined;
    pad.mounted?.dispose(); pad.controller.abort(); pad.handle?.dispose();
    sheets.dropUntouched(pad.session);
  }
  function toggle(context: SessionAction): void {
    if (!context.view) throw new Error("This LearnHarness build does not expose the session view context required by Drawing Pad.");
    const hadState = sheets.sessions.has(context.sessionId);
    const state = sheets.session(context.sessionId, context.kind);
    const wasOpen = open?.session === state;
    pageSessions.set(ctx.app.pathname(), state.id);
    sheets.observePoses(state, acceptedPoseKeys(context.view.messages), !hadState);
    if (wasOpen) { if (open?.session === state) close(open); return; }
    if (open) close(open);
    // Acceptance can empty a sheet while it is closed. Apply the same empty-
    // sheet policy as close before deciding whether this mount needs a reference.
    sheets.dropUntouched(state);
    const pad: OpenPad = { session: state, controller: new AbortController(), closed: false };
    open = pad;
    try {
      pad.handle = ctx.ui.openSurface(context.surfaceTarget, {
        title: "Drawing pad", background: "opaque",
        content(container, signal) {
          if (pad.closed || signal.aborted) return;
          const mounted = mountSheet(container, ctx, sheets, state, context.view.input, signal);
          pad.mounted = mounted;
          return () => {
            mounted.dispose();
            // Content mounts can be replayed by the host (e.g. development
            // StrictMode). Only the latest, genuinely departed mount owns close.
            queueMicrotask(() => {
              if (pad.mounted !== mounted) return;
              pad.mounted = undefined;
              close(pad);
            });
          };
        },
        onClose: () => close(pad),
      }, { signal: pad.controller.signal });
      if (pad.closed) pad.handle.dispose();
    } catch (error) { close(pad); throw error; }
  }
  const action: PluginAction = {
    id: "draw", icon: PEN,
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+d" },
    // A readonly string accessor uses public pathname + our click-time mapping;
    // no state capture occurs in disabled/render-time predicates.
    get name() {
      const id = pageSessions.get(ctx.app.pathname());
      const state = id ? sheets.sessions.get(id) : undefined;
      return state && sheets.pending(state) ? "Draw (unsent)" : "Draw";
    },
    run(context) { if (context.surface === "session") toggle(context); },
  };
  function editingPad(context: PluginActionContext): MountedSheet | undefined {
    if (disposed || ctx.signal.aborted || context.surface !== "session" || !open || open.closed ||
      open.session.id !== context.sessionId || open.session.kind !== context.kind) return;
    const mounted = open.mounted;
    return mounted?.canUseEditingShortcuts() ? mounted : undefined;
  }
  const undoAction: PluginAction = {
    id: "undo", name: "Undo drawing",
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+z" },
    disabled: context => !editingPad(context)?.canUndo(),
    run(context) { editingPad(context)?.undo(); },
  };
  const toggleToolsAction: PluginAction = {
    id: "toggle-pen-eraser", name: "Toggle pen/eraser",
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+e" },
    disabled: context => !editingPad(context),
    run(context) { editingPad(context)?.togglePenEraser(); },
  };
  const handAction: PluginAction = {
    id: "hand", name: "Hand",
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+h" },
    disabled: context => !editingPad(context),
    run(context) { editingPad(context)?.selectHand(); },
  };
  const rows = (value: Settings): PluginSettingsSchema["rows"] => [...([
    { key: "darkInkColor", label: "Dark mode ink color" },
    { key: "lightInkColor", label: "Light mode ink color" },
  ] as const).map(({ key, label }) => ({
    key, type: "text" as const, label, value: value[key],
    description: "Six-digit hex color. Recolors all unsent ink when this app theme mode is active.", validate: colorError,
    async onChange(color: string) { applySettings(await ctx.call("set-ink-color", { [key]: color })); },
  })), {
    key: "imageScale", type: "number", label: "Image scale", value: value.imageScale, min: 0, max: 100,
    description: "Export percentage (default 50%). Applied before the fixed 2000 × 2000 pixel cap. Does not change the drawing surface.",
    validate: imageScaleError,
    async onChange(imageScale) { applySettings(await ctx.call("set-image-scale", { imageScale })); },
  }];
  function applySettings(value: unknown): void {
    if (disposed || ctx.signal.aborted) return;
    const next = parseSettings(value);
    if (current && next.revision <= current.revision) return;
    current = next; sheets.setImageScale(next.imageScale);
    const palette = appPalette();
    sheets.setInkForPalette(activeInk(), palette.key);
    if (palette.key !== appliedPalette || [...sheets.sessions.values()].some(state => state.draft && state.draft.palette !== palette.key))
      void refreshPalette().catch(report);
    if (settings) settings.update({ rows: rows(next) });
    else settings = ctx.registerSettings({ rows: rows(next) });
  }
  function activeInk(): string { return appPalette().mode === "light" ? current!.lightInkColor : current!.darkInkColor; }
  function refreshPalette(): Promise<void> {
    if (paletteTask) return paletteTask;
    paletteTask = (async () => {
      while (!disposed && !ctx.signal.aborted && current) {
        const palette = appPalette();
        const backgrounds = new Map<SessionSheet, { id: number; background: string; backgroundColor: string }>();
        for (const state of sheets.sessions.values()) {
          const draft = state.draft;
          if (draft && draft.palette !== palette.key) backgrounds.set(state,
            { id: draft.id, ...await recolorReference(draft, ctx, paletteController.signal) });
        }
        if (disposed || ctx.signal.aborted) return;
        if (palette.key !== appPalette().key) continue;
        appliedPalette = palette.key;
        sheets.setPalette(activeInk(), palette.key, backgrounds);
        if (palette.key === appPalette().key) return;
      }
    })().finally(() => { paletteTask = undefined; });
    return paletteTask;
  }
  let settingsRead: Promise<void> = Promise.resolve();
  function refreshSettings(): Promise<void> {
    settingsRead = settingsRead.catch(() => {}).then(async () => {
      if (!disposed && !ctx.signal.aborted) applySettings(await ctx.call("get-settings"));
    });
    return settingsRead;
  }
  async function refreshPoses(state: SessionSheet, signal: AbortSignal): Promise<void> {
    const ticket = ++state.readTicket;
    const value = await abortable(ctx.call("get-session-poses", { sessionId: state.id }), signal);
    signal.throwIfAborted();
    if (disposed || sheets.sessions.get(state.id) !== state || ticket !== state.readTicket) return;
    sheets.observePoses(state, parsePoseResponse(value, state.id));
  }
  const report = (error: unknown) => { if (!disposed && !ctx.signal.aborted) console.error("Drawing Pad resync failed; retaining existing work.", error); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    paletteController.abort();
    if (open) close(open);
    for (const cleanup of cleanups.splice(0)) cleanup();
    settings?.dispose(); sheets.dispose(); pageSessions.clear();
  };
  ctx.cleanup(dispose);
  cleanups.push(ctx.onNotification(event => {
    if (event.pluginId === ctx.manifest.id && event.topic === "settings-changed") applySettings(event.data);
  }));
  cleanups.push(ctx.onAppEvent(event => {
    if (event.type !== "turn-settled" && event.type !== "record-changed") return;
    const state = sheets.sessions.get(event.chatId);
    if (state?.kind === "practice") void refreshPoses(state, ctx.signal).catch(report);
  }));
  cleanups.push(ctx.onResync(() => {
    void refreshSettings().catch(report);
    for (const state of sheets.sessions.values()) if (state.kind === "practice") void refreshPoses(state, ctx.signal).catch(report);
  }));
  if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => { void refreshPalette().catch(report); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    cleanups.push(() => observer.disconnect());
  }
  try {
    await refreshSettings();
    if (disposed || ctx.signal.aborted) return dispose;
    cleanups.push(ctx.registerAction(action));
    cleanups.push(ctx.registerAction(undoAction));
    cleanups.push(ctx.registerAction(toggleToolsAction));
    cleanups.push(ctx.registerAction(handAction));
    cleanups.push(ctx.placeAction({ id: "session-draw", actionId: "draw", location: "top-bar", sessions: ["teaching", "practice"] }));
    cleanups.push(ctx.registerSubmissionInterceptor({
      id: "drawing", priority: 0,
      hasPendingInput(target) {
        const state = sheets.sessions.get(target.sessionId);
        if (!state || !sheets.pending(state)) return false;
        if (state.kind === "practice" && (target.type === "thinking" || target.type === "plugin-problem-submission") &&
          !state.seenPoses.has(occurrenceKey(target.problem.occurrence))) return false;
        return target.type === "text" || target.type === "thinking" || (target.type === "answer" && target.question.mode === "text");
      },
      async intercept(input, context) {
        const state = sheets.sessions.get(context.sessionId);
        if (!state) return;
        context.signal.throwIfAborted();
        if (open?.session === state) open.mounted?.flush();
        if (state.kind === "practice") {
          sheets.observePoses(state, acceptedPoseKeys(context.messages));
          await refreshPoses(state, context.signal);
        }
        // Pose reads and palette rendering are asynchronous. Recheck the live
        // palette after the last await, immediately before freezing the attempt.
        do {
          await abortable(refreshPalette(), context.signal);
          paletteController.signal.throwIfAborted();
        } while (appPalette().key !== appliedPalette || (state.draft && state.draft.palette !== appliedPalette));
        context.signal.throwIfAborted();
        const captured = sheets.capture(state);
        if (!captured) return;
        const result = captured.sendImage ? appendDrawing(input, await exportSheet(captured, context.signal)) : input;
        context.signal.throwIfAborted();
        if (state.draft?.id !== captured.draft.id) throw new Error("The captured drawing sheet was reset. Review the current input and submit again.");
        context.onAccepted(() => { if (!disposed && !ctx.signal.aborted) sheets.accepted(captured); });
        return result;
      },
    }));
  } catch (error) { dispose(); throw error; }
  return dispose;
}
