import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
test("build refuses symlinked dist and any misplaced dist/data without deleting persistent sentinels", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rich-build-"));
  try {
    fs.mkdirSync(path.join(temporary, "scripts"));
    fs.copyFileSync(path.join(root, "scripts/build.mjs"), path.join(temporary, "scripts/build.mjs"));
    fs.symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "dir");
    const target = path.join(temporary, "preserved"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "record"), "keep");
    const dist = path.join(temporary, "dist"); fs.symlinkSync(target, dist, "dir");
    const run = () => spawnSync(process.execPath, [path.join(temporary, "scripts/build.mjs")], { encoding: "utf8" });
    let result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /symlinked dist/);
    assert.equal(fs.readFileSync(path.join(target, "record"), "utf8"), "keep");
    fs.unlinkSync(dist); fs.mkdirSync(dist);
    for (const kind of ["file", "directory", "symlink"] as const) {
      const misplaced = path.join(dist, "data");
      if (kind === "file") fs.writeFileSync(misplaced, "keep");
      else if (kind === "directory") { fs.mkdirSync(misplaced); fs.writeFileSync(path.join(misplaced, "record"), "keep"); }
      else fs.symlinkSync(target, misplaced, "dir");
      result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /misplaced dist\/data/);
      assert.ok(fs.lstatSync(misplaced)); assert.equal(fs.readFileSync(path.join(target, "record"), "utf8"), "keep");
      fs.rmSync(misplaced, { recursive: true });
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
