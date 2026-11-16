/** Adapted from hrdkj/learnharness, codex/handwriting-contribution (48dd022).
 * See THIRD-PARTY.md. Coordinates and pressure remain in unrestricted world space. */
export interface Point { x: number; y: number; pressure: number }
export interface Stroke { tool: "pen" | "eraser"; points: Point[] }
export type Tool = Stroke["tool"] | "hand";

export function strokeWidth(a: Point, b: Point): number {
  return 1.5 + 3 * (a.pressure + b.pressure) / 2;
}
function pointSegmentDistanceSquared(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
}
function segmentDistanceSquared(a: Point, b: Point, c: Point, d: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y;
  const determinant = dx * ey - dy * ex;
  if (determinant !== 0) {
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / determinant;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / determinant;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(pointSegmentDistanceSquared(a, c, d), pointSegmentDistanceSquared(b, c, d),
    pointSegmentDistanceSquared(c, a, b), pointSegmentDistanceSquared(d, a, b));
}
/* Invariant: a Stroke object and a history array are immutable once passed to
 * Sheets.update. The only mutable stroke is the sheet's live `active` stroke,
 * which must never reach the caches below (bounds and resolved histories). */
export interface StrokeBounds { left: number; top: number; right: number; bottom: number }
const bounds = new WeakMap<Stroke, StrokeBounds>();
function measure(stroke: Stroke): StrokeBounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let i = 0; i < stroke.points.length; i++) {
    const a = stroke.points[Math.max(0, i - 1)]!, b = stroke.points[i]!;
    const radius = strokeWidth(a, b) / 2;
    left = Math.min(left, a.x - radius, b.x - radius); top = Math.min(top, a.y - radius, b.y - radius);
    right = Math.max(right, a.x + radius, b.x + radius); bottom = Math.max(bottom, a.y + radius, b.y + radius);
  }
  return { left, top, right, bottom };
}
/** Committed strokes only. Includes each segment's half width. */
export function strokeBounds(stroke: Stroke): StrokeBounds {
  let cached = bounds.get(stroke);
  if (!cached) { cached = measure(stroke); bounds.set(stroke, cached); }
  return cached;
}
/** Same as strokeBounds, never cached: for a still-growing (active) stroke. */
export function liveBounds(stroke: Stroke): StrokeBounds { return measure(stroke); }
function eraserBounds(eraser: Stroke): StrokeBounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of eraser.points) {
    left = Math.min(left, point.x); top = Math.min(top, point.y);
    right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
  }
  return { left, top, right, bottom };
}
// The exact test below accepts distances up to 12 + width / 2 between a pen
// segment and an eraser segment, and the pen bounds already include width / 2,
// so inflating them by the 12px contact radius can only reject true misses.
// The extra margin keeps float rounding of the two comparisons from ever
// rejecting a boundary contact.
const CONTACT = 12 + 1e-6;
function touchesStroke(stroke: Stroke, eraser: Stroke, pen: StrokeBounds, erase: StrokeBounds): boolean {
  if (pen.left - CONTACT > erase.right || pen.right + CONTACT < erase.left || pen.top - CONTACT > erase.bottom || pen.bottom + CONTACT < erase.top) return false;
  for (let i = 0; i < stroke.points.length; i++) {
    const a = stroke.points[Math.max(0, i - 1)]!, b = stroke.points[i]!;
    const radius = 12 + strokeWidth(a, b) / 2;
    for (let j = 0; j < eraser.points.length; j++) {
      const c = eraser.points[Math.max(0, j - 1)]!, d = eraser.points[j]!;
      if (segmentDistanceSquared(a, b, c, d) <= radius * radius) return true;
    }
  }
  return false;
}
/** Pens in `visible` that `eraser` does not touch; the same array object when
 * it touches none (callers use identity to skip repaints). */
