// THE PRELOAD LAW: loaded via `--import` before ANY repo module of a test
// process — config.ts resolves PATHS at first import, so every module the
// process later loads sees the isolated dir below.
//
// Per-process uniqueness IS the guarantee: `node --test` runs each test file
// in its own child process (isolation mode "process"), so parallel suites
// never share a dir. An inherited LH_DATA_DIR from the runner env is
// deliberately overwritten — parallel sibling processes would share it.
//
// The `exit` hook reclaims the scratch dir synchronously; suites that rm
// their own overrides are unaffected.
//
// THE CHILD-SPAWN TRAP: any child process a suite spawns inherits this env
// value — a suite that needs the unset-seam behavior (tests/data-dir-seam.test.ts)
// must strip LH_DATA_DIR/LH_AUTH_FILE explicitly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-data-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
if (!process.env.LH_AUTH_FILE) process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", "utf-8");

process.on("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
