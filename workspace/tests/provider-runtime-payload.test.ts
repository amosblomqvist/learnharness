/** Real installed Pi/Google/Bedrock SDKs only; no provider stubs, keys, or generation. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/smoke-provider-runtime.mjs", import.meta.url));
const checkout = fileURLToPath(new URL("..", import.meta.url));
const run = (payload: string) => spawnSync(process.execPath, [script, "--standalone", payload], { encoding: "utf8", timeout: 40_000 });

describe("offline native Pi Google initialization gate", () => {
	it("reaches the sentinel for Google, Google-backed OpenCode and Bedrock adapters using the real SDKs", () => {
		// This is an unbundled positive control, NOT proof of standalone completeness.
		const result = run(checkout);
		assert.equal(result.status, 0, String(result.stderr));
		for (const provider of ["google", "opencode", "opencode-go"]) assert.ok(String(result.stdout).includes(`${provider}: native lazy Google adapter reached onPayload`));
		assert.ok(String(result.stdout).includes("amazon-bedrock: native lazy Bedrock adapter reached onPayload"));
		assert.match(String(result.stdout), /zero network attempts/);
	});
	it("rejects a missing Pi entry instead of treating any error as success", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-provider-missing-"));
		try {
			const result = run(root);
			assert.equal(result.status, 1);
			assert.doesNotMatch(String(result.stdout), /initialization passed/);
			assert.match(String(result.stderr), /MODULE_NOT_FOUND|ENOENT/);
			assert.deepEqual(fs.readdirSync(root), [], "gate modified the payload");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
	it("rejects an otherwise complete SDK outside the payload (no host fallback)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-provider-escape-"));
		try {
			fs.symlinkSync(path.join(checkout, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
			const result = run(root);
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /dependency escaped standalone payload/);
			assert.doesNotMatch(String(result.stdout), /initialization passed/);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});
