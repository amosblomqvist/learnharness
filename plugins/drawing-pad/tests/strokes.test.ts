import assert from "node:assert/strict";
import { it } from "node:test";
import { inkSignature, strokeWidth, visibleStrokes, type Point, type Stroke } from "../src/strokes.ts";
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
