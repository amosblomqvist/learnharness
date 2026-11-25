import assert from "node:assert/strict";
import { it } from "node:test";
import { inkSignature, liveBounds, strokeBounds, strokeWidth, visibleStrokes, visibleUnderEraser, type Point, type Stroke } from "../src/strokes.ts";
const point = (x: number, y = 0, pressure = .5): Point => ({ x, y, pressure });
const pen = (points: Point[]): Stroke => ({ tool: "pen", points });
const erase = (points: Point[]): Stroke => ({ tool: "eraser", points });

it("uses reference pressure widths, including fixed mouse pressure", () => {
  assert.equal(strokeWidth(point(0, 0, 0), point(0, 0, 0)), 1.5);
  assert.equal(strokeWidth(point(0), point(1)), 3);
  assert.equal(strokeWidth(point(0, 0, 1), point(0, 0, 1)), 4.5);
});
it("erases a whole crossing stroke, not only its touched segment", () => {
  const a = pen([point(0), point(100)]), b = pen([point(0, 60), point(100, 60)]);
  assert.deepEqual(visibleStrokes([a, b, erase([point(50, -30), point(50, 30)])]), [b]);
});
it("handles dot strokes and single-contact erasers", () => {
  const dot = pen([point(10, 10)]);
  assert.deepEqual(visibleStrokes([dot, erase([point(10, 10)])]), []);
});
it("includes the reference eraser contact radius and ink edge", () => {
  const a = pen([point(0), point(100)]);
  assert.deepEqual(visibleStrokes([a, erase([point(50, 13)])]), []);
  assert.deepEqual(visibleStrokes([a, erase([point(50, 14)])]), [a]);
});
it("undoing an eraser restores exact complete strokes", () => {
  const a = pen([point(0), point(100)]), history = [a, erase([point(50)])];
  assert.equal(visibleStrokes(history).length, 0);
  assert.deepEqual(visibleStrokes(history.slice(0, -1)), [a]);
});
it("a pen stroke drawn after erasing is not retroactively erased", () => {
  const first = pen([point(0)]), next = pen([point(0)]);
  assert.deepEqual(visibleStrokes([first, erase([point(0)]), next]), [next]);
});
it("empty histories, empty pen records and fully erased histories have no signature", () => {
  assert.equal(inkSignature([], "#facc15"), "");
  assert.equal(inkSignature([pen([])], "#facc15"), "");
  assert.equal(inkSignature([pen([point(0)]), erase([point(0)])], "#facc15"), "");
});
it("signatures describe visible content, not no-op eraser history", () => {
  const a = pen([point(0), point(100)]);
  assert.equal(inkSignature([a], "#facc15"), inkSignature([a, erase([point(0, 100)])], "#facc15"));
  assert.notEqual(inkSignature([a], "#facc15"), inkSignature([a], "#ffffff"));
});
it("does not mutate stroke arrays while resolving erasers", () => {
  const a = pen([point(0), point(100)]), history = [a, erase([point(50)])];
  const before = JSON.stringify(history); visibleStrokes(history);
  assert.equal(JSON.stringify(history), before);
});

