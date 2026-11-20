/**
 * Local Claude HTTP guards (review fixes S3, S4): POST /api/claude-local
 * takes the subscriptions' body guards (JSON only, 16 KB advertised and
 * streamed), and a binaryPath override can only name an absolute Claude
 * Code executable, written through the same same-origin gate as the
 * connection controls. Offline: a fake `query` through the SDK seam, the
 * route disabled, no `claude` ever spawns.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-local-http-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });

const { setClaudeQueryForTests } = await import("../src/agent/claude-local/sdk.ts");
const server = await import("../src/server/claude-local.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { parseClaudeLocalSettingsBody } = await import("../src/server/settings-body.ts");
const { isSafeBinaryPath, sanitizeUserSettings } = await import("../src/core/settings.ts");
const { readSettingsRecord } = await import("../src/server/index.ts");
const { PUT: putSettingsSection } = await import("../app/api/settings/[section]/route.ts");

// Never a real probe: any query call is a test failure.
setClaudeQueryForTests((() => { throw new Error("no probe in this suite"); }) as never);
writeSettings({ version: 1 });
after(() => { setClaudeQueryForTests(undefined); fs.rmSync(directory, { recursive: true, force: true }); });

const ORIGIN = "http://localhost:3000";
const sameOrigin = { origin: ORIGIN, "x-learnharness-subscriptions": "1" };
const post = (body: BodyInit, headers: Record<string, string> = {}) =>
	new Request(`${ORIGIN}/api/claude-local`, { method: "POST", headers: { ...sameOrigin, ...headers }, body, duplex: "half" } as RequestInit);

describe("POST /api/claude-local body guards (S3)", () => {
	it("refuses a non-JSON content type with 415", async () => {
		const response = await server.claudeLocalControlsResponse(post(JSON.stringify({ op: "probe" }), { "content-type": "text/plain" }));
		assert.equal(response.status, 415);
	});
	it("refuses an advertised body over 16 KB with 413", async () => {
		const response = await server.claudeLocalControlsResponse(post(JSON.stringify({ op: "probe", pad: "x".repeat(17_000) }), { "content-type": "application/json" }));
		assert.equal(response.status, 413);
	});
	it("refuses a streamed body over 16 KB with 413 (no content-length)", async () => {
		const chunk = new TextEncoder().encode(" ".repeat(8192));
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 4) controller.enqueue(chunk); else controller.close(); } });
		const response = await server.claudeLocalControlsResponse(post(stream, { "content-type": "application/json" }));
		assert.equal(response.status, 413);
	});
	it("still answers malformed JSON as an unsupported control", async () => {
		const response = await server.claudeLocalControlsResponse(post("{nope", { "content-type": "application/json" }));
		assert.equal(response.status, 400);
	});
});

describe("binaryPath is an absolute Claude Code executable (S4)", () => {
	it("the PUT parser rejects relative paths and foreign executables, and normalises the stored value", () => {
		for (const binaryPath of ["claude", "./bin/claude", "~/.local/bin/claude", "/tmp/x", "/usr/bin/python3", "/opt/claude/claude.sh", "/a/claude/.."]) {
			const result = parseClaudeLocalSettingsBody({ enabled: true, binaryPath });
			assert.equal(result.ok, false, binaryPath);
			if (!result.ok) assert.match(result.error, /absolute path to claude, claude\.exe, claude\.cmd, cli\.js/);
		}
		const ok = parseClaudeLocalSettingsBody({ binaryPath: " /usr/local/bin/../bin/claude " });
		assert.ok(ok.ok); if (ok.ok) assert.equal(ok.settings.binaryPath, path.resolve("/usr/local/bin/claude"));
		const cli = parseClaudeLocalSettingsBody({ binaryPath: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js" });
		assert.ok(cli.ok);
	});
	it("the shared helper and the sanitizer drop the same values", () => {
		assert.equal(isSafeBinaryPath("/tmp/x"), false);
		assert.equal(isSafeBinaryPath("bin/claude"), false);
		assert.equal(isSafeBinaryPath("C:\\Users\\me\\.local\\bin\\claude.exe"), true);
		assert.deepEqual(sanitizeUserSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: "/tmp/x" } })?.claudeLocal, { enabled: true });
	});
	it("PUT /api/settings/claudeLocal requires a same-origin LearnHarness request", async () => {
		const ctx = { params: Promise.resolve({ section: "claudeLocal" }) };
		const body = JSON.stringify({ enabled: true, binaryPath: "/usr/local/bin/claude" });
		const refused = await putSettingsSection(new Request(`${ORIGIN}/api/settings/claudeLocal`, { method: "PUT", headers: { "content-type": "application/json" }, body }), ctx);
		assert.equal(refused.status, 403);
		assert.match(((await refused.json()) as { error: string }).error, /same-origin LearnHarness request/);
		assert.equal(readSettingsRecord()?.claudeLocal, undefined, "a refused write stores nothing");
		const foreign = await putSettingsSection(new Request(`${ORIGIN}/api/settings/claudeLocal`, { method: "PUT", headers: { "content-type": "application/json", "x-learnharness-subscriptions": "1", origin: "https://evil.invalid" }, body }), ctx);
		assert.equal(foreign.status, 403);
		const accepted = await putSettingsSection(new Request(`${ORIGIN}/api/settings/claudeLocal`, { method: "PUT", headers: { "content-type": "application/json", ...sameOrigin }, body }), ctx);
		assert.equal(accepted.status, 200);
		assert.deepEqual(readSettingsRecord()?.claudeLocal, { enabled: true, binaryPath: "/usr/local/bin/claude" });
		// Other sections keep their existing (header-free) contract.
		const graph = await putSettingsSection(new Request(`${ORIGIN}/api/settings/graph`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ section: "graph" }) });
		assert.equal(graph.status, 200);
	});
});
