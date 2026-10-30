import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

for (const fail of [false, true]) {
	test(`test launcher isolates storage and cleans up after ${fail ? "failure" : "success"}`, () => {
		const dir = mkdtempSync(path.join(tmpdir(), "lh-runner-proof-"));
		try {
			const auth = path.join(dir, "auth.json");
			const marker = path.join(dir, "paths.json");
			const fixture = path.join(dir, "fixture.test.mjs");
			writeFileSync(auth, "real auth sentinel");
			writeFileSync(fixture, `
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PATHS } from ${JSON.stringify(pathToFileURL(path.join(root, "config.ts")).href)};
assert.equal(process.env.NODE_ENV, "test");
assert.notEqual(PATHS.data, ${JSON.stringify(dir)});
assert.notEqual(PATHS.data, ${JSON.stringify(path.join(root, "data"))});
mkdirSync(PATHS.graph, { recursive: true });
writeFileSync(path.join(PATHS.graph, "positions.json"), "fixture positions");
writeFileSync(process.env.LH_AUTH_FILE, "fixture auth");
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ data: PATHS.data, auth: process.env.LH_AUTH_FILE }));
${fail ? 'throw new Error("intentional fixture failure");' : ""}
`);
			const result = spawnSync(process.execPath, ["scripts/test.mjs", fixture], {
				cwd: root, encoding: "utf8",
				env: { ...process.env, LH_DATA_DIR: dir, LH_AUTH_FILE: auth },
			});
			assert.equal(result.status, fail ? 1 : 0, result.stdout + result.stderr);
			assert.equal(readFileSync(auth, "utf8"), "real auth sentinel");
			assert.equal(existsSync(path.join(dir, "graph")), false);
			const used = JSON.parse(readFileSync(marker, "utf8")) as { data: string; auth: string };
			assert.equal(existsSync(used.data), false, "temporary data is removed");
			assert.equal(existsSync(used.auth), false, "temporary auth is removed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
