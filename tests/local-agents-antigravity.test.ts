import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, Type, type AssistantMessage } from "@earendil-works/pi-ai";

// Local agent connection — Antigravity through Google's official ACP
// server (docs/architecture.md §8.2), against a scripted ACP stand-in.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-antigravity-"));
const fake = fileURLToPath(new URL("./fixtures/local-agents/fake-acp.mjs", import.meta.url));
fs.chmodSync(fake, 0o755);
const logFile = path.join(directory, "acp.log");
const geminiHome = path.join(directory, "gemini");
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
fs.writeFileSync(path.join(process.env.LH_DATA_DIR, "local-agents.json"), JSON.stringify({ antigravity: { enabled: true, allowBackgroundUse: true } }));
process.env.AGY_ACP_BIN = fake;
process.env.GEMINI_HOME = geminiHome;
process.env.FAKE_ACP_LOG = logFile;

await import("../src/server/local-agents.ts");
const { refreshLocalAgents, localAgentStatus, localAgentModels, signInLocalAgent } = await import("../src/agent/local-agents/index.ts");
const { antigravityTokenPresent } = await import("../src/agent/local-agents/antigravity.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");

after(() => fs.rmSync(directory, { recursive: true, force: true }));

function log(): Array<Record<string, any>> {
	if (!fs.existsSync(logFile)) return [];
	return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
const requests = (method: string) => log().filter((e) => e.type === "request" && e.method === method);

test("without Antigravity's own saved sign-in the connection stays off and the server is never started", { skip: process.platform === "darwin" && await antigravityTokenPresent() ? "this machine has a real Antigravity keychain sign-in" : false }, async () => {
	await refreshLocalAgents({ force: true });
	const status = localAgentStatus("antigravity");
	assert.equal(status.installed, true);
	assert.equal(status.signedIn, false);
	assert.equal(status.connected, false);
	assert.equal(requests("initialize").length, 0);
});

test("app-driven sign-in runs inside the ACP server (Google method) and discovers the catalog", { timeout: 20_000 }, async () => {
	await signInLocalAgent("antigravity");
	assert.deepEqual(requests("authenticate").map((r) => r.params.methodId), ["oauth-personal"]);
	// The runtime would now hold the token; LearnHarness only checks presence.
	fs.mkdirSync(path.join(geminiHome, "antigravity-acp"), { recursive: true });
	fs.writeFileSync(path.join(geminiHome, "antigravity-acp", "acp_token.json"), "{}");
	await refreshLocalAgents({ force: true });
	const status = localAgentStatus("antigravity");
	assert.equal(status.signedIn, true);
	assert.equal(status.connected, true);
	const models = localAgentModels().filter((m) => m.provider === "antigravity");
	assert.deepEqual(models.map((m) => m.id), ["gemini-x", "gemini-y"]);
	assert.deepEqual(getSupportedThinkingLevels(models[0]!), ["low", "medium", "high"]);
	assert.deepEqual(getSupportedThinkingLevels(models[1]!), ["medium"]);
	// Discovery asked with no tool servers.
	assert(requests("session/new").every((r) => r.params.mcpServers.length === 0));
});

let executions = 0;
const lookup = {
	name: "lookup", label: "Lookup", description: "Look up the secret word for a topic.",
	parameters: Type.Object({ topic: Type.String() }),
	execute: async (_id: string, params: unknown) => { const args = params as { topic: string }; executions++; return { content: [{ type: "text" as const, text: args.topic === "rivers" ? "OTTER" : "?" }], details: {} }; },
};
let teacher: Agent;
test("a bridged tool call parks the ACP prompt and resumes it with pi's result; native tools are refused", { timeout: 20_000 }, async () => {
	const before = log().length;
	const engine = piEngineForSpec({ provider: "antigravity", id: "gemini-x", thinkingLevel: "high" }, false);
	teacher = new Agent({ sessionId: "chat-ag", initialState: { systemPrompt: "Teach.", model: engine.model, thinkingLevel: engine.level, tools: [lookup], messages: [] }, streamFn: engine.streamFn });
	await teacher.prompt("please use the tool");
	const messages = teacher.state.messages;
	const call = messages.find((m): m is AssistantMessage => m.role === "assistant" && m.stopReason === "toolUse")!;
	const toolCall = call.content.find((c) => c.type === "toolCall")!;
	assert.equal(toolCall.type === "toolCall" && toolCall.name, "lookup");
	assert.deepEqual(toolCall.type === "toolCall" && toolCall.arguments, { topic: "rivers" });
	assert.deepEqual(call.content.filter((c) => c.type === "thinking").map((c) => c.type === "thinking" && c.thinking), ["checking"]);
	const final = messages.at(-1) as AssistantMessage;
	assert.deepEqual(final.content.map((c) => c.type === "text" && c.text), ["got: OTTER"]);
	assert.equal(executions, 1);
	const session = log().slice(before);
	const opened = session.find((e) => e.type === "request" && e.method === "session/new")!;
	assert.equal(opened.params.mcpServers.length, 1);
	assert.equal(opened.params.mcpServers[0].type, "http");
	assert.match(opened.params.mcpServers[0].headers[0].value, /^Bearer [0-9a-f]{64}$/);
	assert.deepEqual(fs.readdirSync(opened.params.cwd), [], "an empty private working directory");
	assert.deepEqual(session.filter((e) => e.type === "request" && e.method === "session/set_mode").map((e) => e.params.modeId), ["default"]);
	assert.deepEqual(session.filter((e) => e.type === "request" && e.method === "session/set_config_option").map((e) => [e.params.configId, e.params.value]), [["thought_level", "high"]]);
	assert.deepEqual(session.filter((e) => e.type === "permission").map((e) => e.outcome), [{ outcome: "selected", optionId: "no" }]);
	assert.equal(session.filter((e) => e.type === "request" && e.method === "session/prompt").length, 1, "one ACP prompt served both pi steps");
});

test("the next learner turn cold-starts from the transcript", { timeout: 20_000 }, async () => {
	await teacher.prompt("and now?");
	const prompt = requests("session/prompt").at(-1)!.params.prompt as Array<{ text: string }>;
	assert.match(prompt[0]!.text, /conversation so far/);
	assert.equal(prompt.at(-1)!.text, "and now?");
	const reply = teacher.state.messages.at(-1) as AssistantMessage;
	assert.deepEqual(reply.content.map((c) => c.type === "text" && c.text), [`plain blocks=${prompt.length}`]);
});