// Oracle: the uncached resolver from before this change.
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
function naiveTouches(stroke: Stroke, eraser: Stroke): boolean {
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
function naiveVisible(history: readonly Stroke[]): Stroke[] {
  let visible: Stroke[] = [];
  for (const stroke of history) {
    if (stroke.tool === "pen" && stroke.points.length) visible.push(stroke);
    else if (stroke.tool === "eraser") visible = visible.filter(pen => !naiveTouches(pen, stroke));
  }
  return visible;
}
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomStroke(random: () => number, tool?: Stroke["tool"]): Stroke {
  const kind = tool ?? (random() < .7 ? "pen" : "eraser"), roll = random();
  const count = kind === "pen" && roll < .08 ? 0 : roll < .25 ? 1 : 2 + Math.floor(random() * 8);
  let x = random() * 300, y = random() * 300;
  const points: Point[] = [];
  for (let i = 0; i < count; i++) { points.push({ x, y, pressure: random() }); x += (random() - .5) * 60; y += (random() - .5) * 60; }
  return { tool: kind, points };
}
function randomHistory(random: () => number): Stroke[] {
  return Array.from({ length: Math.floor(random() * 61) }, () => randomStroke(random));
}
function assertSameStrokes(actual: readonly Stroke[], expected: readonly Stroke[], message?: string): void {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((stroke, index) => assert.equal(stroke, expected[index], message));
}
it("matches the uncached resolver for fresh, incremental, undo and repeated histories", () => {
  const random = prng(20261116);
  for (let run = 0; run < 200; run++) {
    const history = randomHistory(random), expected = naiveVisible(history);
    assertSameStrokes(visibleStrokes([...history]), expected, `fresh ${run}`);
    let built: Stroke[] = [];
    for (const stroke of history) {
      built = [...built, stroke];
      assertSameStrokes(visibleStrokes(built), naiveVisible(built), `incremental ${run}`);
    }
    if (history.length) {
      visibleStrokes(history);
      const undone = history.slice(0, -1);
      assertSameStrokes(visibleStrokes(undone), naiveVisible(undone), `undo ${run}`);
    }
    const first = visibleStrokes(history), second = visibleStrokes(history);
    assert.equal(second, first, `memo ${run}`); assertSameStrokes(second, expected, `memo ${run}`);
  }
});
it("keeps the exact contact boundary diagonally and for full-pressure strokes", () => {
  const diagonal = pen([point(0, 0), point(100, 100)]), normal = (distance: number) => point(50 + distance / Math.SQRT2, 50 - distance / Math.SQRT2);
  for (const [distance, kept] of [[13, 0], [14, 1]] as const) {
    const history = [diagonal, erase([normal(distance)])];
    assert.equal(visibleStrokes(history).length, kept); assertSameStrokes(visibleStrokes(history), naiveVisible(history));
  }
  const heavy = pen([point(0, 0, 1), point(100, 0, 1)]);
  assert.equal(strokeWidth(heavy.points[0]!, heavy.points[1]!), 4.5);
  for (const [y, kept] of [[14.25, 0], [14.26, 1]] as const) {
    const history = [heavy, erase([point(50, y)])];
    assert.equal(visibleStrokes(history).length, kept); assertSameStrokes(visibleStrokes(history), naiveVisible(history));
  }
});
it("returns the identical visible array for a missing eraser and shares prefix strokes after a pen stroke", () => {
  const a = pen([point(0), point(100)]), b = pen([point(0, 60), point(100, 60)]);
  const history = [a, b], visible = visibleStrokes(history);
  const missed = [...history, erase([point(500, 500), point(520, 520)])];
  assert.equal(visibleStrokes(missed), visible);
  const c = pen([point(0, 200)]), extended = visibleStrokes([...missed, c]);
  assert.notEqual(extended, visible); assert.equal(extended.length, 3);
  assert.equal(extended[0], visible[0]); assert.equal(extended[1], visible[1]); assert.equal(extended[2], c);
});
it("resolves a live eraser like committing it, without caching", () => {
  const random = prng(7);
  for (let run = 0; run < 100; run++) {
    const history = randomHistory(random), eraser = randomStroke(random, "eraser"), visible = visibleStrokes(history);
    const live = visibleUnderEraser(visible, eraser);
    assertSameStrokes(live, naiveVisible([...history, eraser]), `live ${run}`);
    if (live.length === visible.length) assert.equal(live, visible);
  }
  const a = pen([point(0), point(100)]), growing: Stroke = { tool: "eraser", points: [point(50, 200)] }, visible = visibleStrokes([a]);
  assert.equal(visibleUnderEraser(visible, growing), visible);
  growing.points.push(point(50, 0));
  assert.deepEqual(visibleUnderEraser(visible, growing), []);
});
it("measures committed and live bounds including each segment's half width", () => {
  const stroke = pen([point(0, 0, 0), point(10, 20, 1)]);
  assert.deepEqual(strokeBounds(stroke), { left: -1.5, top: -1.5, right: 11.5, bottom: 21.5 });
  assert.equal(strokeBounds(stroke), strokeBounds(stroke));
  const live = pen([point(0, 0, 0)]), first = liveBounds(live);
  live.points.push(point(10, 20, 1));
  assert.notDeepEqual(liveBounds(live), first); assert.deepEqual(liveBounds(live), { left: -1.5, top: -1.5, right: 11.5, bottom: 21.5 });
});
it("never returns the input history array", () => {
  const history = [pen([point(0)]), pen([point(50)])];
  assert.notEqual(visibleStrokes(history), history); assert.notEqual(visibleStrokes([...history]), history);
});
