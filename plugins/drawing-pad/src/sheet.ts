import type { PluginButtonProps, PluginFrontendContext, PluginSessionViewInput, PluginWidgetHandle } from "learnharness-plugin-api";
import { captureBackground } from "./capture.ts";
import { frame } from "./abort.ts";
import { PEN, ERASER, HAND, UNDO } from "./icons.ts";
import { referenceFor, mountReference } from "./reference.ts";
import { referenceBounds, viewOrigin } from "./geometry.ts";
import { paintInk, paintSegment, type Point, type Stroke } from "./strokes.ts";
import type { SessionSheet, Sheets } from "./state.ts";
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
  const render = () => {
    if (disposed) return;
    const draft = state.draft;
    toolbar.setAttribute("aria-label", `Drawing tools. ${state.tool === "pen" ? "Pen" : state.tool === "eraser" ? "Eraser" : "Hand"} selected.`);
    pen.update({ variant: state.tool === "pen" ? "secondary" : "outline", disabled: preparing || !!failure });
    eraser.update({ variant: state.tool === "eraser" ? "secondary" : "outline", disabled: preparing || !!failure });
    hand.update({ variant: state.tool === "hand" ? "secondary" : "outline", disabled: preparing || !!failure });
    undo.update({ disabled: preparing || !!failure || pointerId !== undefined || !draft?.strokes.length });
    clear.update({ disabled: preparing || !!failure || pointerId !== undefined || !draft?.strokes.length });
    canvas.style.cursor = panDrag ? "grabbing" : state.tool === "hand" ? "grab" : "default";
    status.hidden = !preparing && !failure;
    status.setAttribute("role", failure ? "alert" : "status");
    status.textContent = failure ?? (preparing ? "Preparing drawing sheet…" : "");
    paper.hidden = !draft || preparing || !!failure;
    if (draft) {
      // Keep the previous raster and its ink readable until the new palette
      // is ready to replace them together.
      paper.style.backgroundColor = draft.backgroundColor;
      const width = viewport.clientWidth, height = viewport.clientHeight;
      if (!width || !height) return;
      const origin = viewOrigin(width, height, state.pan, draft.height), bounds = referenceBounds(draft.width, draft.height);
      background.hidden = !draft.background;
      if (draft.background && background.getAttribute("src") !== draft.background) background.src = draft.background;
      background.style.width = `${draft.width}px`; background.style.height = `${draft.height}px`;
      background.style.left = `${origin.x + bounds.x}px`; background.style.top = `${origin.y + bounds.y}px`;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const pixelsWide = Math.max(1, Math.round(width * pixelRatio)), pixelsHigh = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
      if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
      const history = active && activeDraftId === draft.id ? [...draft.strokes, active] : draft.strokes;
      paintInk(canvas, width, height, history, draft.color, origin);
    }
  };
  const point = (event: PointerEvent): Point => {
    const rect = canvas.getBoundingClientRect(), origin = viewOrigin(rect.width, rect.height, state.pan, state.draft!.height);
    return { x: event.clientX - rect.left - origin.x, y: event.clientY - rect.top - origin.y,
      pressure: event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5 };
  };
  const flush = () => {
    const stroke = active, id = activeDraftId;
    active = undefined; activeDraftId = undefined; panDrag = undefined;
    const draft = state.draft;
    if (stroke && draft && draft.id === id) commitHistory([...draft.strokes, stroke]);
  };
  const start = (event: PointerEvent) => {
    if (!state.draft || state.tool === "hand") return;
    activeDraftId = state.draft.id;
    active = { tool: (event.buttons & 32) !== 0 ? "eraser" : state.tool, points: [point(event)] };
    render();
  };
  const down = (event: PointerEvent) => {
    const rightButton = event.pointerType === "mouse" && event.button === 2;
    if (preparing || failure || !state.draft || pointerId !== undefined || event.pointerType === "touch" ||
      (event.pointerType !== "pen" && event.button !== 0 && !rightButton)) return;
    event.preventDefault(); viewport.focus({ preventScroll: true });
    pointerId = event.pointerId; canvas.setPointerCapture(event.pointerId);
    if (rightButton || state.tool === "hand") {
      panDrag = { x: event.clientX, y: event.clientY, pan: state.pan, rightButton }; render();
    }
    else if (event.pointerType !== "pen" || event.pressure > 0) start(event);
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
      if (active.tool === "pen") paintSegment(canvas.getContext("2d")!, active.points.at(-1)!, next, state.draft.color);
      active.points.push(next);
    }
    const draft = state.draft;
    if (draft && active?.tool === "eraser") render();
  };
  const finish = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    if (panDrag && event.type === "pointerup" && event.pointerType !== "pen") sheets.setPan(state,
      { x: panDrag.pan.x + event.clientX - panDrag.x, y: panDrag.pan.y + event.clientY - panDrag.y });
    if (active && event.type === "pointerup" && event.pointerType !== "pen") active.points.push(point(event));
    flush(); pointerId = undefined;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    render();
  };
  canvas.addEventListener("pointerdown", down, { signal });
  canvas.addEventListener("pointermove", move, { signal });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.addEventListener(name, finish, { signal });
  canvas.addEventListener("contextmenu", event => event.preventDefault(), { signal });
  viewport.addEventListener("wheel", event => event.preventDefault(), { signal, passive: false });
  const unsubscribe = sheets.onChange(render);
  const resize = new ResizeObserver(render); resize.observe(viewport);
  const dispose = () => {
    if (disposed) return;
    disposed = true; flush(); pointerId = undefined;
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
