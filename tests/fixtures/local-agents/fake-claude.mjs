#!/usr/bin/env node
// A scripted stand-in for the Claude Code CLI's headless stream-json
// protocol (tests/local-agents-claude.test.ts). It records what it was
// launched with, then answers each user message: "use the tool" → one
// tool_use for `lookup` through the --mcp-config bridge (waiting on the
// parked result), anything else → a plain text reply naming how many
// prompt blocks it received.
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const log = (entry) => { if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`); };
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(process.env.FAKE_CLAUDE_AUTH ?? JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "learner@example.com" })); process.exit(0); }

const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mcpFile = flag("--mcp-config");
const mcp = mcpFile ? JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers.learnharness : undefined;
log({ type: "launch", args, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), systemPrompt: fs.readFileSync(flag("--system-prompt-file"), "utf8"), env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? null, DISABLE_AUTO_COMPACT: process.env.DISABLE_AUTO_COMPACT ?? null, MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS ?? null } });

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const event = (e) => emit({ type: "stream_event", event: e });
emit({ type: "system", subtype: "init", tools: [], mcp_servers: mcp ? [{ name: "learnharness", status: "connected" }] : [] });

async function rpc(body) {
	const response = await fetch(mcp.url, { method: "POST", headers: { ...mcp.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
	const text = await response.text();
	if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6));
	return text ? JSON.parse(text) : undefined;
}

function textMessage(text, usage = { input_tokens: 11, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }) {
	event({ type: "message_start", message: { usage: { ...usage, output_tokens: 1 } } });
	event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
	event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } });
	event({ type: "content_block_stop", index: 0 });
	event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
	for (const piece of [text.slice(0, 3), text.slice(3)]) if (piece) event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: piece } });
	event({ type: "content_block_stop", index: 1 });
	event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
	event({ type: "message_stop" });
}

const rl = readline.createInterface({ input: process.stdin });
let turns = 0;
rl.on("line", async (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	turns++;
	const content = message.message.content;
	log({ type: "user", content });
	const text = content.filter((b) => b.type === "text").at(-1)?.text ?? ""; // the new input, not replayed history
	if (/use the tool/.test(text) && mcp) {
		event({ type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 1 } } });
		event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_fake_${turns}`, name: "mcp__learnharness__lookup", input: {} } });
		event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"topic\": " } });
		event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"birds\"}" } });
		event({ type: "content_block_stop", index: 0 });
		await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
		const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		log({ type: "tools", tools: listed.result.tools });
		const call = rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lookup", arguments: { topic: "birds" } } });
		event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
		event({ type: "message_stop" });
		const result = await call;
		log({ type: "tool_result", result: result.result });
		textMessage(`got: ${result.result.content[0].text}`);
	} else {
		textMessage(`plain blocks=${content.length}`);
	}
	emit({ type: "result", subtype: "success", is_error: false, result: "ok" });
});
