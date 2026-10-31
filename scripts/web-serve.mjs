/**
 * Web run mode (mobile-web, 2026-10-29).
 *
 * Serves the PRODUCTION build from the repo root: `next start` keeps every
 * path anchored where the app expects it (prompts in src/, auth.json at the
 * root, data/ unless LH_DATA_DIR says otherwise), which is exactly what the
 * standalone output loses when it is launched from .next/standalone.
 *
 * Loopback only by design — the phone reaches it through `ssh -L`.
 *
 * Usage:
 *   npm run web                 # build + serve on 127.0.0.1:3000
 *   PORT=4000 npm run web
 *   npm run web -- --build      # force a fresh build (default when .next is absent)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const host = process.env.HOSTNAME?.trim() || "127.0.0.1";
const port = process.env.PORT?.trim() || "3000";
const dataDir = process.env.LH_DATA_DIR?.trim() || path.join(repo, "data");

if (!fs.existsSync(path.join(repo, ".next", "BUILD_ID"))) {
	console.error("No production build found — run `npm run build` first (or `npm run web:build`).");
	process.exit(1);
}

// Never write inside a bundle: the data root must be explicit and writable.
fs.mkdirSync(dataDir, { recursive: true });

console.log(`LearnHarness web → http://${host}:${port}  (data: ${dataDir})`);
console.log("Phone access: ssh -L 3000:127.0.0.1:3000 user@this-host, then open http://localhost:3000");

const child = spawn(
	process.execPath,
	[path.join(repo, "node_modules", "next", "dist", "bin", "next"), "start", "-H", host, "-p", port],
	{
		cwd: repo,
		stdio: "inherit",
		env: { ...process.env, NODE_ENV: "production", LH_DATA_DIR: dataDir },
	},
);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 0));
