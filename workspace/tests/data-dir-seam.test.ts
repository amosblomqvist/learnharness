/**
 * The LH_DATA_DIR seam (Electron contract, 2026-09-17): when set, every
 * mutable record relocates under it; when unset, byte-for-byte the old
 * repo-data/ behavior. The desktop shell's whole data story rests on this,
 * so pin both directions.
 *
 * The seam is evaluated at MODULE LOAD, so the "set" case must set the env
 * BEFORE the first import of config.ts in this process (dynamic import,
 * below) and the "unset" case needs a fresh child process.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

describe("LH_DATA_DIR seam", () => {
	it("relocates data/chats/graph under LH_DATA_DIR, keeps prompts ROOT-anchored", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-seam-"));
		process.env.LH_DATA_DIR = dir;
		try {
			const { PATHS, ROOT } = await import("../config.ts");
			assert.equal(PATHS.data, dir, "PATHS.data resolves the env value (resolved absolute)");
			assert.equal(PATHS.chats, path.join(dir, "chats"));
			assert.equal(PATHS.graph, path.join(dir, "graph"));
			assert.equal(
				PATHS.teacherPrompt,
				path.join(ROOT, "src", "agent", "system-prompt.md"),
				"read-only prompt assets stay bundle-anchored on purpose",
			);
		} finally {
			delete process.env.LH_DATA_DIR;
		}
	});

	function resolveUnset(nodeEnv: "test" | undefined): { data: string; chats: string; auth: string } {
		const env: Record<string, string | undefined> = { ...process.env };
		delete env.LH_DATA_DIR;
		delete env.LH_AUTH_FILE;
		if (nodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = nodeEnv;
		const out = execFileSync(
			process.execPath,
			["--import", pathToFileURL(TSX_LOADER).href, "--eval", `const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "config.ts")).href)}); console.log(JSON.stringify({ data: m.PATHS.data, chats: m.PATHS.chats, auth: m.AUTH_FILE }));`],
			{ cwd: REPO_ROOT, encoding: "utf-8", env },
		);
		return JSON.parse(out) as { data: string; chats: string; auth: string };
	}

	it("unset = the repo data/ exactly as before (fresh child process, no env)", () => {
		const parsed = resolveUnset(undefined);
		assert.equal(parsed.data, path.join(REPO_ROOT, "data"));
		assert.equal(parsed.chats, path.join(REPO_ROOT, "data", "chats"));
		assert.equal(parsed.auth, path.join(REPO_ROOT, "auth.json"));
	});

	it("unset under NODE_ENV=test = a temp profile, never the repo data/ or auth.json", () => {
		const parsed = resolveUnset("test");
		const tmp = fs.realpathSync(os.tmpdir());
		for (const value of [parsed.data, parsed.auth]) {
			assert.ok(!value.startsWith(REPO_ROOT), `${value} must stay outside the repo`);
			assert.ok(fs.realpathSync(path.dirname(value)).startsWith(tmp), `${value} must live under the OS temp dir`);
		}
		assert.equal(path.dirname(parsed.data), path.dirname(parsed.auth), "data and auth share one test profile");
	});
});