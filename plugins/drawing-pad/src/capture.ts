import { toSvg } from "html-to-image";
import { abortable, frame } from "./abort.ts";
import { paintInk } from "./strokes.ts";
import { referenceFontCSS } from "./fonts.ts";
import { exportBounds, exportRaster, referenceBounds } from "./geometry.ts";
import type { Capture, Draft } from "./state.ts";

export function hasVisibleInk(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not read the drawing canvas.");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return pixels.some((value, index) => index % 4 === 3 && value > 0);
}
/** Observe only the plugin-owned reference and generic browser/ARIA readiness.
 * No native dock selectors, private Markdown classes, timer polling or timeouts. */
async function waitForReference(root: HTMLElement, slots: readonly HTMLElement[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let running = false, revision = 0, settled = false;
    const cleanup = () => {
      settled = true; observer.disconnect(); signal.removeEventListener("abort", abort);
      root.removeEventListener("load", schedule, true); root.removeEventListener("error", schedule, true);
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const abort = () => fail(signal.reason);
    const check = async () => {
      if (running || settled) return;
      running = true;
      try {
        const before = revision;
        await frame(signal);
        if (slots.some(slot => !slot.hasChildNodes()) || root.querySelector('[aria-busy="true"]')) { running = false; return; }
        await abortable(document.fonts.ready, signal);
        await abortable(Promise.all([...root.querySelectorAll("img")].map(image => image.decode())), signal);
        await frame(signal); await frame(signal);
        running = false;
        if (revision !== before) { schedule(); return; }
        cleanup(); resolve();
      } catch (error) { fail(error); }
    };
    const schedule = () => { if (!settled) void check(); };
    const observer = new MutationObserver(() => { revision++; schedule(); });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    root.addEventListener("load", schedule, true); root.addEventListener("error", schedule, true);
    signal.addEventListener("abort", abort, { once: true });
    schedule();
  });
}
export async function captureBackground(root: HTMLElement | undefined, slots: readonly HTMLElement[], width: number, height: number,
  background: string, signal: AbortSignal, frozenSize?: { width: number; height: number; pixelRatio: number }): Promise<Omit<Draft, "id" | "revision" | "strokes" | "hasInk" | "color">> {
  signal.throwIfAborted();
  if (width <= 0 || height <= 0) throw new Error("The drawing sheet is not visible.");
  const pixelRatio = frozenSize?.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);
  if (!root) return { background: "", backgroundColor: background, width: 0, height: 0, pixelRatio };
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Drawing is unavailable in this browser.");
  {
    await waitForReference(root, slots, signal);
    const questionWidth = root.clientWidth, questionHeight = root.scrollHeight;
    if (!questionWidth || !questionHeight) throw new Error("The question reference is not visible.");
    let changed = false;
    const observer = new MutationObserver(() => { changed = true; });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    let svg: string;
    try {
      do {
        changed = false;
        await waitForReference(root, slots, signal);
        const fontEmbedCSS = await referenceFontCSS(root, signal);
        const width = frozenSize?.width ?? root.clientWidth, height = frozenSize?.height ?? root.scrollHeight;
        svg = await abortable(toSvg(root, { fontEmbedCSS, width, height,
          style: { position: "static", left: "0", top: "0", width: `${width}px`, height: `${height}px`, maxHeight: "none", overflow: "visible" } }), signal);
      } while (changed);
    } finally { observer.disconnect(); }
    const image = new Image(); image.src = svg!;
    await abortable(image.decode(), signal);
    // Freeze the reference at its rendered CSS-pixel size. Never fit it to a viewport.
    width = frozenSize?.width ?? root.clientWidth; height = frozenSize?.height ?? root.scrollHeight;
    canvas.width = Math.max(1, Math.round(width * pixelRatio));
    canvas.height = Math.max(1, Math.round(height * pixelRatio));
    context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  signal.throwIfAborted();
  const raster = canvas.toDataURL("image/png");
  if (!raster.startsWith("data:image/png;base64,")) throw new Error("Could not capture the complete question reference.");
  return { background: raster, backgroundColor: background, width, height, pixelRatio };
}
/** Freeze both layers from one immutable attempt snapshot. No toolbar/chrome. */
export async function exportSheet(captured: Capture, signal: AbortSignal): Promise<{ type: "image"; mimeType: "image/png"; data: string }> {
  signal.throwIfAborted();
  const draft = captured.draft;
  const bounds = exportBounds(draft.width, draft.height, draft.strokes);
  if (!bounds) throw new Error("No visible ink could be captured. Your drawing has been kept.");
  const raster = exportRaster(bounds, draft.pixelRatio, captured.imageScale);
  const ink = document.createElement("canvas"); ink.width = raster.width; ink.height = raster.height;
  paintInk(ink, bounds.width, bounds.height, draft.strokes, captured.color, { x: -bounds.x, y: -bounds.y });
  if (!hasVisibleInk(ink)) throw new Error("No visible ink could be captured at the export resolution. Your drawing has been kept.");
  const combined = document.createElement("canvas"); combined.width = raster.width; combined.height = raster.height;
  const context = combined.getContext("2d");
  if (!context) throw new Error("Could not export your drawing. Your drawing has been kept.");
  context.fillStyle = draft.backgroundColor; context.fillRect(0, 0, combined.width, combined.height);
  if (draft.background) {
    const image = new Image(); image.src = draft.background;
    await abortable(image.decode(), signal);
    const reference = referenceBounds(draft.width, draft.height);
    const sx = raster.width / bounds.width, sy = raster.height / bounds.height;
    context.setTransform(sx, 0, 0, sy, -bounds.x * sx, -bounds.y * sy);
    context.drawImage(image, reference.x, reference.y, reference.width, reference.height);
    context.resetTransform();
  }
  context.drawImage(ink, 0, 0);
  signal.throwIfAborted();
  const data = combined.toDataURL("image/png").split(",")[1];
  if (!data) throw new Error("Could not encode your drawing. Your drawing has been kept.");
  return { type: "image", mimeType: "image/png", data };
}
