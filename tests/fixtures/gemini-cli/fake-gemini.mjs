/**
 * Stand-in for the gemini CLI in tests (stream-json format of Gemini CLI 0.68.0). `--version`
 * prints FAKE_GEMINI_VERSION (default 0.68.0). Otherwise it reads the prompt from stdin to its
 * end, like the real headless mode, records what it was given in FAKE_GEMINI_RECORD (argv, stdin,
 * the system prompt file GEMINI_SYSTEM_MD and the settings file GEMINI_CLI_SYSTEM_SETTINGS_PATH,
 * read while they exist; FAKE_GEMINI_PIDS lists the pid of every process in the chain, and without
 * GEMINI_CLI_NO_RELAUNCH the fake restarts itself as a child that does the work, like the bundle;
 * FAKE_GEMINI_VERSION_ENV_RECORD receives the relaunch flag `--version` ran with) and replays the scenario file FAKE_GEMINI_SCENARIO line by line. Lines
 * with a "fake" key are directives instead of output:
 *   {"fake":"hold"}                          stay alive until killed, like the CLI waiting on a held MCP call
 *   {"fake":"exit","code":1,"stderr":"..."}  write stderr and exit with that code
 *   {"fake":"ignore-term"}                   ignore SIGTERM
 *   {"fake":"call","id":"t1","name":"read","arguments":{...}}
 *        write the tool_use line (tool_name mcp_learnharness_<name>), send the MCP tools/call (no call id
 *        meta, as the real CLI sends none), wait for its result, write the tool_result line
 *   {"fake":"tool-use","id":"t1","tool_name":"web_fetch","parameters":{...}}  write only a tool_use line
 *   {"fake":"mcp-call","id":"t1","name":"read","arguments":{...},"wait":false}  send only the MCP request
 *   {"fake":"await","ids":["t1"]}            wait for those started requests and write their tool_result lines
 *   {"fake":"connect"}                      connect to the MCP server now, so later requests leave together
 *   {"fake":"sleep","ms":50}                 pause
 *   {"fake":"reply"}                         write one assistant message: every result so far joined by " | ", then the result line
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HOLD_INTERVAL_MS = 60_000;
const BRIDGE_SERVER_NAME = "learnharness";

function writeLine(value) {
	return new Promise((resolve) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`, resolve));
}

function event(type, fields) {
	return writeLine({ type, timestamp: "2026-01-01T00:00:00.000Z", ...fields });
}

function readIfSet(path) {
	try { return path ? readFileSync(path, "utf8") : null; } catch { return null; }
}

if (process.argv.includes("--version")) {
	if (process.env.FAKE_GEMINI_VERSION_ENV_RECORD) {
		writeFileSync(process.env.FAKE_GEMINI_VERSION_ENV_RECORD, JSON.stringify({ noRelaunch: process.env.GEMINI_CLI_NO_RELAUNCH ?? null }));
	}
	process.stdout.write(`${process.env.FAKE_GEMINI_VERSION ?? "0.68.0"}\n`);
	process.exit(0);
}

// Like the official bundle: without GEMINI_CLI_NO_RELAUNCH it starts a copy of itself and the copy does
// the work. Every process of the chain appends its pid to FAKE_GEMINI_PIDS.
if (process.env.FAKE_GEMINI_PIDS) appendFileSync(process.env.FAKE_GEMINI_PIDS, `${process.pid}\n`);
if (!process.env.GEMINI_CLI_NO_RELAUNCH) {
	const copy = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
		stdio: "inherit",
		env: { ...process.env, GEMINI_CLI_NO_RELAUNCH: "1" },
	});
	copy.on("exit", (code) => process.exit(code ?? 1));
	await new Promise(() => {});
}

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

const settingsText = readIfSet(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
if (process.env.FAKE_GEMINI_RECORD) {
	writeFileSync(process.env.FAKE_GEMINI_RECORD, JSON.stringify({
		argv: process.argv.slice(2),
		stdin,
		systemMd: readIfSet(process.env.GEMINI_SYSTEM_MD),
		settings: settingsText,
	}));
}

let bridge = null;
async function connectBridge() {
	const { httpUrl, headers } = JSON.parse(settingsText).mcpServers[BRIDGE_SERVER_NAME];
	const client = new Client({ name: "fake-gemini", version: "1.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(httpUrl), { requestInit: { headers } }));
	return client;
}

const started = new Map();
const results = [];

async function startCall(directive) {
	bridge ??= await connectBridge();
	// No _meta: the real CLI sends no call id with tools/call.
	const request = bridge.callTool({ name: directive.name, arguments: directive.arguments });
	void request.catch(() => {});
	started.set(directive.id, request);
}

async function finishCall(id) {
	const result = await started.get(id);
	started.delete(id);
	const text = result.content.map((block) => block.text).join("");
	results.push(text);
	await event("tool_result", { tool_id: id, status: result.isError ? "error" : "success", output: text });
}

const lines = readFileSync(process.env.FAKE_GEMINI_SCENARIO, "utf8").split("\n").filter(Boolean);
for (const line of lines) {
	const directive = JSON.parse(line);

	if (directive.fake === "hold") { setInterval(() => {}, HOLD_INTERVAL_MS); break; }
	if (directive.fake === "exit") {
		process.stderr.write(directive.stderr ?? "");
		process.exit(directive.code);
	}
	if (directive.fake === "ignore-term") { process.on("SIGTERM", () => {}); continue; }
	if (directive.fake === "sleep") { await sleep(directive.ms); continue; }
	if (directive.fake === "connect") { bridge ??= await connectBridge(); continue; }
	if (directive.fake === "tool-use") {
		await event("tool_use", { tool_name: directive.tool_name, tool_id: directive.id, parameters: directive.parameters ?? {} });
		continue;
	}
	if (directive.fake === "mcp-call") {
		await startCall(directive);
		if (directive.wait !== false) await finishCall(directive.id);
		continue;
	}
	if (directive.fake === "call") {
		await event("tool_use", { tool_name: `mcp_${BRIDGE_SERVER_NAME}_${directive.name}`, tool_id: directive.id, parameters: directive.arguments });
		await startCall(directive);
		await finishCall(directive.id);
		continue;
	}
	if (directive.fake === "await") {
		for (const id of directive.ids) await finishCall(id);
		continue;
	}
	if (directive.fake === "reply") {
		await event("message", { role: "assistant", content: results.join(" | "), delta: true });
		await event("result", { status: "success", stats: {} });
		continue;
	}

	await writeLine(line);
}
