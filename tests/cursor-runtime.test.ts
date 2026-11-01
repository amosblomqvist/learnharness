import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { startCursorProxy, stopCursorProxy } from "../src/agent/cursor/proxy.ts";

const directory = mkdtempSync(join(tmpdir(), "lh-cursor-runtime-"));
const originalEnv = process.env;
process.env = { ...originalEnv, NODE_ENV: "test", CURSOR_AGENT_BIN: join(directory, "agent"), LEARNHARNESS_CURSOR_WORKSPACE: directory };
// Reserve an ephemeral port before the process-wide catalog captures its URL.
const port = await startCursorProxy(0);
await stopCursorProxy();
process.env.LEARNHARNESS_CURSOR_PORT = String(port);
const { piEngineForSpec } = await import("../src/agent/models.ts");
after(async () => { await stopCursorProxy(); process.env = originalEnv; rmSync(directory, { recursive: true, force: true }); });

function agent(source: string) {
	process.env.CURSOR_AGENT_BIN = join(directory, "agent");
	writeFileSync(process.env.CURSOR_AGENT_BIN, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
}

async function reply(prompt = "hello") {
	const engine = piEngineForSpec({ provider: "cursor", id: "auto" });
	return engine.streamFn(engine.model, normalizeContext({
		messages: [{ role: "user", content: prompt, timestamp: 1 }],
	}), { signal: AbortSignal.timeout(10_000) }).result();
}

test("Cursor engine starts its bridge and streams text and tool calls", async () => {
	agent(`
const text = process.argv.at(-1).includes('Tools:') ? '{"name":"ping","arguments":{"word":"pong"}}' : 'PONG';
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: text }) + '\\n');
`);
	const text = await reply();
	assert.equal(text.stopReason, "stop", text.errorMessage);
	assert.deepEqual(text.content.filter((part) => part.type === "text").map((part) => part.text), ["PONG"]);
	const engine = piEngineForSpec({ provider: "cursor", id: "auto" });
	const toolReply = await engine.streamFn(engine.model, normalizeContext({
		messages: [{ role: "user", content: "ping", timestamp: 1 }],
		tools: [{ name: "ping", description: "Say pong", parameters: Type.Object({ word: Type.String() }) }],
	}), { signal: AbortSignal.timeout(10_000) }).result();
	assert.equal(toolReply.stopReason, "toolUse", toolReply.errorMessage);
	const calls = toolReply.content.filter((part) => part.type === "toolCall");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.name, "ping");
	assert.deepEqual(calls[0]?.arguments, { word: "pong" });
});

test("Cursor delivers a conversation larger than the OS argument limit through stdin", async () => {
	agent(`
const input = require('node:fs').readFileSync(0, 'utf8');
const args = process.argv.slice(2);
// Like the real CLI, a positional prompt takes precedence over stdin.
const prompt = args.length > args.indexOf('--workspace') + 2 ? args.at(-1) : input;
const count = /LONG_START(x+)LONG_END/.exec(prompt)?.[1].length;
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: String(count) }) + '\\n');
`);
	const result = await reply(`LONG_START${"x".repeat(150_000)}LONG_END`);
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.deepEqual(result.content.filter((part) => part.type === "text").map((part) => part.text), ["150000"]);
});

test("Cursor reports a missing executable without crashing the server", async () => {
	process.env.CURSOR_AGENT_BIN = join(directory, "missing-agent");
	const result = await reply();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /ENOENT|not found/i);
	assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
});

test("Cursor result errors remain model errors instead of successful lesson text", async () => {
	agent(`process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, error: { message: 'Cursor quota exceeded' } }) + '\\n');`);
	const result = await reply();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /quota exceeded/);
});

test("Cursor nonzero exits remain model errors", async () => {
	agent(`process.stderr.write('Cursor login expired'); process.exitCode = 1;`);
	const result = await reply();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /login expired/);
});

test("Cursor consumes a final result without a trailing newline", async () => {
	agent(`process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Final answer' }));`);
	const result = await reply();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.deepEqual(result.content.filter((part) => part.type === "text").map((part) => part.text), ["Final answer"]);
});
