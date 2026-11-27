import type { PluginButtonProps, PluginFrontendContext, PluginSessionViewInput, PluginWidgetHandle } from "learnharness-plugin-api";
import { captureBackground } from "./capture.ts";
import { frame } from "./abort.ts";
import { PEN, ERASER, HAND, UNDO } from "./icons.ts";
import { referenceFor, mountReference } from "./reference.ts";
import { referenceBounds, viewOrigin } from "./geometry.ts";
import { paintSegment, paintStroke, paintStrokes, strokeBounds, visibleStrokes, visibleUnderEraser, type Point, type Stroke } from "./strokes.ts";
import type { PublishReason, SessionSheet, Sheets } from "./state.ts";
import { appPalette } from "./theme.ts";

export interface MountedSheet {
  flush(): void;
  dispose(): void;
  canUseEditingShortcuts(): boolean;
  canUndo(): boolean;
  undo(): void;
  togglePenEraser(): void;
  selectHand(): void;
}
export function mountSheet(container: HTMLElement, ctx: PluginFrontendContext, sheets: Sheets, state: SessionSheet,
  input: PluginSessionViewInput, signal: AbortSignal): MountedSheet {
  const root = document.createElement("div"); root.className = "drawing-pad-root";
  const toolbar = document.createElement("div"); toolbar.className = "drawing-pad-tools";
  toolbar.setAttribute("role", "group");
  const viewport = document.createElement("div"); viewport.className = "drawing-pad-viewport";
  viewport.tabIndex = -1; viewport.dataset.pluginInitialFocus = "";
  viewport.setAttribute("role", "group"); viewport.setAttribute("aria-label", "Drawing sheet");
  const paper = document.createElement("div"); paper.className = "drawing-pad-paper";
  const background = document.createElement("img"); background.alt = "Frozen question reference";
  background.className = "drawing-pad-background"; background.draggable = false;
  const canvas = document.createElement("canvas"); canvas.className = "drawing-pad-ink";
  canvas.setAttribute("aria-label", "Draw with a mouse or pen; pan with Hand or a right mouse drag");
  const status = document.createElement("div"); status.className = "drawing-pad-status"; status.setAttribute("role", "status");
  paper.append(background, canvas); viewport.append(paper, status); root.append(toolbar, viewport); container.append(root);
  const buttons: PluginWidgetHandle<PluginButtonProps>[] = [];
  let disposed = false, preparing = !state.draft, active: Stroke | undefined, activeDraftId: number | undefined;
  let pointerId: number | undefined;
  let panDrag: { x: number; y: number; pan: SessionSheet["pan"]; rightButton: boolean } | undefined;
  let reference: HTMLElement | undefined;
  let referenceMount: ReturnType<typeof mountReference> | undefined;
  let failure: string | undefined;
  // The first call fixes the context attributes. Keep this canvas CPU-backed:
  // an accelerated canvas made pan and erase frame times worse in device tests.
  let ink: CanvasRenderingContext2D | undefined;
  const inkContext = () => {
    ink ??= canvas.getContext("2d", { willReadFrequently: true }) ?? undefined;
    if (!ink) throw new Error("Could not create the drawing canvas.");
    return ink;
  };
  let view: { width: number; height: number; pixelRatio: number; origin: { x: number; y: number } } | undefined;
  let geometry: { left: number; top: number; originX: number; originY: number } | undefined;
  // What the canvas shows: `visible` (committed strokes, minus any under a live
  // eraser) painted for this draft, color, origin and bitmap size, plus the
  // live pen stroke `livePainted`, whose segments are drawn as they arrive.
  let painted: { draftId: number; color: string; originX: number; originY: number;
    pixelsWide: number; pixelsHigh: number; visible: readonly Stroke[] } | undefined;
  let livePainted: Stroke | undefined;
  let inkFrame: number | undefined;
  const toolButton = (label: string, onClick: () => void, icon?: string) => {
    const target = document.createElement("span"); toolbar.append(target);
    const handle = ctx.ui.mountButton(target, { label, title: label, onClick, variant: "outline", size: icon ? "icon-sm" : "sm",
      ...(icon ? { icon, iconOnly: true } : {}) }, { signal });
    buttons.push(handle); return handle;
  };
  const pen = toolButton("Pen", () => sheets.setTool(state, "pen"), PEN);
  const eraser = toolButton("Eraser", () => sheets.setTool(state, "eraser"), ERASER);
  const hand = toolButton("Hand", () => sheets.setTool(state, "hand"), HAND);
  const commitHistory = (strokes: Stroke[]) => sheets.update(state, strokes);
  const editable = () => !disposed && !signal.aborted && !preparing && !failure && !!state.draft && pointerId === undefined;
  const canUseEditingShortcuts = () => {
    if (!editable()) return false;
    const focused = document.activeElement;
    return focused instanceof HTMLElement && root.contains(focused) && !focused.isContentEditable &&
      !focused.closest('input,textarea,select,[role="textbox"],[role="combobox"]');
  };
  const canUndo = () => editable() && !!state.draft?.strokes.length;
  const undoHistory = () => { if (canUndo()) commitHistory(state.draft!.strokes.slice(0, -1)); };
  const togglePenEraser = () => { if (editable()) sheets.setTool(state, state.tool === "pen" ? "eraser" : "pen"); };
  const selectHand = () => { if (editable()) sheets.setTool(state, "hand"); };
  const undo = toolButton("Undo", undoHistory, UNDO);
  const clear = toolButton("Clear", () => { if (pointerId === undefined && state.draft) commitHistory([]); });
  const sent = new Map<PluginWidgetHandle<PluginButtonProps>, Partial<PluginButtonProps>>();
  const setButton = (handle: PluginWidgetHandle<PluginButtonProps>, props: Pick<PluginButtonProps, "variant" | "disabled">) => {
    const last = sent.get(handle);
    if (last && last.variant === props.variant && last.disabled === props.disabled) return;
    sent.set(handle, { ...last, ...props }); handle.update(props);
  };
  const renderChrome = () => {
    if (disposed) return;
    const draft = state.draft;
    toolbar.setAttribute("aria-label", `Drawing tools. ${state.tool === "pen" ? "Pen" : state.tool === "eraser" ? "Eraser" : "Hand"} selected.`);
    setButton(pen, { variant: state.tool === "pen" ? "secondary" : "outline", disabled: preparing || !!failure });
    setButton(eraser, { variant: state.tool === "eraser" ? "secondary" : "outline", disabled: preparing || !!failure });
    setButton(hand, { variant: state.tool === "hand" ? "secondary" : "outline", disabled: preparing || !!failure });
    const historyDisabled = preparing || !!failure || pointerId !== undefined || !draft?.strokes.length;
    setButton(undo, { disabled: historyDisabled });
    setButton(clear, { disabled: historyDisabled });
    canvas.style.cursor = panDrag ? "grabbing" : state.tool === "hand" ? "grab" : "default";
    status.hidden = !preparing && !failure;
    status.setAttribute("role", failure ? "alert" : "status");
    status.textContent = failure ?? (preparing ? "Preparing drawing sheet…" : "");
    paper.hidden = !draft || preparing || !!failure;
  };
  const layout = (): boolean => {
    const draft = state.draft;
    if (disposed || !draft) return false;
    // Keep the previous raster and its ink readable until the new palette
    // is ready to replace them together.
    paper.style.backgroundColor = draft.backgroundColor;
    const width = viewport.clientWidth, height = viewport.clientHeight;
    if (!width || !height) { view = undefined; return false; }
    const origin = viewOrigin(width, height, state.pan, draft.height), bounds = referenceBounds(draft.width, draft.height);
    background.hidden = !draft.background;
    if (draft.background && background.getAttribute("src") !== draft.background) background.src = draft.background;
    background.style.width = `${draft.width}px`; background.style.height = `${draft.height}px`;
    background.style.left = `${origin.x + bounds.x}px`; background.style.top = `${origin.y + bounds.y}px`;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelsWide = Math.max(1, Math.round(width * pixelRatio)), pixelsHigh = Math.max(1, Math.round(height * pixelRatio));
    let changed = !view || view.width !== width || view.height !== height || view.origin.x !== origin.x || view.origin.y !== origin.y;
    if (canvas.width !== pixelsWide) { canvas.width = pixelsWide; changed = true; }
    if (canvas.height !== pixelsHigh) { canvas.height = pixelsHigh; changed = true; }
    view = { width, height, pixelRatio, origin };
    if (changed) geometry = undefined;
    return changed;
  };
  const inView = (stroke: Stroke) => {
    const box = strokeBounds(stroke), left = -view!.origin.x, top = -view!.origin.y;
    return box.right >= left && box.left <= left + view!.width && box.bottom >= top && box.top <= top + view!.height;
  };
  /** Bring the canvas to the current draft with the least painting: nothing
   * when it already shows the target, just the appended strokes when the
   * target extends what is shown, otherwise one full repaint. */
  const syncInk = () => {
    const draft = state.draft;
    if (disposed || !draft || !view) return;
    // A density-only monitor change need not resize the CSS content box.
    // Reconcile on ordinary input, but leave unchanged gestures incremental.
    if (view.pixelRatio !== Math.min(window.devicePixelRatio || 1, 2)) { layout(); if (!view) return; }
    const live = active && activeDraftId === draft.id ? active : undefined;
    let target = visibleStrokes(draft.strokes);
    if (live?.tool === "eraser") target = visibleUnderEraser(target, live);
    const context = inkContext();
    // A lost context has no usable bitmap or world transform. Keep collecting
    // input, but never remember failed paint commands as a current display.
    if (context.isContextLost()) { painted = undefined; livePainted = undefined; return; }
    if (painted && painted.draftId === draft.id && painted.color === draft.color && painted.originX === view.origin.x &&
      painted.originY === view.origin.y && painted.pixelsWide === canvas.width && painted.pixelsHigh === canvas.height) {
      if (target === painted.visible) return;
      const shown = painted.visible;
      let prefix = shown.length <= target.length;
      for (let i = 0; prefix && i < shown.length; i++) prefix = shown[i] === target[i];
      const appended = prefix ? target.slice(shown.length) : [];
      // Appended strokes go on top of everything shown, including the live
      // stroke, so with a live stroke on the canvas the only appendable stroke
      // is that live stroke itself (just committed, already drawn).
      if (prefix && (!livePainted || !appended.length || (appended.length === 1 && appended[0] === livePainted))) {
        for (const stroke of appended) if (stroke !== livePainted) paintStroke(context, stroke, draft.color);
        painted.visible = target;
        return;
      }
    }
    // paintStrokes leaves this transform set for incremental painting; a canvas
    // resize resets it, and always lands here through the size check above.
    paintStrokes(context, view!.width, view!.height, target.filter(inView), draft.color, view!.origin);
    painted = { draftId: draft.id, color: draft.color, originX: view.origin.x, originY: view.origin.y,
      pixelsWide: canvas.width, pixelsHigh: canvas.height, visible: target };
    if (live?.tool === "pen") { paintStroke(context, live, draft.color); livePainted = live; }
    else livePainted = undefined;
  };
  const cancelInk = () => { if (inkFrame !== undefined) { cancelAnimationFrame(inkFrame); inkFrame = undefined; } };
  const scheduleInk = () => {
    if (disposed || inkFrame !== undefined) return;
    inkFrame = requestAnimationFrame(() => { inkFrame = undefined; layout(); syncInk(); });
  };
  /** Discrete events apply a pending frame now, so state read right after them is current. */
  const applyScheduledInk = () => { if (inkFrame !== undefined) { cancelInk(); layout(); syncInk(); } };
  const render = () => {
    if (disposed) return;
    cancelInk(); renderChrome(); layout(); syncInk();
  };
  const measure = () => {
    const rect = canvas.getBoundingClientRect(), origin = viewOrigin(rect.width, rect.height, state.pan, state.draft!.height);
    return geometry = { left: rect.left, top: rect.top, originX: origin.x, originY: origin.y };
  };
  const point = (event: PointerEvent): Point => {
    const at = geometry ?? measure();
    return { x: event.clientX - at.left - at.originX, y: event.clientY - at.top - at.originY,
      pressure: event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5 };
  };
  const flush = () => {
    const stroke = active, id = activeDraftId;
    active = undefined; activeDraftId = undefined; panDrag = undefined;
    const draft = state.draft;
    if (stroke && draft && draft.id === id) commitHistory([...draft.strokes, stroke]);
    // A discarded live stroke is still on the canvas: the next sync repaints.
    else if (stroke && stroke === livePainted) painted = undefined;
    livePainted = undefined;
  };
  const start = (event: PointerEvent) => {
    if (!state.draft || state.tool === "hand") return;
    applyScheduledInk(); syncInk();
    activeDraftId = state.draft.id;
    active = { tool: (event.buttons & 32) !== 0 ? "eraser" : state.tool, points: [point(event)] };
    if (active.tool === "pen" && painted && view) {
      // The dot a full repaint would draw for point 0.
      paintSegment(inkContext(), active.points[0]!, active.points[0]!, state.draft.color); livePainted = active;
    }
    else if (active.tool === "eraser") syncInk();
    renderChrome();
  };
  const down = (event: PointerEvent) => {
    const rightButton = event.pointerType === "mouse" && event.button === 2;
    if (preparing || failure || !state.draft || pointerId !== undefined || event.pointerType === "touch" ||
      (event.pointerType !== "pen" && event.button !== 0 && !rightButton)) return;
    event.preventDefault(); viewport.focus({ preventScroll: true });
    pointerId = event.pointerId; canvas.setPointerCapture(event.pointerId);
    // Keep the pre-gesture opacity even if a pressure gap commits ink before release.
    toolbar.toggleAttribute("data-gesture-lock", state.draft.strokes.length > 0);
    if (rightButton || state.tool === "hand") {
      panDrag = { x: event.clientX, y: event.clientY, pan: state.pan, rightButton }; render();
    }
    else if (event.pointerType !== "pen" || event.pressure > 0) { measure(); start(event); }
    else renderChrome();
  };
  const move = (event: PointerEvent) => {
    if (preparing || failure || !state.draft || pointerId !== event.pointerId) return;
    if (panDrag) {
      // Releasing Right while another mouse button is held emits pointermove,
      // not pointerup. End this gesture before any unheld movement can pan.
      if (panDrag.rightButton && (event.buttons & 2) === 0) { finish(event); return; }
      if (event.pointerType !== "pen" || event.pressure > 0) sheets.setPan(state,
        { x: panDrag.pan.x + event.clientX - panDrag.x, y: panDrag.pan.y + event.clientY - panDrag.y });
      return;
    }
    if (state.tool === "hand") return;
    const coalesced = event.getCoalescedEvents?.() ?? [];
    for (const sample of coalesced.length ? coalesced : [event]) {
      if (sample.pointerType === "pen" && sample.pressure <= 0) { flush(); continue; }
      const nextTool = (sample.buttons & 32) !== 0 ? "eraser" : state.tool;
      if (active && active.tool !== nextTool) flush();
      if (!active) { start(sample); continue; }
      const next = point(sample);
      if (active.tool === "pen" && active === livePainted) paintSegment(inkContext(), active.points.at(-1)!, next, state.draft.color);
      active.points.push(next);
    }
    const draft = state.draft;
    if (draft && active?.tool === "eraser") scheduleInk();
  };
  const finish = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    if (panDrag && event.type === "pointerup" && event.pointerType !== "pen") sheets.setPan(state,
      { x: panDrag.pan.x + event.clientX - panDrag.x, y: panDrag.pan.y + event.clientY - panDrag.y });
    if (active && event.type === "pointerup" && event.pointerType !== "pen") {
      const next = point(event);
      // This final segment is otherwise drawn only by a full repaint.
      if (active.tool === "pen" && active === livePainted && state.draft) paintSegment(inkContext(), active.points.at(-1)!, next, state.draft.color);
      active.points.push(next);
    }
    flush(); pointerId = undefined;
    toolbar.removeAttribute("data-gesture-lock");
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    applyScheduledInk(); renderChrome(); syncInk();
  };
  // Context restoration resets both pixels and drawing state without changing
  // our draft/viewport keys. Reconstruct committed ink and any active gesture.
  // Do not preventDefault on loss: the browser owns automatic restoration.
  canvas.addEventListener("contextlost", () => { painted = undefined; livePainted = undefined; }, { signal });
  canvas.addEventListener("contextrestored", render, { signal });
  canvas.addEventListener("pointerdown", down, { signal });
  canvas.addEventListener("pointermove", move, { signal });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.addEventListener(name, finish, { signal });
  canvas.addEventListener("contextmenu", event => event.preventDefault(), { signal });
  viewport.addEventListener("wheel", event => event.preventDefault(), { signal, passive: false });
  const changed = (reason: PublishReason) => {
    if (disposed) return;
    if (reason === "tool") { applyScheduledInk(); renderChrome(); syncInk(); }
    // Reference image and ink move together, in the same frame.
    else if (reason === "camera") { geometry = undefined; scheduleInk(); }
    else if (reason === "ink") { applyScheduledInk(); renderChrome(); syncInk(); }
    else render();
  };
  const unsubscribe = sheets.onChange(changed);
  const resize = new ResizeObserver(render); resize.observe(viewport);
  const dispose = () => {
    if (disposed) return;
    disposed = true; flush(); pointerId = undefined; cancelInk();
    unsubscribe(); resize.disconnect(); referenceMount?.dispose();
    for (const button of buttons) button.dispose();
    signal.removeEventListener("abort", dispose); root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  render();
  if (preparing) void (async () => {
    try {
      await frame(signal);
      signal.throwIfAborted();
      const width = viewport.clientWidth, height = viewport.clientHeight;
      const content = referenceFor(input);
      let slots: HTMLElement[] = [];
      if (content) {
        reference = document.createElement("div"); reference.className = "drawing-pad-reference";
        // CSS mirrors the native composer's normal question-content width,
        // independent of the viewport. Freeze that wrapping once for this sheet.
        reference.setAttribute("aria-hidden", "true");
        root.append(reference);
        referenceMount = mountReference(reference, ctx, content, signal); slots = referenceMount.slots;
      }
      let palette: string, sheet: Awaited<ReturnType<typeof captureBackground>>;
      do {
        palette = appPalette().key;
        sheet = await captureBackground(reference, slots, width, height, getComputedStyle(root).backgroundColor, signal);
      } while (palette !== appPalette().key);
      if (disposed || signal.aborted) return;
      preparing = false;
      sheets.create(state, { ...sheet, reference: content, palette });
    } catch (error) {
      if (!disposed && !signal.aborted) {
        preparing = false; failure = `Could not prepare the drawing background. ${error instanceof Error ? error.message : ""} Close and reopen Draw to try again.`;
        render();
      }
    } finally { referenceMount?.dispose(); reference?.remove(); }
  })();
  return { flush, dispose, canUseEditingShortcuts, canUndo, undo: undoHistory, togglePenEraser, selectHand };
}
