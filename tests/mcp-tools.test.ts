/**
 * MCP client support (src/agent/tools/mcp.ts).
 *
 * Every test spawns the real stdio path against a scripted fake server
 * (tests/fixtures/mcp/fake-mcp-server.mjs): listing, calls, results and
 * process lifetime are exercised end to end, with no network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { loadMcpTools, type McpServerConfig } from "../src/agent/tools/mcp.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fixtures/mcp/fake-mcp-server.mjs", import.meta.url));

function fake(name: string, env?: Record<string, string>): McpServerConfig {
	return { name, command: process.execPath, args: [FAKE_SERVER], env };
}

async function load(t: TestContext, servers: McpServerConfig[]) {
	const loaded = await loadMcpTools(servers);
	t.after(() => loaded.close());
	return loaded;
}

type Loaded = Awaited<ReturnType<typeof load>>;

function call(loaded: Loaded, name: string, args: unknown = {}) {
	const tool = loaded.tools[name];
	assert.ok(tool, `tool ${name} is registered`);
	return tool.execute("call-1", args, undefined);
}

function pidFile(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mcp-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, "pid");
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

test("lists a server's tools as mcp__<server>__<tool> with its description and schema", async (t) => {
	const { tools } = await load(t, [fake("fake")]);

	assert.deepEqual(Object.keys(tools), [
		"mcp__fake__echo",
		"mcp__fake__two_texts",
		"mcp__fake__fail",
		"mcp__fake__image",
		"mcp__fake__audio",
	]);
	const echo = tools["mcp__fake__echo"]!;
	assert.equal(echo.name, "mcp__fake__echo");
	assert.equal(echo.description, "Echo the given text");
	assert.deepEqual(JSON.parse(JSON.stringify(echo.parameters)), {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	});
});

test("lists every page of a paginated tools/list", async (t) => {
	const { tools } = await load(t, [fake("fake", { FAKE_MCP_PAGE_SIZE: "2" })]);

	assert.equal(Object.keys(tools).length, 5);
});

test("returns a tool's text result and sends the arguments to the server", async (t) => {
	const loaded = await load(t, [fake("fake")]);

	const result = await call(loaded, "mcp__fake__echo", { text: "hi" });

	assert.deepEqual(result.content, [{ type: "text", text: "echo: hi" }]);
});

test("joins several text blocks into one text part", async (t) => {
	const loaded = await load(t, [fake("fake")]);

	const result = await call(loaded, "mcp__fake__two_texts");

	assert.deepEqual(result.content, [{ type: "text", text: "first\n\nsecond" }]);
});

test("fails the call with the server's text when the result is flagged isError", async (t) => {
	const loaded = await load(t, [fake("fake")]);

	await assert.rejects(call(loaded, "mcp__fake__fail"), /boom/);
});

test("passes an image through as an image part, with placeholder text when there is none", async (t) => {
	const loaded = await load(t, [fake("fake")]);

	const result = await call(loaded, "mcp__fake__image");

	assert.equal(result.content.length, 2);
	assert.deepEqual(result.content[0], { type: "text", text: "(no text content)" });
	assert.equal(result.content[1]!.type, "image");
	assert.equal((result.content[1] as { mimeType: string }).mimeType, "image/png");
});

test("notes content kinds it cannot pass on instead of dropping them silently", async (t) => {
	const loaded = await load(t, [fake("fake")]);

	const result = await call(loaded, "mcp__fake__audio");

	assert.deepEqual(result.content, [{ type: "text", text: "listen\n\n[audio content not supported]" }]);
});

test("merges the tools of several servers", async (t) => {
	const { tools } = await load(t, [fake("one"), fake("two")]);

	assert.ok(tools["mcp__one__echo"]);
	assert.ok(tools["mcp__two__echo"]);
});

test("close() stops the server process", async (t) => {
	const file = pidFile(t);
	const loaded = await loadMcpTools([fake("fake", { FAKE_MCP_PID_FILE: file })]);
	const pid = Number(fs.readFileSync(file, "utf8"));
	assert.ok(isRunning(pid), "the server runs while loaded");

	await loaded.close();

	assert.ok(!isRunning(pid), "the server is gone after close()");
});

test("rejects naming the server that fails, after closing the servers already opened", async (t) => {
	const file = pidFile(t);

	await assert.rejects(
		loadMcpTools([fake("good", { FAKE_MCP_PID_FILE: file }), { name: "broken", command: "lh-no-such-command" }]),
		/"broken"/,
	);

	assert.ok(!isRunning(Number(fs.readFileSync(file, "utf8"))), "the good server was closed");
});

test("rejects a tool name outside letters, digits, underscore and hyphen", async () => {
	await assert.rejects(loadMcpTools([fake("bad name")]), /mcp__bad name__echo.*letters, digits/);
});

test("rejects a tool name longer than 64 characters", async () => {
	await assert.rejects(loadMcpTools([fake("x".repeat(60))]), /at most 64/);
});

test("rejects two tools that end up with the same name", async () => {
	await assert.rejects(loadMcpTools([fake("dup"), fake("dup")]), /duplicate.*mcp__dup__echo/i);
});
