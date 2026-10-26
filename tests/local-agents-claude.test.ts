import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";

// Local agent connection — Claude through the learner's own Claude Code
// (docs/architecture.md §8.2), driven end to end through pi-agent-core
// against a scripted stand-in for the CLI's stream-json protocol.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-claude-"));
const fake = fileURLToPath(new URL("./fixtures/local-agents/fake-claude.mjs", import.meta.url));
fs.chmodSync(fake, 0o755);
const logFile = path.join(directory, "claude.log");
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
fs.writeFileSync(path.join(process.env.LH_DATA_DIR, "local-agents.json"), JSON.stringify({ "claude-code": { enabled: true, allowBackgroundUse: false } }));
process.env.LH_CLAUDE_BIN = fake;
process.env.FAKE_CLAUDE_LOG = logFile;
// App-held keys and auth reroutes must never reach the learner's CLI.
process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
process.env.OPENROUTER_API_KEY = "sk-or-should-not-leak";

await import("../src/server/local-agents.ts");
const { refreshLocalAgents, localAgentStatus } = await import("../src/agent/local-agents/index.ts");
const { findRun } = await import("../src/agent/local-agents/run.ts");
const { claudeEffort } = await import("../src/agent/local-agents/claude.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");

after(() => fs.rmSync(directory, { recursive: true, force: true }));

function logEntries(type: string): Array<Record<string, any>> {
	if (!fs.existsSync(logFile)) return [];
	return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === type);
}

const SYSTEM = "You are the test teacher.";
let executions = 0;
const lookup = {
	name: "lookup", label: "Lookup", description: "Look up the secret word for a topic.",
	parameters: Type.Object({ topic: Type.String() }),
	execute: async (_id: string, params: unknown) => { const args = params as { topic: string }; executions++; return { content: [{ type: "text" as const, text: args.topic === "birds" ? "PELICAN" : "OTTER" }], details: {} }; },
};
function agent() {
	const engine = piEngineForSpec({ provider: "claude-code", id: "claude-haiku-4-5", thinkingLevel: "low" }, false);
	return new Agent({ sessionId: "chat-1", initialState: { systemPrompt: SYSTEM, model: engine.model, thinkingLevel: engine.level, tools: [lookup], messages: [] }, streamFn: engine.streamFn });
}

test("status projects what Claude Code reports about its own sign-in — never a credential", async () => {
	await refreshLocalAgents({ force: true });
	const status = localAgentStatus("claude-code");
	assert.equal(status.installed, true);
	assert.equal(status.version, "9.9.9");
	assert.equal(status.signedIn, true);
	assert.equal(status.account, "learner@example.com");
	assert.equal(status.plan, "Max");
	assert.equal(status.usesSubscription, true);
	assert.equal(status.connected, true);
	assert(!JSON.stringify(status).includes("sk-"));
});

let teacher: ReturnType<typeof agent>;
test("a tool step parks the CLI at the boundary and the next step resumes the same process", { timeout: 20_000 }, async () => {
	teacher = agent();
	await teacher.prompt("please use the tool");
	const messages = teacher.state.messages;
	const call = messages.find((m): m is AssistantMessage => m.role === "assistant" && m.stopReason === "toolUse")!;
	assert.deepEqual(call.content.filter((c) => c.type === "toolCall").map((c) => [c.type === "toolCall" && c.id, c.type === "toolCall" && c.name, c.type === "toolCall" && c.arguments]), [["toolu_fake_1", "lookup", { topic: "birds" }]]);
	assert.equal((messages.find((m) => m.role === "toolResult") as ToolResultMessage).content[0]!.type, "text");
	const final = messages.at(-1) as AssistantMessage;
	assert.equal(final.stopReason, "stop");
	assert.deepEqual(final.content.map((c) => c.type === "text" ? c.text : c.type === "thinking" ? `thinking:${c.thinking}` : c.type), ["thinking:pondering", "got: PELICAN"]);
	assert.deepEqual([final.usage.input, final.usage.cacheRead, final.usage.cacheWrite, final.usage.output], [11, 3, 2, 7]);
	assert.equal(final.provider, "claude-code");
	assert.equal(executions, 1);
	// One process served both steps.
	const launches = logEntries("launch");
	assert.equal(launches.length, 1);
	assert.deepEqual(logEntries("tool_result")[0]!.result, { content: [{ type: "text", text: "PELICAN" }] });
	assert.equal(findRun("chat-1"), undefined, "a finished turn releases its process");
});

test("Claude Code runs isolated: no built-in tools, settings, CLAUDE.md, skills, persistence, or app-held keys", () => {
	const launch = logEntries("launch")[0]!;
	const args = launch.args as string[];
	const after = (flag: string) => args[args.indexOf(flag) + 1];
	assert.equal(after("--tools"), "");
	assert.equal(after("--setting-sources"), "");
	for (const flag of ["--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"]) assert(args.includes(flag), flag);
	assert.equal(after("--permission-mode"), "dontAsk");
	assert.equal(after("--allowedTools"), "mcp__learnharness__lookup");
	assert.equal(after("--model"), "claude-haiku-4-5");
	assert.equal(after("--effort"), "low");
	assert.equal(launch.systemPrompt, SYSTEM);
	assert.deepEqual(launch.cwdEntries, []);
	assert.deepEqual(launch.env, { ANTHROPIC_API_KEY: null, OPENROUTER_API_KEY: null, DISABLE_AUTO_COMPACT: "1", MAX_THINKING_TOKENS: null });
	const tool = logEntries("tools")[0]!.tools[0];
	assert.equal(tool.name, "lookup");
	assert.deepEqual(Object.keys(tool.inputSchema.properties), ["topic"]);
});

test("the next learner turn cold-starts a fresh CLI conversation from the transcript", { timeout: 20_000 }, async () => {
	await teacher.prompt("and now?");
	const reply = teacher.state.messages.at(-1) as AssistantMessage;
	assert.equal(logEntries("launch").length, 2);
	const opening = logEntries("user").at(-1)!.content as Array<{ type: string; text?: string }>;
	assert.match(opening[0]!.text!, /conversation so far/);
	const joined = opening.map((b) => b.text ?? "").join("\n");
	assert.match(joined, /<user>\nplease use the tool\n<\/user>/);
	assert.match(joined, /<tool_call id="toolu_fake_1" name="lookup">\{"topic":"birds"\}<\/tool_call>/);
	assert.match(joined, /<tool_result id="toolu_fake_1" name="lookup" status="ok">\nPELICAN\n<\/tool_result>/);
	assert.equal(opening.at(-1)!.text, "and now?");
	assert.equal(reply.content.find((c) => c.type === "text")?.type === "text" && (reply.content.find((c) => c.type === "text") as { text: string }).text, `plain blocks=${opening.length}`);
});

test("background work is refused before the CLI starts when background use is off", { timeout: 10_000 }, async () => {
	const launches = logEntries("launch").length;
	const engine = piEngineForSpec({ provider: "claude-code", id: "claude-haiku-4-5" }, true);
	const result = await engine.streamFn(engine.model, { systemPrompt: SYSTEM, messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never, {}).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /background use is off/);
	assert.equal(logEntries("launch").length, launches);
});

test("thinking levels map to --effort; off disables thinking", () => {
	assert.deepEqual(claudeEffort("off"), { args: [], env: { MAX_THINKING_TOKENS: "0" } });
	assert.deepEqual(claudeEffort("minimal"), { args: ["--effort", "low"], env: {} });
	assert.deepEqual(claudeEffort("xhigh"), { args: ["--effort", "xhigh"], env: {} });
});
