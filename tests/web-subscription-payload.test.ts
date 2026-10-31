/** Exercise the real curator against synthetic payloads, never the repo payload. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const name of ["chatgpt-credentials.json", "github-copilot-credentials.json", "xai-credentials.json"]) {
	for (const secret of [name, `${name}.fixture.tmp`]) test(`payload curator refuses web credentials: ${secret}`, () => {
		const root = mkdtempSync(path.join(tmpdir(), "lh-sub-payload-"));
		try {
			mkdirSync(path.join(root, "scripts")); mkdirSync(path.join(root, ".next", "standalone"), { recursive: true }); mkdirSync(path.join(root, ".next", "static"));
			copyFileSync(new URL("../scripts/build-server.mjs", import.meta.url), path.join(root, "scripts", "build-server.mjs"));
			writeFileSync(path.join(root, ".next", "standalone", "server.js"), "// fixture");
			writeFileSync(path.join(root, ".next", "standalone", secret), "fixture-not-real-credentials", { mode: 0o600 });
			const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-server.mjs")], { encoding: "utf8", env: process.env });
			assert.equal(result.status, 1); assert(result.stderr.includes(`REFUSING: standalone contains ${secret}`));
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}
