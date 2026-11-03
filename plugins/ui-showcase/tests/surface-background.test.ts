import assert from "node:assert/strict";
import { test } from "node:test";
import { openSurfaceDemo } from "../src/surfaces.ts";
import { createFixture } from "./fixture.ts";

test("surface demo uses public background updates and local Reset restores dimmed without reopening", async () => {
  const f = createFixture();
  try {
    const target = Object.freeze({}) as Parameters<typeof openSurfaceDemo>[1];
    const handle = openSurfaceDemo(f.ui, target, f.controller.signal);
    const surface = f.records.find(entry => entry.method === "openSurface")!;
    assert.equal(handle, surface.handle);
    assert.equal(surface.target, target);
    assert.ok(surface.container.querySelector(".ui-showcase.ui-showcase-surface"));
    assert.equal(f.state("surfaces").background, "dimmed");
    await f.find("surface-background-opaque").props.onClick();
    assert.deepEqual(surface.updates.at(-1), { background: "opaque" });
    assert.equal(f.state("surfaces").background, "opaque");
    await f.find("surface-background-dimmed").props.onClick();
    assert.deepEqual(surface.updates.at(-1), { background: "dimmed" });
    await f.find("surface-background-opaque").props.onClick();
    await f.find("reset-surfaces").props.onClick();
    assert.deepEqual(surface.updates.at(-1), { background: "dimmed" });
    assert.equal(f.state("surfaces").background, "dimmed");
    assert.equal(f.records.filter(entry => entry.method === "openSurface").length, 1);
    assert.equal(surface.disposed, 0);
    await f.find("surface-nested").props.onClick();
    const child = f.records.findLast(entry => entry.method === "openSurface")!;
    assert.ok(child.container.querySelector(".ui-showcase.ui-showcase-surface"));
    assert.deepEqual(f.calls, [], "appearance demo uses no backend, storage, or model APIs");
  } finally { f.restore(); }
});
