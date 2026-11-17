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
function touchesStroke(stroke: Stroke, eraser: Stroke): boolean {
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
/** Keep eraser gestures in history so undo restores complete removed strokes. */
export function visibleStrokes(history: readonly Stroke[]): Stroke[] {
  let visible: Stroke[] = [];
  for (const stroke of history) {
    if (stroke.tool === "pen" && stroke.points.length) visible.push(stroke);
    else if (stroke.tool === "eraser") visible = visible.filter(pen => !touchesStroke(pen, stroke));
  }
  return visible;
}
/** History-only edits (or Undo back to the sent drawing) are not new image content. */
export function inkSignature(history: readonly Stroke[], color: string): string {
  const visible = visibleStrokes(history);
  return visible.length ? JSON.stringify([color, visible.map(stroke => stroke.points)]) : "";
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
export function paintInk(canvas: HTMLCanvasElement, width: number, height: number, strokes: readonly Stroke[], color: string,
  origin: { x: number; y: number } = { x: 0, y: 0 }): void {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create the drawing canvas.");
  context.resetTransform();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(canvas.width / width, 0, 0, canvas.height / height, origin.x * canvas.width / width, origin.y * canvas.height / height);
  for (const stroke of visibleStrokes(strokes)) {
    stroke.points.forEach((point, i) => paintSegment(context, stroke.points[Math.max(0, i - 1)]!, point, color));
  }
}
