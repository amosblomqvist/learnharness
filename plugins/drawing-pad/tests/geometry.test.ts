import assert from "node:assert/strict";
import { it } from "node:test";
import { exportBounds, exportRaster, inkBounds, referenceBounds, viewOrigin } from "../src/geometry.ts";
import type { Stroke } from "../src/strokes.ts";
const pen = (x: number, y: number, pressure = .5): Stroke => ({ tool: "pen", points: [{ x, y, pressure }] });
it("resize changes translation, never world scale; widening reveals both sides", () => {
  assert.deepEqual(viewOrigin(800, 600, { x: 0, y: 0 }), { x: 400, y: 300 });
  assert.deepEqual(viewOrigin(1200, 600, { x: 0, y: 0 }), { x: 600, y: 300 });
  assert.deepEqual(viewOrigin(1200, 600, { x: -1200, y: 2000 }), { x: -600, y: 2300 });
  assert.deepEqual(referenceBounds(600, 200), { x: -300, y: -100, width: 600, height: 200 });
});
it("reference bottom remains 24px above the viewport edge, independent of height and pan", () => {
  for (const [width, height, referenceHeight] of [[800, 600, 200], [1200, 900, 200], [300, 200, 1000]]) {
    const origin = viewOrigin(width!, height!, { x: 0, y: 0 }, referenceHeight!);
    assert.equal(origin.x, width! / 2); assert.equal(origin.y + referenceHeight! / 2, height! - 24);
    const panned = viewOrigin(width!, height!, { x: -400, y: 300 }, referenceHeight!);
    assert.equal(panned.x, origin.x - 400); assert.equal(panned.y, origin.y + 300);
  }
});
it("bottom anchoring changes only the camera, never reference/export world bounds", () => {
  const history = [pen(-100, 300)]; const before = exportBounds(670, 250, history);
  assert.deepEqual(viewOrigin(1000, 700, { x: 90, y: -120 }, 250), { x: 590, y: 431 });
  assert.deepEqual(viewOrigin(1400, 900, { x: 90, y: -120 }, 250), { x: 790, y: 631 });
  assert.deepEqual(exportBounds(670, 250, history), before);
});
it("ink bounds include dot pressure and negative/remote coordinates", () => {
  assert.deepEqual(inkBounds([pen(-2000, 3000, 1)]), { x: -2002.25, y: 2997.75, width: 4.5, height: 4.5 });
});
it("bounds include both endpoints and full radius of each variable-pressure segment", () => {
  assert.deepEqual(inkBounds([{ tool: "pen", points: [{ x: -20, y: 10, pressure: 0 }, { x: 200, y: -100, pressure: 1 }] }]),
    { x: -21.5, y: -101.5, width: 223, height: 113 });
});
it("export is the union of complete reference and visible ink plus existing margin", () => {
  assert.deepEqual(exportBounds(600, 200, [pen(1000, -500)]), { x: -324, y: -526, width: 1350, height: 650 });
});
it("blank references export only the minimal ink region, not the origin or viewport", () => {
  assert.deepEqual(exportBounds(0, 0, [pen(-2000, 3000)]), { x: -2026, y: 2974, width: 52, height: 52 });
});
it("export raster preserves ordinary density and uniformly downsamples large crops", () => {
  assert.deepEqual(exportRaster({ x: -500, y: -100, width: 800, height: 500 }, 2, 100), { width: 1600, height: 1000 });
  assert.deepEqual(exportRaster({ x: -20000, y: 9000, width: 10000, height: 5000 }, 2, 100), { width: 2000, height: 1000 });
  assert.deepEqual(exportRaster({ x: 10, y: -50000, width: 2000, height: 10000 }, 1, 100), { width: 400, height: 2000 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 1, height: 1e8 }, 2, 100), { width: 1, height: 2000 });
});
it("image scale applies before the fixed cap rather than shrinking an already capped image", () => {
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 1000, height: 600 }, 1, 50), { width: 500, height: 300 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 6000, height: 4000 }, 1, 50), { width: 2000, height: 1333 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 6000, height: 4000 }, 1, 25), { width: 1500, height: 1000 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 1000, height: 600 }, 2, 50), { width: 1000, height: 600 });
  for (const scale of [0, -1, 101, Infinity, NaN]) assert.throws(() => exportRaster({ x: 0, y: 0, width: 100, height: 100 }, 1, scale), /kept/);
});
it("impossible export bounds fail closed before bitmap allocation", () => {
  for (const width of [0, -1, Infinity, NaN]) assert.throws(() => exportRaster({ x: 0, y: 0, width, height: 100 }, 1, 100), /kept/);
  assert.throws(() => exportRaster({ x: Infinity, y: 0, width: 100, height: 100 }, 1, 100), /kept/);
});
it("erased distant strokes do not expand the crop and Undo restores their bounds", () => {
  const far = pen(-100000, 4000), near = pen(0, 0), erase: Stroke = { tool: "eraser", points: far.points };
  assert.deepEqual(exportBounds(0, 0, [far, near, erase]), { x: -26, y: -26, width: 52, height: 52 });
  assert.ok(exportBounds(0, 0, [far, near])!.width > 100000);
  assert.equal(exportBounds(600, 200, [far, erase]), undefined);
  assert.equal(inkBounds([]), undefined);
});
