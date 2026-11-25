/**
 * Preloaded with `node --import` by `npm test`, before any test file. Gives
 * every test process its own empty HOME, data dir and auth file so no test
 * can read, rename or delete the real ones (config.ts falls back to the
 * repo's data/ and auth.json when LH_DATA_DIR / LH_AUTH_FILE are unset).
 * Always overrides: a value already in the environment may be the real one.
 * Test files that need their own folder still set theirs before importing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-"));
process.env.HOME = path.join(root, "home");
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
