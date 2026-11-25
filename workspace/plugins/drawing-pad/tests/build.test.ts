import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const plugin = fileURLToPath(new URL("../", import.meta.url));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-pad-build-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(plugin, "scripts/build.mjs"), path.join(root, "scripts/build.mjs"));
  fs.symlinkSync(path.join(plugin, "node_modules"), path.join(root, "node_modules"));
  return { root, run: () => spawnSync(process.execPath, [path.join(root, "scripts/build.mjs")], { encoding: "utf8" }),
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
it("build refuses linked output without deleting its target", () => {
  const f = fixture(); try {
    const target = path.join(f.root, "preserve"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "marker"), "keep");
    fs.symlinkSync(target, path.join(f.root, "dist")); const result = f.run();
    assert.notEqual(result.status, 0); assert.match(result.stderr, /symlinked dist/); assert.equal(fs.readFileSync(path.join(target, "marker"), "utf8"), "keep");
  } finally { f.close(); }
});
it("build refuses any misplaced dist/data entry without deleting data", () => {
  const f = fixture(); try {
    const output = path.join(f.root, "dist"); fs.mkdirSync(output); fs.writeFileSync(path.join(output, "data"), "keep");
    const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /dist\/data/);
    assert.equal(fs.readFileSync(path.join(output, "data"), "utf8"), "keep");
  } finally { f.close(); }
});
