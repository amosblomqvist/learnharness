/**
 * The Anthropic workspace header (src/agent/models.ts). API keys that are
 * not scoped to a workspace are rejected unless each request carries
 * anthropic-workspace-id; ANTHROPIC_WORKSPACE_ID (Settings → Keys, or the
 * real env) supplies it. The request is captured at fetch, nothing leaves.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anthropic-workspace-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), ANTHROPIC_API_KEY: "fixture", OPENAI_API_KEY: "fixture" };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
const { piEngineForSpec } = await import("../src/agent/models.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true }); });

const context = normalizeContext({ systemPrompt: "Stable instructions", messages: [{ role: "user", content: "offline", timestamp: 1 }] });

async function sentHeaders(provider: string, id: string, headers?: Record<string, string>): Promise<Headers> {
	const engine = piEngineForSpec({ provider, id, thinkingLevel: "off" });
	let captured: Headers | undefined;
	const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
		captured = new Headers(init?.headers);
		throw new Error("CLOSED: captured request");
	};
	await engine.streamFn(engine.model, context, { fetch, headers, maxRetries: 0 } as never).result();
	assert.ok(captured, "the request reached fetch");
	return captured;
}

test("no workspace configured: no header", async () => {
	delete process.env.ANTHROPIC_WORKSPACE_ID;
	assert.equal((await sentHeaders("anthropic", "claude-sonnet-4-6")).get("anthropic-workspace-id"), null);
});

test("a configured workspace rides every direct Anthropic request, read per request and trimmed", async () => {
	process.env.ANTHROPIC_WORKSPACE_ID = " wrkspc_first ";
	assert.equal((await sentHeaders("anthropic", "claude-sonnet-4-6")).get("anthropic-workspace-id"), "wrkspc_first");
	process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_second";
	assert.equal((await sentHeaders("anthropic", "claude-sonnet-4-6")).get("anthropic-workspace-id"), "wrkspc_second");
});

test("an explicit caller header wins over the configured workspace", async () => {
	process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_configured";
	const headers = await sentHeaders("anthropic", "claude-sonnet-4-6", { "anthropic-workspace-id": "wrkspc_caller" });
	assert.equal(headers.get("anthropic-workspace-id"), "wrkspc_caller");
});

test("other providers never receive the Anthropic workspace", async () => {
	process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_configured";
	assert.equal((await sentHeaders("openai", "gpt-4.1")).get("anthropic-workspace-id"), null);
});
