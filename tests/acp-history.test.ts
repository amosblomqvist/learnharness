import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it, type TestContext } from "node:test";
import { AcpClient } from "../src/agent/acp/client.ts";
import { createAcpEngine, closeAcpSessions } from "../src/agent/acp/engine.ts";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { toToolResult } from "../src/agent/tool-execute.ts";
const { nativeLaunch } = createRequire(import.meta.url)("../src/agent/acp/codex-ephemeral.cjs");

function offlineNative(test: TestContext, ignore = false, mode = "codex-history") {
	const root = mkdtempSync(path.join(tmpdir(), "lh-codex-history-test-"));
	const native = path.join(root, process.platform === "win32" ? "codex.cmd" : "codex");
	const fixture = path.join(import.meta.dirname, "fixtures", "codex-history.mjs");
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(native, process.platform === "win32"
		? `@echo off\r\n"${process.execPath.replaceAll("%", "%%")}" "${fixture.replaceAll("%", "%%")}" %*\r\n`
		: `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
	const previous = Object.fromEntries(["CODEX_PATH", "LH_TEST_HISTORY_DIR", "LH_TEST_IGNORE_EPHEMERAL"].map((key) => [key, process.env[key]]));
	process.env.CODEX_PATH = native;
	process.env.LH_TEST_HISTORY_DIR = root;
	process.env.LH_TEST_IGNORE_EPHEMERAL = ignore ? "1" : "0";
	test.after(() => {
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("lh-codex-history-test-")) rmSync(root, { recursive: true, force: true });
	});
	return { root, config: { command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "acp-agent.mjs"), mode] } };
}

describe("Codex ACP history isolation", { concurrency: false }, () => {
	it("retains the adapter's bundled CLI version and honors an explicit native CLI", (test) => {
		const { root } = offlineNative(test);
		const adapterDir = path.join(root, "node_modules", "@agentclientprotocol", "codex-acp");
		const nativeDir = path.join(adapterDir, "node_modules", "@openai", "codex");
		mkdirSync(path.join(nativeDir, "bin"), { recursive: true });
		writeFileSync(path.join(adapterDir, "package.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", main: "index.js" }));
		const adapter = path.join(adapterDir, "index.js");
		writeFileSync(adapter, "");
		writeFileSync(path.join(nativeDir, "package.json"), JSON.stringify({ name: "@openai/codex" }));
		const native = path.join(nativeDir, "bin", "codex.js");
		writeFileSync(native, "");
		const expected = { command: process.execPath, args: [native] };
		assert.deepEqual(nativeLaunch({ command: path.join(root, process.platform === "win32" ? "codex.cmd" : "codex"), args: [] }, undefined, process.env), expected);
		assert.deepEqual(nativeLaunch({ command: process.execPath, args: [adapter] }, undefined, process.env), expected);
		assert.deepEqual(nativeLaunch({ command: adapter, args: [] }, "custom-codex", process.env), { command: "custom-codex", args: [] });
	});
	it("creates no persisted Codex chats across fresh ACP rounds", async (test) => {
		const { root, config } = offlineNative(test);
		for (let round = 0; round < 2; round++) {
			const client = new AcpClient("codex", config);
			try {
				await client.initialize();
				await client.newSession({ mcpServers: [] });
			} finally { await client.close(); }
			assert.equal(readdirSync(root).some((name) => name.endsWith(".json")), false, "an ACP round must not create a stored Codex chat");
		}
	});
	it("refuses to continue when the native CLI ignores ephemeral mode", async (test) => {
		const { config } = offlineNative(test, true);
		const client = new AcpClient("codex", config);
		try {
			await client.initialize();
			await assert.rejects(client.newSession({ mcpServers: [] }), /nonpersistent|ephemeral/i);
		} finally { await client.close(); }
	});
	it("rejects adapters that bypass the native history boundary before prompting", async () => {
		const client = new AcpClient("codex", { command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "acp-agent.mjs"), "codex-no-ephemeral-ack"] });
		try {
			await client.initialize();
			await assert.rejects(client.newSession({ mcpServers: [] }), /did not confirm an ephemeral session/);
		} finally { await client.close(); }
	});
	it("retains one verified ephemeral Codex session through multiple Pi tool calls without storing chats", async (test) => {
		const { root, config } = offlineNative(test, false, "reuse-history");
		test.after(() => closeAcpSessions());
		const trace = path.join(root, "calls.jsonl");
		config.args.push(trace);
		const parameters = Type.Object({ value: Type.String() });
		const calls: string[] = [];
		const submit: AgentTool<typeof parameters> = { name: "submit", label: "Submit", description: "Submit", parameters,
			execute: async (_id, input) => { calls.push(input.value); return toToolResult(`Result ${input.value}`); } };
		const engine = createAcpEngine("codex", config);
		const run = await runSubagent([submit], { role: "extractor", engine, systemPrompt: "Use submit.", prompt: "Submit hello", maxTurns: 4 });
		assert.deepEqual(calls, ["hello", "again"]);
		assert.equal(JSON.parse(run.text).replayed, false);
		assert.equal(readFileSync(trace, "utf8").trim().split("\n").filter((line) => JSON.parse(line).event === "session").length, 1);
		assert.equal(readdirSync(root).some((name) => name.endsWith(".json")), false, "reusing a native session must not persist a Codex chat");
	});
	it("a reuse-capable adapter still cannot receive a prompt when Codex ignores ephemeral mode", async (test) => {
		const { config } = offlineNative(test, true, "reuse-history");
		const engine = createAcpEngine("codex", config);
		const { normalizeContext } = await import("@earendil-works/pi-ai");
		const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "Private lesson history must not be sent", timestamp: 1 }] })).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /nonpersistent|ephemeral/i);
		assert.equal(result.content.length, 0);
	});
});
