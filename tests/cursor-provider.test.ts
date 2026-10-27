/** Cursor stays offline in npm test. The proxy test speaks to a fake binary. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { subscriptionLabel } from "../src/core/prices.ts";
import { providerKeyMissing } from "../src/core/settings.ts";
import { cursorConnected, cursorStatusLooksLoggedIn } from "../src/agent/cursor/login.ts";
import { parseCursorModelList } from "../src/agent/cursor/provider.ts";
import {
	buildCursorPrompt,
	nextTextDelta,
	parseToolEnvelope,
	type DeltaState,
} from "../src/agent/cursor/protocol.ts";
import { startCursorProxy, stopCursorProxy } from "../src/agent/cursor/proxy.ts";
import { catalogProviders, modelCatalog } from "../src/server/model-catalog.ts";
import { providerKeyPresent } from "../src/server/keys.ts";

const FAKE_AGENT = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const text = prompt.includes("Tools:")
	? '{"name":"ping","arguments":{"word":"pong"}}'
	: "PONG";
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
send({ type: "thinking", subtype: "delta", text: "hmm" });
send({ type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text }] } });
send({ type: "tool_call", name: "shell" });
send({ type: "result", subtype: "success", result: text });
`;

test("prompt, envelope, and deltas stay pure", () => {
	const prompt = buildCursorPrompt(
		[
			{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url" }] },
			{ role: "tool", tool_call_id: "call_1", content: "ok" },
		],
		[{ name: "ping", description: "say it", parameters: { type: "object" } }],
	);
	assert.match(prompt, /\[image\]/);
	assert.match(prompt, /Tool result \(call_1\)/);
	assert.match(prompt, /"name": "ping"/);
	assert.equal(parseToolEnvelope('```json\n{"name":"ping","arguments":{"word":"pong"}}\n```', new Set(["ping"]))?.[0]?.name, "ping");
	assert.equal(parseToolEnvelope('{"name":"shell","arguments":{}}', new Set(["ping"])), null);
	assert.equal(parseToolEnvelope("just prose", new Set(["ping"])), null);
	const state: DeltaState = { acc: "" };
	assert.equal(nextTextDelta(state, "PO", true), "PO");
	assert.equal(nextTextDelta(state, "PONG", false), "NG");
	assert.equal(state.acc, "PONG");
});

test("model list keeps display names and drops the default marker", () => {
	const models = parseCursorModelList([
		"Available models",
		"",
		"auto - Auto (default)",
		"composer-2.5 - Composer 2.5 (current)",
		"claude-fable-5-thinking-high - Claude Fable 5 1M Thinking (NO ZDR)",
	].join("\n"));
	assert.deepEqual(models, [
		{ id: "auto", name: "Auto" },
		{ id: "composer-2.5", name: "Composer 2.5" },
		{ id: "claude-fable-5-thinking-high", name: "Claude Fable 5 1M Thinking (NO ZDR)" },
	]);
});

test("signed-out status text is not treated as a login", () => {
	assert.equal(cursorStatusLooksLoggedIn("✓ Logged in as person@example.com"), true);
	assert.equal(cursorStatusLooksLoggedIn("Login successful!"), true);
	assert.equal(cursorStatusLooksLoggedIn("Logged in (user details not available)"), true);
	assert.equal(cursorStatusLooksLoggedIn("Not logged in"), false);
	assert.equal(cursorStatusLooksLoggedIn(""), false);
});

test("cursor login gates the picker", () => {
	const previous = process.env.LH_CURSOR_CONNECTED;
	try {
		delete process.env.LH_CURSOR_CONNECTED;
		assert.equal(cursorConnected(), false);
		assert.equal(providerKeyPresent("cursor"), false);
		const row = catalogProviders().find((provider) => provider.id === "cursor");
		assert.ok(row);
		assert.equal(row.envVar, "");
		assert.equal(row.keyPresent, false);
		assert.equal(modelCatalog().models.some((model) => model.provider === "cursor"), false);
		assert.match(providerKeyMissing("cursor", ["strong"]).error, /cursor-agent login/);
		assert.equal(subscriptionLabel("cursor:auto"), "Cursor");

		process.env.LH_CURSOR_CONNECTED = "1";
		assert.equal(providerKeyPresent("cursor"), true);
		const ids = modelCatalog().models.filter((model) => model.provider === "cursor").map((model) => model.id).sort();
		assert.deepEqual(ids, ["auto", "composer-2.5"]);
		assert.equal(modelCatalog().models.find((model) => model.provider === "cursor")?.input.includes("image"), false);
	} finally {
		if (previous === undefined) delete process.env.LH_CURSOR_CONNECTED;
		else process.env.LH_CURSOR_CONNECTED = previous;
	}
});

test("the loopback proxy streams text and a tool call from a fake agent", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lh-cursor-"));
	const bin = join(dir, "agent");
	const previousBin = process.env.CURSOR_AGENT_BIN;
	const previousWorkspace = process.env.LEARNHARNESS_CURSOR_WORKSPACE;
	writeFileSync(bin, FAKE_AGENT, { mode: 0o755 });
	process.env.CURSOR_AGENT_BIN = bin;
	process.env.LEARNHARNESS_CURSOR_WORKSPACE = dir;
	try {
		const port = await startCursorProxy(0);
		const health = await fetch(`http://127.0.0.1:${port}/health`);
		assert.equal((await health.json()).ok, true);
		const text = await complete(port, { model: "auto", messages: [{ role: "user", content: "hi" }] });
		assert.match(text, /reasoning_content/);
		assert.match(text, /PONG/);
		assert.match(text, /"finish_reason":"stop"/);
		assert.doesNotMatch(text, /shell/);
		const tools = await complete(port, {
			model: "auto",
			messages: [{ role: "user", content: "ping" }],
			tools: [{ type: "function", function: { name: "ping", parameters: { type: "object" } } }],
		});
		assert.match(tools, /"name":"ping"/);
		assert.match(tools, /\\"word\\":\\"pong\\"/);
		assert.match(tools, /"finish_reason":"tool_calls"/);
	} finally {
		await stopCursorProxy();
		if (previousBin === undefined) delete process.env.CURSOR_AGENT_BIN;
		else process.env.CURSOR_AGENT_BIN = previousBin;
		if (previousWorkspace === undefined) delete process.env.LEARNHARNESS_CURSOR_WORKSPACE;
		else process.env.LEARNHARNESS_CURSOR_WORKSPACE = previousWorkspace;
		rmSync(dir, { recursive: true, force: true });
	}
});

async function complete(port: number, body: unknown): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	assert.equal(response.status, 200);
	return response.text();
}
