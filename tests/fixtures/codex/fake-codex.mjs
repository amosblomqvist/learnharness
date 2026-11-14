/**
 * Stand-in for `codex app-server` in tests. Speaks the JSON-RPC lines of Codex CLI 0.165.0
 * (shapes from `codex app-server generate-json-schema`): answers initialize, config/read,
 * thread/start and turn/start, then replays the scenario file named by FAKE_CODEX_SCENARIO
 * line by line. Lines with a "fake" key are directives instead of output; every other line
 * is written to stdout as it is (a notification such as item/agentMessage/delta):
 *   {"fake":"call","rpcId":"req-1","callId":"call_1","name":"read","arguments":{...}}
 *       send an item/tool/call request and wait for the client's response to it
 *   {"fake":"calls","calls":[{"rpcId":..,"callId":..,"name":..,"arguments":{..},"delayMs":0},...]}
 *       send several item/tool/call requests in a row (each after its optional delayMs) and wait for every response;
 *       the results are recorded in the order of the list
 *   {"fake":"native-request","rpcId":9,"method":"item/commandExecution/requestApproval"}
 *       send a server request the client must answer, without waiting
 *   {"fake":"hold"}                          stay alive until killed
 *   {"fake":"exit","code":1,"stderr":"..."}  write stderr and exit with that code
 *   {"fake":"reply"}                         stream one agent message whose text is every tool result so far, joined by " | ", then complete the turn
 * FAKE_CODEX_STDIN, when set, receives every stdin line read (one per line).
 * FAKE_CODEX_VERSION overrides the version `--version` prints.
 * FAKE_CODEX_CONFIG overrides the JSON that config/read returns as `config`.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const THREAD_ID = "thr_1";
const TURN_ID = "turn_1";
const HOLD_INTERVAL_MS = 60_000;
const DEFAULT_CONFIG = { mcp_servers: { serena: {}, blender: {} }, plugins: { "github@openai": {} } };

if (process.argv.includes("--version")) {
	process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.165.0"}\n`);
	process.exit(0);
}

function writeLine(value) {
	return new Promise((resolve) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`, resolve));
}

if (process.env.FAKE_CODEX_STDIN) writeFileSync(process.env.FAKE_CODEX_STDIN, "");

const serverRequests = new Map();
let startTurn;
const turnStarted = new Promise((resolve) => { startTurn = resolve; });

createInterface({ input: process.stdin }).on("line", async (line) => {
	if (process.env.FAKE_CODEX_STDIN) appendFileSync(process.env.FAKE_CODEX_STDIN, `${line}\n`);
	const message = JSON.parse(line);
	if (message.method === undefined) {
		serverRequests.get(message.id)?.(message);
		return;
	}
	if (message.id === undefined) return;
	if (message.method === "initialize") await writeLine({ id: message.id, result: { userAgent: "fake-codex" } });
	else if (message.method === "model/list") {
		const pages = JSON.parse(process.env.FAKE_CODEX_MODELS ?? '[{"data":[],"nextCursor":null}]');
		await writeLine({ id: message.id, result: pages[Number(message.params.cursor ?? 0)] });
	} else if (message.method === "config/read") {
		const config = process.env.FAKE_CODEX_CONFIG ? JSON.parse(process.env.FAKE_CODEX_CONFIG) : DEFAULT_CONFIG;
		await writeLine({ id: message.id, result: { config, origins: {} } });
	} else if (message.method === "thread/start") {
		await writeLine({ id: message.id, result: { thread: { id: THREAD_ID }, instructionSources: [], model: "fake" } });
	} else if (message.method === "turn/start") {
		await writeLine({ id: message.id, result: { turn: { id: TURN_ID, status: "inProgress", items: [] } } });
		startTurn();
	} else await writeLine({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});

function waitForResponse(rpcId) {
	return new Promise((resolve) => serverRequests.set(rpcId, resolve));
}

function notify(method, params) {
	return writeLine({ method, params: { threadId: THREAD_ID, turnId: TURN_ID, ...params } });
}

async function writeReply(text) {
	const item = { type: "agentMessage", id: "msg_reply", text, phase: null };
	await notify("item/started", { item: { ...item, text: "" } });
	await notify("item/agentMessage/delta", { itemId: item.id, delta: text });
	await notify("item/completed", { item });
	await notify("turn/completed", { turn: { id: TURN_ID, status: "completed", items: [] } });
}

await turnStarted;

const results = [];
const lines = readFileSync(process.env.FAKE_CODEX_SCENARIO, "utf8").split("\n").filter(Boolean);
for (const line of lines) {
	const directive = JSON.parse(line);

	if (directive.fake === "hold") {
		setInterval(() => {}, HOLD_INTERVAL_MS);
		break;
	}
	if (directive.fake === "exit") {
		process.stderr.write(directive.stderr ?? "");
		process.exit(directive.code);
	}
	if (directive.fake === "call") {
		const response = waitForResponse(directive.rpcId);
		await writeLine({
			id: directive.rpcId,
			method: "item/tool/call",
			params: { callId: directive.callId, threadId: THREAD_ID, turnId: TURN_ID, tool: directive.name, namespace: null, arguments: directive.arguments },
		});
		const { result } = await response;
		results.push(result.contentItems.map((item) => item.text ?? item.imageUrl).join(""));
		continue;
	}
	if (directive.fake === "calls") {
		const responses = await Promise.all(directive.calls.map(async (entry) => {
			if (entry.delayMs) await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
			const response = waitForResponse(entry.rpcId);
			await writeLine({
				id: entry.rpcId,
				method: "item/tool/call",
				params: { callId: entry.callId, threadId: THREAD_ID, turnId: TURN_ID, tool: entry.name, namespace: null, arguments: entry.arguments },
			});
			return response;
		}));
		for (const { result } of responses) results.push(result.contentItems.map((item) => item.text ?? item.imageUrl).join(""));
		continue;
	}
	if (directive.fake === "native-request") {
		await writeLine({ id: directive.rpcId, method: directive.method, params: { threadId: THREAD_ID, turnId: TURN_ID } });
		continue;
	}
	if (directive.fake === "reply") {
		await writeReply(results.join(" | "));
		continue;
	}

	await writeLine(line);
}
