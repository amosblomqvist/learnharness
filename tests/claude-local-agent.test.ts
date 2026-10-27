/**
 * Local Claude route (2026-10-27): the lesson adapter (ClaudeLocalAgent),
 * the tool bridge, the transcript flattening, the stream mapper and the
 * tool-less StreamFunction — against the fake Claude Code (no process).
 * The pins: pi's exact AgentEvent order and record shape, the query
 * options every turn sends, question termination, validation retries,
 * steering, abort, error masking, usage mapping, caching-friendly blocks.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { normalizeContext, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { ClaudeLocalAgent, type ClaudeLocalRuntime } from "../src/agent/claude-local/agent.ts";
import { claudeLocalStream } from "../src/agent/claude-local/stream.ts";
import { ClaudeStreamMapper } from "../src/agent/claude-local/stream-mapper.ts";
import { flattenTranscript, TRANSCRIPT_HEADER, toolPrefixNote } from "../src/agent/claude-local/transcript.ts";
import { claudeLocalError, thinkingOptions, systemPromptOption } from "../src/agent/claude-local/run.ts";
import { CLAUDE_CHILD_CONTROLS } from "../src/agent/claude-local/env.ts";
import { questionResult, serverExecute, invalidInputResult } from "../src/agent/tool-execute.ts";
import { toLlmMessages, newUserMessage } from "../src/core/native-messages.ts";
import { QUESTION_TOOLS } from "../src/core/pending.ts";
import { piModels } from "../src/agent/models.ts";
import { fakeClaude, type FakeStep } from "./claude-local-fake.ts";

const base = piModels().getModel("anthropic", "claude-haiku-5-5")!;
const model = { ...base, provider: "claude-local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const launch = { path: "/fake/claude", viaNode: false, cwd: "/fake/cwd" };

function runtimeFor(query: ClaudeLocalRuntime["query"], overrides: Partial<ClaudeLocalRuntime> = {}): ClaudeLocalRuntime & { usage: unknown[]; denials: string[]; dispatches: number } {
	const usage: unknown[] = [], denials: string[] = [];
	const runtime = {
		usage, denials, dispatches: 0,
		launch: () => launch,
		systemPromptMode: () => "custom" as const,
		scope: (selectedModelId: string) => ({ providerId: "claude-local" as const, revision: 7, selectedModelId }),
		admissionScope: (scope: { revision: number; selectedModelId: string }) => ({ accountId: "claude-local", epoch: scope.revision, authorityRevision: 0, selectedModelId: scope.selectedModelId }),
		scopeCurrent: () => true,
		backgroundAllowed: () => true,
		abortController: () => { const controller = new AbortController(); return { controller, release() {} }; },
		denial: (_scope: unknown, _controller: AbortController, callerAborted: boolean, background: boolean) => { const kind = callerAborted ? "all" : background ? "background" : "other"; denials.push(kind); return kind as "all" | "background" | "other"; },
		noteUsage: (report: unknown) => { usage.push(report); },
		query,
		...overrides,
	};
	return runtime;
}

const lookupSchema = Type.Object({ city: Type.String() });
const lookup: AgentTool<any> = { name: "lookup_weather", label: "lookup", description: "Weather for a city.", parameters: lookupSchema, execute: serverExecute("lookup_weather", lookupSchema, (input: { city: string }) => `Sunny in ${input.city}.`) };
const quizSchema = Type.Object({ question: Type.String(), options: Type.Array(Type.String(), { minItems: 2 }) });
const quiz: AgentTool<any> = { name: "quiz", label: "quiz", description: "Ask a question.", parameters: quizSchema, executionMode: "sequential", execute: async (_id, input: unknown) => (input as { options: string[] }).options.length >= 2 ? questionResult() : invalidInputResult("quiz", ["need two options"]) };
const stopper = (turn: { message: { content: Array<{ type: string; name?: string; id?: string }> }; toolResults: Array<{ toolCallId: string; isError?: boolean }> }) => {
	const called = new Set(turn.message.content.filter((c) => c.type === "toolCall" && (QUESTION_TOOLS as readonly string[]).includes(c.name ?? "")).map((c) => c.id!));
	if (called.size === 0) return undefined;
	return turn.toolResults.some((r) => called.has(r.toolCallId) && r.isError) ? undefined : { action: "end" as const };
};

function record(events: AgentEvent[]): string[] {
	return events.map((e) => e.type === "message_start" || e.type === "message_end" ? `${e.type}:${(e.message as { role: string }).role}` : e.type === "tool_execution_start" || e.type === "tool_execution_end" ? `${e.type}:${e.toolName}` : e.type).filter((t) => t !== "message_update");
}

async function runAgent(steps: FakeStep[] | ((blocks: string[], turn: number) => FakeStep[]), options: { tools?: AgentTool<any>[]; messages?: Parameters<typeof newUserMessage>[0][]; runtime?: Partial<ClaudeLocalRuntime>; purpose?: () => boolean; lifecycle?: ConstructorParameters<typeof ClaudeLocalAgent>[0]["lifecycle"]; onEvent?: (event: AgentEvent, agent: ClaudeLocalAgent) => void; systemPrompt?: string } = {}) {
	const fake = fakeClaude(steps);
	const runtime = runtimeFor(async () => fake.query, options.runtime);
	const agent = new ClaudeLocalAgent({
		systemPrompt: options.systemPrompt ?? "You teach.", model, thinkingLevel: "medium", tools: options.tools ?? [lookup, quiz],
		messages: (options.messages ?? ["What's the weather in Oslo?"]).map(newUserMessage), convertToLlm: toLlmMessages, finishTurn: stopper, runtime, purpose: options.purpose, lifecycle: options.lifecycle,
	});
	const events: AgentEvent[] = [];
	agent.subscribe((event) => { events.push(event); options.onEvent?.(event, agent); });
	await agent.continue();
	return { fake, runtime, agent, events, messages: agent.state.messages.filter((m) => (m as { role: string }).role !== "system") };
}

describe("ClaudeLocalAgent: one lesson turn in pi's vocabulary", () => {
	it("streams, runs tools through the bridge, records bare names in source order, ends the run on a cleanly posed question", async () => {
		const { fake, events, messages, runtime } = await runAgent([
			{ thinking: "Need the weather first.", tools: [{ name: "lookup_weather", args: { city: "Oslo" } }] },
			{ text: "It's sunny in Oslo.", tools: [{ name: "quiz", args: { question: "Sunny?", options: ["yes", "no"] } }] },
			{ text: "never reached" },
		]);
		assert.deepEqual(record(events), [
			"agent_start", "turn_start",
			"message_start:assistant", "message_end:assistant",
			"tool_execution_start:lookup_weather", "tool_execution_end:lookup_weather", "message_start:toolResult", "message_end:toolResult", "turn_end",
			"turn_start", "message_start:assistant", "message_end:assistant",
			"tool_execution_start:quiz", "tool_execution_end:quiz", "message_start:toolResult", "message_end:toolResult", "turn_end",
			"agent_end",
		]);
		assert.ok(events.filter((e) => e.type === "message_update").length >= 6, "the full partial streams on every update");
		assert.deepEqual(messages.map((m) => (m as { role: string }).role), ["user", "assistant", "toolResult", "assistant", "toolResult"]);
		const first = messages[1] as AssistantMessage;
		assert.equal(first.provider, "claude-local"); assert.equal(first.model, "claude-haiku-5-5"); assert.equal(first.api, "anthropic-messages"); assert.equal(first.stopReason, "toolUse"); assert.equal(first.thinkingLevel, "medium");
		const call = first.content[1] as { type: string; id: string; name: string; arguments: unknown };
		assert.deepEqual(first.content[0], { type: "thinking", thinking: "Need the weather first.", thinkingSignature: "sig-1" });
		assert.equal(call.type, "toolCall"); assert.equal(call.name, "lookup_weather", "bare name, never mcp__learnharness__"); assert.deepEqual(call.arguments, { city: "Oslo" }); assert.match(call.id, /^toolu_/);
		assert.deepEqual(first.usage, { input: 10, output: 20, cacheRead: 3, cacheWrite: 5, totalTokens: 38, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
		const result = messages[2] as ToolResultMessage;
		assert.equal(result.toolCallId, call.id, "the record keeps Claude Code's own tool_use id"); assert.equal(result.toolName, "lookup_weather"); assert.deepEqual(result.content, [{ type: "text", text: "Sunny in Oslo." }]); assert.equal(result.details, "Sunny in Oslo."); assert.equal(result.isError, false);
		const quizResult = messages[4] as ToolResultMessage;
		assert.equal(quizResult.toolName, "quiz"); assert.match((quizResult.content[0] as { text: string }).text, /Question posed/);
		assert.equal(fake.turns.length, 1, "one child for the whole run");
		assert.deepEqual(fake.turns[0]!.toolCalls.map((c) => [c.name, c.isError]), [["lookup_weather", false], ["quiz", false]]);
		const report = runtime.usage[0] as { observedAt: number };
		assert.deepEqual(runtime.usage, [{ status: "allowed", utilization: 0.25, resetsAt: 1700000000, rateLimitType: "five_hour", isUsingOverage: false, observedAt: report.observedAt }]);
	});

	it("sends exactly the isolation options, the scrubbed env, the prompt as per-message blocks and the custom system prompt with the prefix note", async () => {
		const { fake } = await runAgent([{ text: "Hello." }], { messages: ["Hi there"], systemPrompt: "TEACH" });
		const turn = fake.turns[0]!;
		const o = turn.options;
		assert.deepEqual(o.tools, []); assert.deepEqual(o.settingSources, []); assert.equal(o.persistSession, false); assert.equal(o.strictMcpConfig, true);
		assert.equal(o.permissionMode, "default"); assert.deepEqual(o.allowedTools, ["mcp__learnharness"]); assert.equal(o.includePartialMessages, true);
		assert.equal(o.model, "claude-haiku-5-5"); assert.equal(o.effort, "medium"); assert.deepEqual(o.thinking, { type: "adaptive", display: "summarized" });
		assert.equal(o.pathToClaudeCodeExecutable, "/fake/claude"); assert.equal(o.cwd, "/fake/cwd");
		assert.equal(typeof o.spawnClaudeCodeProcess, "function");
		const env = o.env as Record<string, string>;
		for (const name of ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "LH_DATA_DIR", "LH_DESKTOP_API_SECRET", "CLAUDE_CODE_OAUTH_TOKEN"]) assert.equal(env[name], undefined, name);
		for (const [name, value] of Object.entries(CLAUDE_CHILD_CONTROLS)) assert.equal(env[name], value, name);
		assert.equal(o.systemPrompt, `TEACH\n\n---\n\n${toolPrefixNote("learnharness")}`);
		assert.ok((o.hooks as Record<string, unknown>).PreToolUse); assert.ok((o.hooks as Record<string, unknown>).PostToolBatch);
		assert.equal(o.maxTurns, undefined, "no turn cap on the lesson (owner ruling)");
		assert.deepEqual(turn.blocks, [TRANSCRIPT_HEADER, "<learner>\nHi there\n</learner>"]);
		assert.equal((o.mcpServers as Record<string, { name: string }>).learnharness?.name, "learnharness");
	});

	it("preset mode appends the app prompt to Claude Code's own; thinking off disables thinking", async () => {
		const fake = fakeClaude([{ text: "ok" }]);
		const runtime = runtimeFor(async () => fake.query, { systemPromptMode: () => "preset" });
		const agent = new ClaudeLocalAgent({ systemPrompt: "TEACH", model, thinkingLevel: "off", tools: [lookup], messages: [newUserMessage("hi")], convertToLlm: toLlmMessages, runtime });
		await agent.continue();
		const o = fake.turns[0]!.options;
		assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code", append: `TEACH\n\n---\n\n${toolPrefixNote("learnharness")}` });
		assert.deepEqual(o.thinking, { type: "disabled" }); assert.equal(o.effort, undefined);
		assert.deepEqual(thinkingOptions("minimal"), { effort: "low", thinking: { type: "adaptive", display: "summarized" } });
		assert.deepEqual(thinkingOptions("max"), { effort: "max", thinking: { type: "adaptive", display: "summarized" } });
		assert.equal(systemPromptOption("P", "custom", false), "P");
	});

	it("a failed pose (validation error) does not end the run — the model retries in the same child", async () => {
		const { fake, messages, events } = await runAgent([
			{ text: "Q?", tools: [{ name: "quiz", args: { question: "Only one?", options: ["one"] } }] },
			{ text: "Again.", tools: [{ name: "quiz", args: { question: "Two?", options: ["a", "b"] } }] },
		]);
		assert.equal(fake.turns.length, 1);
		assert.deepEqual(fake.turns[0]!.toolCalls.map((c) => c.isError), [true, false]);
		const firstResult = messages[2] as ToolResultMessage;
		// pi's own validator wording (validateToolArguments) — the schema rejects before execute.
		assert.equal(firstResult.isError, true); assert.match((firstResult.content[0] as { text: string }).text, /Validation failed for tool "quiz"/);
		assert.equal(events.filter((e) => e.type === "turn_end").length, 2);
		assert.equal(messages.length, 5);
	});

	it("TypeBox validation runs before execute: a missing required argument is the same retryable error pi produces (and pi's coercions apply)", async () => {
		const { messages, fake } = await runAgent([{ tools: [{ name: "lookup_weather", args: {} }] }, { tools: [{ name: "lookup_weather", args: { city: 42 } }] }, { text: "Fixed." }]);
		const result = messages[2] as ToolResultMessage;
		assert.equal(result.isError, true); assert.match((result.content[0] as { text: string }).text, /Validation failed for tool "lookup_weather"[\s\S]*city/);
		assert.deepEqual(fake.turns[0]!.toolCalls.map((c) => c.isError), [true, false], "42 coerces to \"42\" exactly as pi's validator does");
		assert.equal((messages[5] as AssistantMessage).content[0]?.type, "text");
	});

	it("a tool outside the bridge is denied by the PreToolUse hook and never runs", async () => {
		const { fake, messages } = await runAgent([{ tools: [{ name: "Bash", args: { command: "rm -rf /" }, raw: true }] }, { text: "ok" }]);
		assert.deepEqual(fake.turns[0]!.hookDenials, ["Bash"]); assert.deepEqual(fake.turns[0]!.toolCalls, []);
		// The record shows the call the model made and a not-completed result, then the retry.
		assert.equal((messages[1] as AssistantMessage).content[0]?.type, "toolCall");
		assert.equal((messages[2] as ToolResultMessage).isError, true);
		assert.equal((messages.at(-1) as AssistantMessage).content[0]?.type, "text");
	});

	it("parallel tool calls in one message: results attach in source order after every call ended", async () => {
		const { events, messages } = await runAgent([{ tools: [{ name: "lookup_weather", args: { city: "A" }, id: "t-a" }, { name: "lookup_weather", args: { city: "B" }, id: "t-b" }] }, { text: "Both." }]);
		const order = record(events);
		assert.ok(order.indexOf("message_end:assistant") < order.indexOf("tool_execution_start:lookup_weather"), "message_end precedes every tool event (pi order)");
		assert.deepEqual(messages.slice(2, 4).map((m) => (m as ToolResultMessage).toolCallId), ["t-a", "t-b"]);
	});

	it("steering: a message queued mid-run is recorded after turn_start and reaches the next child's transcript; the run continues until the queue drains", async () => {
		let steered = false;
		const { fake, events, messages } = await runAgent((blocks, turn) => turn === 1 ? [{ text: "First reply." }] : [{ text: `Saw ${blocks.length} blocks.` }], {
			onEvent: (event, agent) => { if (!steered && event.type === "message_end" && (event.message as { role: string }).role === "assistant") { steered = true; agent.steer(newUserMessage("Also: what about Bergen?")); } },
		});
		assert.equal(fake.turns.length, 2, "the steer ran a second child in the same run");
		assert.deepEqual(record(events), ["agent_start", "turn_start", "message_start:assistant", "message_end:assistant", "turn_end", "turn_start", "message_start:user", "message_end:user", "message_start:assistant", "message_end:assistant", "turn_end", "agent_end"]);
		assert.deepEqual(messages.map((m) => (m as { role: string }).role), ["user", "assistant", "user", "assistant"]);
		assert.ok(fake.turns[1]!.blocks.some((b) => b.includes("Bergen")), "the second child saw the steer");
		assert.ok(fake.turns[1]!.blocks.some((b) => b.includes("First reply.")), "and the first reply");
		assert.equal((messages[3] as AssistantMessage).content[0] && (messages[3] as AssistantMessage).content[0]!.type === "text" ? ((messages[3] as AssistantMessage).content[0] as { text: string }).text : "", "Saw 4 blocks.");
	});

	it("abort mid-stream ends the message as aborted, stops updates, ends the run; no further child", async () => {
		let updates = 0;
		const { events, messages, fake } = await runAgent([{ text: "A very long answer that keeps streaming for a while." }, { text: "never" }], {
			onEvent: (event, agent) => { if (event.type === "message_update" && ++updates === 1) agent.abort(); },
		});
		const last = messages[messages.length - 1] as AssistantMessage;
		assert.equal(last.stopReason, "aborted"); assert.match(last.errorMessage ?? "", /cancelled.*No API key was used/);
		assert.equal(events.filter((e) => e.type === "message_update").length, 1, "nothing streams after abort");
		assert.deepEqual(record(events).slice(-3), ["message_end:assistant", "turn_end", "agent_end"]);
		assert.equal(fake.turns.length, 1);
	});

	it("the admission cycle (held events until dispatch) releases EVERY in-child model call, not just the first (review blocker B1)", async () => {
		const { SubscriptionRequestCycle } = await import("../src/agent/subscription-request-cycle.ts");
		const fake = fakeClaude([{ text: "Look it up.", tools: [{ name: "lookup_weather", args: { city: "Oslo" } }] }, { text: "Sunny.", tools: [{ name: "lookup_weather", args: { city: "Bergen" } }] }, { text: "Done." }]);
		const runtime = runtimeFor(async () => fake.query);
		const purpose = { background: false };
		const messages = [newUserMessage("Weather?")];
		const cycle = new SubscriptionRequestCycle({ initialMessages: messages, foregroundOwed: true, purpose, scopeCurrent: () => true, restoreAutomatic: () => {} });
		const agent = new ClaudeLocalAgent({ systemPrompt: "T", model, thinkingLevel: "off", tools: [lookup], messages, convertToLlm: toLlmMessages, prepareRequest: (request) => cycle.prepare(request), lifecycle: cycle, runtime, purpose: () => purpose.background });
		// ui-stream's wiring: events the cycle holds reach the views only on release.
		const released: AgentEvent[] = [];
		const admitted: boolean[] = [];
		const handle = (event: AgentEvent) => { released.push(event); if (event.type === "message_end" && (event.message as { role: string }).role === "assistant") admitted.push(cycle.acceptsUsage(event.message as AssistantMessage)); };
		cycle.bindRelease(handle);
		agent.subscribe((event) => { if (!cycle.hold(event)) handle(event); });
		await agent.continue();
		const outcome = cycle.finishNativeCycle();
		if (outcome.action !== "resumeForeground") handle({ type: "agent_end", messages: [...agent.state.messages] });
		assert.equal(released.filter((e) => e.type === "message_end" && (e.message as { role: string }).role === "assistant").length, 3, "all three model calls reached the views");
		assert.deepEqual(admitted, [true, true, true], "usage is admitted for every model call");
		assert.equal(released.filter((e) => e.type === "turn_end").length, 3);
		assert.equal(released.at(-1)?.type, "agent_end");
		assert.ok(cycle.dispatched);
	});

	it("Claude Code's synthetic API-failure message ends the run as a masked error, never as a reply (review blocker B2)", async () => {
		const { messages, events, fake } = await runAgent([{ apiError: "rate_limit", text: "API Error: 429 {\"type\":\"rate_limit_error\"}" }, { text: "never" }]);
		const last = messages.at(-1) as AssistantMessage;
		assert.equal(messages.filter((m) => (m as { role: string }).role === "assistant").length, 1);
		assert.equal(last.stopReason, "error"); assert.match(last.errorMessage ?? "", /usage limit.*No API key was used/);
		assert.ok(!JSON.stringify(last.content).includes("API Error"), "the raw API text is not recorded as a reply");
		assert.deepEqual(record(events).slice(-3), ["message_end:assistant", "turn_end", "agent_end"]);
		assert.equal(fake.turns.length, 1);
		// A failure after a streamed reply is terminal too.
		const streamedThenFailed = await runAgent([{ text: "Half." }, { error: "server_error: overloaded" }]);
		const replies = streamedThenFailed.messages.filter((m) => (m as { role: string }).role === "assistant") as AssistantMessage[];
		assert.equal(replies.length, 2); assert.equal(replies[0]!.stopReason, "stop"); assert.equal(replies[1]!.stopReason, "error");
	});

	it("a message Claude Code delivers only as per-block assistant echoes (no stream) is rebuilt with every block (review S14)", async () => {
		const { messages, fake } = await runAgent([{ thinking: "hm", text: "Both blocks.", tools: [{ name: "lookup_weather", args: { city: "Oslo" } }], unstreamed: true }, { text: "Done.", unstreamed: true }]);
		const first = messages[1] as AssistantMessage;
		assert.deepEqual(first.content.map((c) => c.type), ["thinking", "text", "toolCall"]);
		assert.equal(first.stopReason, "toolUse");
		assert.deepEqual(fake.turns[0]!.toolCalls.map((c) => c.name), ["lookup_weather"]);
		assert.equal((messages.at(-1) as AssistantMessage).stopReason, "stop");
		assert.deepEqual(((messages.at(-1) as AssistantMessage).content[0] as { text: string }).text, "Done.");
	});

	it("an error result becomes a masked error message; a crash before dispatch reports no-dispatch to the admission cycle", async () => {
		const { messages } = await runAgent([{ error: "Not logged in · Please run /login" }]);
		const last = messages[messages.length - 1] as AssistantMessage;
		assert.equal(last.stopReason, "error"); assert.match(last.errorMessage ?? "", /not signed in.*No API key was used/);
		const noDispatch: string[] = [];
		const lifecycle = { captured: () => {}, beforeDispatch: () => {}, noDispatch: (kind: string) => { noDispatch.push(kind); } };
		const unavailable = await runAgent([{ text: "x" }], { runtime: { launch: () => undefined }, lifecycle, purpose: () => true });
		assert.equal((unavailable.messages.at(-1) as AssistantMessage).stopReason, "error");
		assert.deepEqual(noDispatch, ["background"]);
		assert.equal(unavailable.fake.turns.length, 0, "nothing dispatched");
		const consentOff = await runAgent([{ text: "x" }], { runtime: { backgroundAllowed: () => false }, purpose: () => true, lifecycle });
		assert.match((consentOff.messages.at(-1) as AssistantMessage).errorMessage ?? "", /background use is off/);
	});

	it("maps failures to the house wording and never mentions an API key as a remedy", () => {
		assert.match(claudeLocalError("rate_limit exceeded"), /usage limit/);
		assert.match(claudeLocalError("authentication_failed"), /not signed in/);
		assert.match(claudeLocalError("spawn ENOENT"), /could not be started/);
		assert.match(claudeLocalError("Operation aborted"), /cancelled/);
		for (const m of ["x", "rate_limit", "authentication_failed", "ENOENT"]) assert.ok(claudeLocalError(m).endsWith("No API key was used."));
	});

	it("pi parity: prompt() appends and runs; a second continue() while running throws", async () => {
		const fake = fakeClaude([{ text: "ok" }]);
		const agent = new ClaudeLocalAgent({ systemPrompt: "T", model, thinkingLevel: "off", tools: [], messages: [], convertToLlm: toLlmMessages, runtime: runtimeFor(async () => fake.query), identity: { attribution: null }, sessionId: "chat-1" });
		assert.equal(agent.sessionId, "chat-1");
		const run = agent.prompt("hello");
		await assert.rejects(agent.continue(), /already processing/);
		await run;
		assert.deepEqual(agent.state.messages.map((m) => (m as { role: string }).role), ["system", "user", "assistant"]);
	});
});

describe("flattenTranscript and the stream mapper", () => {
	it("renders one immutable block per record message with bare tool names, no thinking, image placeholders, and the compaction head", () => {
		const assistant: AssistantMessage = { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Hi" }, { type: "toolCall", id: "c1", name: "quiz", arguments: { q: "x<y" } }], api: "anthropic-messages", provider: "claude-local", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 };
		const blocks = flattenTranscript([
			{ role: "system", content: "chrome", timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "Look" }, { type: "image", data: "AAA", mimeType: "image/png" }], timestamp: 1 },
			assistant,
			{ role: "toolResult", toolCallId: "c1", toolName: "quiz", content: [{ type: "text", text: "answered" }], isError: false, timestamp: 2 },
		]);
		assert.equal(blocks[0], TRANSCRIPT_HEADER);
		assert.equal(blocks[1], "<learner>\nLook\n[an image attachment was here; images are not forwarded on the Local Claude route]\n</learner>");
		assert.equal(blocks[2], '<teacher>\nHi\n<tool_call id="c1" name="quiz">{"q":"x<y"}</tool_call>\n</teacher>');
		assert.ok(!blocks[2]!.includes("secret"));
		assert.equal(blocks[3], '<tool_result id="c1" name="quiz">\nanswered\n</tool_result>');
		assert.equal(blocks.length, 4);
	});
	it("the mapper accumulates text, thinking signatures and JSON tool arguments, records bare names, and flags bad JSON as argumentsError", () => {
		const mapper = new ClaudeStreamMapper(model, "learnharness", "high");
		const types = (events: { type: string }[]) => events.map((e) => e.type);
		assert.deepEqual(types(mapper.handle({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } } as never })), ["start"]);
		assert.deepEqual(types(mapper.handle({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "mcp__learnharness__quiz", input: {} } as never })), ["toolcall_start"]);
		mapper.handle({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":" } });
		mapper.handle({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } });
		const end = mapper.handle({ type: "content_block_stop", index: 0 });
		assert.equal(end[0]!.type, "toolcall_end"); assert.deepEqual((end[0] as { toolCall: unknown }).toolCall, { type: "toolCall", id: "t1", name: "quiz", arguments: { a: 1 } });
		mapper.handle({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "mcp__learnharness__quiz", input: {} } as never });
		mapper.handle({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{oops" } });
		const bad = mapper.handle({ type: "content_block_stop", index: 1 })[0] as { toolCall: { arguments: unknown; argumentsError?: string } };
		assert.deepEqual(bad.toolCall.arguments, {}); assert.match(bad.toolCall.argumentsError ?? "", /not valid JSON: \{oops/);
		mapper.handle({ type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null, container: null, stop_details: null }, usage: { output_tokens: 99, input_tokens: 7, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } as never, context_management: null });
		mapper.handle({ type: "message_stop" });
		const done = mapper.finish();
		assert.equal(done.type, "done"); assert.equal((done as { message: AssistantMessage }).message.stopReason, "length");
		assert.deepEqual((done as { message: AssistantMessage }).message.usage, { input: 7, output: 99, cacheRead: 2, cacheWrite: 1, totalTokens: 109, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
		assert.equal((done as { message: AssistantMessage }).message.thinkingLevel, "high");
	});
});

describe("the tool-less StreamFunction (compaction summaries)", () => {
	it("yields pi events and a done message for a tool-less context, and refuses a context with tools", async () => {
		const fake = fakeClaude([{ text: "Summary." }]);
		const runtime = runtimeFor(async () => fake.query);
		const stream = claudeLocalStream(() => false, undefined, runtime);
		const result = await stream(model, normalizeContext({ messages: [{ role: "system", content: "Summarize.", timestamp: 0 }, { role: "user", content: "long transcript", timestamp: 1 }] }), { reasoning: "low" }).result();
		assert.equal(result.stopReason, "stop"); assert.deepEqual(result.content, [{ type: "text", text: "Summary." }]); assert.equal(result.provider, "claude-local");
		assert.equal(fake.turns[0]!.options.systemPrompt, "Summarize."); assert.equal(fake.turns[0]!.options.mcpServers, undefined); assert.equal(fake.turns[0]!.options.effort, "low");
		const withTools = await stream(model, normalizeContext({ messages: [{ role: "system", content: "S", toolsAdded: [{ name: "quiz", description: "q", parameters: Type.Object({}) }], timestamp: 0 }, { role: "user", content: "x", timestamp: 1 }] })).result();
		assert.equal(withTools.stopReason, "error"); assert.equal(fake.turns.length, 1, "refused before dispatch");
	});
});