function erase(visible: readonly Stroke[], eraser: Stroke): readonly Stroke[] {
  if (!visible.length) return visible;
  const area = eraserBounds(eraser), kept = visible.filter(pen => !touchesStroke(pen, eraser, strokeBounds(pen), area));
  return kept.length === visible.length ? visible : kept;
}
const resolved = new WeakMap<readonly Stroke[], readonly Stroke[]>();
let last: { history: readonly Stroke[]; visible: readonly Stroke[] } | undefined;
function extendsLast(history: readonly Stroke[]): boolean {
  if (!last || history.length !== last.history.length + 1) return false;
  for (let i = 0; i < last.history.length; i++) if (history[i] !== last.history[i]) return false;
  return true;
}
/** Keep eraser gestures in history so undo restores complete removed strokes.
 * Memoised per history array; one appended stroke is resolved incrementally.
 * The result is shared: never mutate it. */
export function visibleStrokes(history: readonly Stroke[]): readonly Stroke[] {
  let visible = resolved.get(history);
  if (!visible) {
    if (extendsLast(history)) {
      const stroke = history.at(-1)!;
      visible = stroke.tool === "pen" ? stroke.points.length ? [...last!.visible, stroke] : last!.visible : erase(last!.visible, stroke);
    } else {
      // Both arrays `erase` can return here are owned by this loop.
      let replay: Stroke[] = [];
      for (const stroke of history) {
        if (stroke.tool === "pen" && stroke.points.length) replay.push(stroke);
        else if (stroke.tool === "eraser") replay = erase(replay, stroke) as Stroke[];
      }
      visible = replay;
    }
    resolved.set(history, visible);
  }
  last = { history, visible };
  return visible;
}
/** Visible committed strokes minus those touched by a still-growing eraser stroke. Never cached. */
export function visibleUnderEraser(visible: readonly Stroke[], eraser: Stroke): readonly Stroke[] {
  return erase(visible, eraser);
}
const ids = new WeakMap<Stroke, number>();
let nextStrokeId = 0;
/** Committed strokes are never mutated or rebuilt, so identity stands for content. */
function strokeId(stroke: Stroke): number {
  let id = ids.get(stroke);
  if (id === undefined) { id = ++nextStrokeId; ids.set(stroke, id); }
  return id;
}
/** History-only edits (or Undo back to the sent drawing) are not new image content.
 * Visible strokes are identified by object identity, not by their points: an
 * erased stroke redrawn with identical coordinates counts as changed. */
export function inkSignature(history: readonly Stroke[], color: string): string {
  const visible = visibleStrokes(history);
  return visible.length ? `${color}|${visible.map(strokeId).join(",")}` : "";
}
export function paintSegment(context: CanvasRenderingContext2D, a: Point, b: Point, color: string): void {
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = strokeWidth(a, b);
  context.beginPath();
  if (a.x === b.x && a.y === b.y) {
    context.arc(a.x, a.y, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
  }
}
export function paintStroke(context: CanvasRenderingContext2D, stroke: Stroke, color: string): void {
  stroke.points.forEach((point, i) => paintSegment(context, stroke.points[Math.max(0, i - 1)]!, point, color));
}
/** Full repaint of already-resolved visible strokes. Leaves the world
 * transform set, so later segments can be painted on top incrementally. */
export function paintStrokes(context: CanvasRenderingContext2D, width: number, height: number, visible: readonly Stroke[], color: string,
  origin: { x: number; y: number } = { x: 0, y: 0 }): void {
  const canvas = context.canvas;
  context.resetTransform();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(canvas.width / width, 0, 0, canvas.height / height, origin.x * canvas.width / width, origin.y * canvas.height / height);
  for (const stroke of visible) paintStroke(context, stroke, color);
}
export function paintInk(canvas: HTMLCanvasElement, width: number, height: number, strokes: readonly Stroke[], color: string,
  origin: { x: number; y: number } = { x: 0, y: 0 }): void {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create the drawing canvas.");
  paintStrokes(context, width, height, visibleStrokes(strokes), color, origin);
}
