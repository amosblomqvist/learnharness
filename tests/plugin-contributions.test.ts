import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { TestContext } from "node:test";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createPluginHost } from "../src/server/plugin-host.ts";
import type { PluginBackendContext, PluginInference, PluginLearningData, PluginToolContext } from "../src/core/plugins.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";
import type { PluginWorkerService } from "../src/core/plugin-workers.ts";
import { validatePluginSchema, validatePluginInferenceOptions } from "../src/core/plugin-validation.ts";
import type { AgentBuildOptions } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";

// Agent/server imports happen only after redirecting all app storage to a fresh
// directory. Every inference call below uses the native SDK's in-process faux.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-contributions-data-"));
process.env.LH_DATA_DIR = DATA;
process.env.LH_AUTH_FILE = path.join(DATA, "auth.json");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Unexpected network request in plugin contribution tests"); };
after(() => { globalThis.fetch = originalFetch; fs.rmSync(DATA, { recursive: true, force: true }); });
const { createTeacherAgent, createProberAgent, createPracticeAgent, composeInstructions, CONVERSATION_TOOL_NAMES } = await import("../src/agent/teacher-agent.ts");

const textResult = (text = "native"): AgentToolResult => ({ content: [{ type: "text", text }], details: undefined });
function native(name = "plugin_tool", execute: AgentTool<any>["execute"] = async () => textResult()): AgentTool<any> {
	return { name, label: name, description: "Native plugin tool", parameters: Type.Object({}), execute };
}
function engine(): PiEngine {
	const faux = createFauxCore({}); return { model: faux.getModel(), streamFn: faux.streamSimple };
}
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-contributions-"));
	const directory = path.join(root, "plugins"); fs.mkdirSync(directory);
	let changes = 0, disposedServices = 0;
	const host = createPluginHost({ directory, appVersion: "0.3.7", onChange: () => { changes++; }, createServices: () => ({
		learning: {} as PluginLearningData, inference: {} as PluginInference,
		agents: { dispose: async () => { disposedServices++; } } as PluginAgentService,
		workers: { dispose: async () => {} } as PluginWorkerService,
		createBackgroundTool() { throw new Error("Unexpected background tool in contribution fixture"); },
	}) });
	t.after(async () => { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
	function plugin(id = "example", source = "exports.activate = ctx => { ctx.handle('context', () => ctx); };") {
		const dir = path.join(directory, id); fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.3.0", backend: "backend.cjs", main: "main.js" }));
		fs.writeFileSync(path.join(dir, "backend.cjs"), source);
		fs.writeFileSync(path.join(dir, "main.js"), "export function activate() {};");
	}
	async function context(id = "example") { await host.setEnabled(id, true); return await host.call(id, "context") as PluginBackendContext; }
	return { directory, host, plugin, context, changes: () => changes, disposedServices: () => disposedServices };
}
const turn = (chatId = "chat-one", agent: PluginToolContext["agent"] = "teacher"): PluginToolContext => ({ chatId, agent });

test("registrations copy explicit role targets, unregister idempotently, and stay activation-owned", async t => {
	const f = fixture(t); f.plugin();
	await f.host.initialize(); assert.deepEqual(f.host.agentContributions(turn(), []), { instructions: [], tools: [] });
	const ctx = await f.context();
	for (const agents of [[], ["unknown"], undefined]) {
		assert.throws(() => ctx.registerInstructions({ agents, text: "invalid" } as never), /explicit nonempty/);
		assert.throws(() => ctx.registerTools({ agents, create: () => [] } as never), /explicit nonempty/);
	}
	assert.throws(() => ctx.registerInstructions({ agents: ["teacher"], text: " " }), /nonempty text/);
	assert.throws(() => ctx.registerTools({ agents: ["teacher"], create: null } as never), /factory/);
	const agents: Array<"teacher" | "practice"> = ["teacher"];
	const offInstructions = ctx.registerInstructions({ agents, text: "Additive doctrine" });
	let factories = 0;
	const offTools = ctx.registerTools({ agents, create(context) {
		factories++; assert.equal(Object.isFrozen(context), true);
		assert.equal(Array.isArray(this.agents), true); // Preserve the native factory method's receiver.
		return [native("per_turn", async () => textResult(`${context.chatId}:${context.agent}`))];
	} });
	agents.push("practice");
	assert.deepEqual(f.host.agentContributions(turn("probe", "prober"), []), { instructions: [], tools: [] });
	assert.deepEqual(f.host.agentContributions(turn("practice", "practice"), []), { instructions: [], tools: [] });
	const first = f.host.agentContributions(turn("first"), []), second = f.host.agentContributions(turn("second"), []);
	assert.equal(factories, 2);
	assert.deepEqual(first.instructions, ["Additive doctrine"]);
	assert.deepEqual(await first.tools[0]!.execute("call", {}), textResult("first:teacher"));
	assert.deepEqual(await second.tools[0]!.execute("call", {}), textResult("second:teacher"));
	offInstructions(); offInstructions(); offTools(); offTools();
	assert.deepEqual(f.host.agentContributions(turn(), []), { instructions: [], tools: [] });
	// Unregister changes future turns, not an already-captured turn snapshot.
	assert.deepEqual(await first.tools[0]!.execute("call", {}), textResult("first:teacher"));
	await f.host.setEnabled("example", false);
	await assert.rejects(first.tools[0]!.execute("call", {}), /disabled or unavailable/);
	assert.throws(() => ctx.registerInstructions({ agents: ["teacher"], text: "late" }), /no longer active/);
	assert.throws(() => ctx.registerTools({ agents: ["teacher"], create: () => [] }), /no longer active/);
	const current = await f.context();
	current.registerTools({ agents: ["teacher"], create: () => [native("new_activation")] });
	offTools(); // A stale unregister must not touch the new activation.
	const fresh = f.host.agentContributions(turn(), []);
	assert.equal(fresh.tools[0]!.name, "new_activation");
	assert.equal(f.disposedServices(), 1);
	await f.host.dispose();
	await assert.rejects(fresh.tools[0]!.execute("late", {}), /disabled or unavailable/);
	assert.throws(() => f.host.agentContributions(turn(), []), /disposed/);
});

test("factories changing registrations affect only subsequent turn snapshots", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	let registered = false;
	ctx.registerTools({ agents: ["teacher"], create() {
		if (!registered) {
			registered = true;
			ctx.registerInstructions({ agents: ["teacher"], text: "Next turn only" });
			ctx.registerTools({ agents: ["teacher"], create: () => [native("next_turn")] });
		}
		return [native("current_turn")];
	} });
	const first = f.host.agentContributions(turn(), []);
	assert.deepEqual(first.instructions, []);
	assert.deepEqual(first.tools.map(tool => tool.name), ["current_turn"]);
	const second = f.host.agentContributions(turn(), []);
	assert.deepEqual(second.instructions, ["Next turn only"]);
	assert.deepEqual(second.tools.map(tool => tool.name), ["current_turn", "next_turn"]);
	assert.deepEqual(first.tools.map(tool => tool.name), ["current_turn"]);
});

test("invalid contributions during activation use existing failure cleanup and diagnostics", async t => {
	const f = fixture(t);
	f.plugin("invalid", `exports.activate = ctx => { ctx.registerInstructions({agents:[],text:'no targets'}); };`);
	await f.host.initialize(); await f.host.setEnabled("invalid", true);
	assert.equal(f.host.list()[0]!.status, "error");
	assert.match(f.host.list()[0]!.error!, /explicit nonempty/);
	assert.equal(f.disposedServices(), 1);
	assert.deepEqual(f.host.agentContributions(turn(), []), { instructions: [], tools: [] });
});

test("all roles append instructions/tools without replacing builtin prompt, gates, or explicit test registries", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	ctx.registerInstructions({ agents: ["prober", "teacher", "practice"], text: "Plugin appendix" });
	const contexts: PluginToolContext[] = [];
	ctx.registerTools({ agents: ["prober", "teacher", "practice"], create(context) { contexts.push(context); return [native(`addon_${context.agent}`)]; } });
	const builders = {
		prober: (opts: AgentBuildOptions) => createProberAgent({ chatId: opts.chatId } as never, opts),
		teacher: (opts: AgentBuildOptions) => createTeacherAgent(undefined, opts),
		practice: (opts: AgentBuildOptions) => createPracticeAgent({ chatId: opts.chatId, chatStore: { getChat: () => null } } as never, opts),
	};
	for (const role of ["prober", "teacher", "practice"] as const) {
		const opts: AgentBuildOptions = { engine: engine(), chatId: `chat-${role}`, toolToggles: { research: false, pdf: false } };
		const core = builders[role](opts);
		const extended = builders[role]({ ...opts, pluginContributions: f.host.agentContributions });
		assert.equal(extended.state.systemPrompt, `${core.state.systemPrompt}\n\n---\n\nPlugin appendix`);
		assert.ok(extended.state.systemPrompt.startsWith(composeInstructions(role)));
		assert.deepEqual(extended.state.tools.map(tool => tool.name), [...core.state.tools.map(tool => tool.name), `addon_${role}`]);
		assert.deepEqual(contexts.at(-1), { chatId: `chat-${role}`, agent: role });
		for (const tool of core.state.tools) assert.ok((CONVERSATION_TOOL_NAMES as readonly string[]).includes(tool.name));
		const count = contexts.length;
		const explicit = builders[role]({ ...opts, tools: {}, pluginContributions: f.host.agentContributions });
		const unchanged = builders[role]({ ...opts, tools: {} });
		assert.deepEqual(explicit.state.tools.map(tool => tool.name), unchanged.state.tools.map(tool => tool.name));
		assert.equal(explicit.state.systemPrompt, unchanged.state.systemPrompt);
		builders[role]({ ...opts, chatId: undefined, pluginContributions: f.host.agentContributions });
		assert.equal(contexts.length, count);
	}
	const running = builders.teacher({ engine: engine(), chatId: "running", pluginContributions: f.host.agentContributions });
	const prompt = running.state.systemPrompt;
	await f.host.setEnabled("example", false);
	assert.equal(running.state.systemPrompt, prompt); // No live prompt rewriting.
	const next = builders.teacher({ engine: engine(), chatId: "next", pluginContributions: f.host.agentContributions });
	assert.equal(next.state.systemPrompt, composeInstructions("teacher"));
	await assert.rejects(running.state.tools.find(tool => tool.name === "addon_teacher")!.execute("late", {}), /disabled or unavailable/);
});

test("builtin names remain reserved when absent; first valid package wins and invalid packages reserve nothing", async t => {
	const f = fixture(t); for (const id of ["a-first", "b-collision", "c-next", "d-builtin"]) f.plugin(id);
	// Enable in reverse order: precedence must follow package IDs, not toggle order.
	const builtin = await f.context("d-builtin"), next = await f.context("c-next"), collision = await f.context("b-collision"), first = await f.context("a-first");
	first.registerInstructions({ agents: ["teacher"], text: "First survives" });
	first.registerTools({ agents: ["teacher"], create: () => [native("shared_name")] });
	collision.registerInstructions({ agents: ["teacher"], text: "Omit entire package" });
	collision.registerTools({ agents: ["teacher"], create: () => [native("otherwise_unique"), native("shared_name")] });
	next.registerTools({ agents: ["teacher"], create: () => [native("otherwise_unique")] });
	builtin.registerInstructions({ agents: ["teacher"], text: "No gated builtin shadowing" });
	builtin.registerTools({ agents: ["teacher"], create: () => [native("research")] });
	const changes = f.changes();
	const agent = createTeacherAgent(undefined, { engine: engine(), chatId: "no-core-research", pluginContributions: f.host.agentContributions });
	assert.deepEqual(agent.state.tools.map(tool => tool.name), ["quiz", "ask_user_question", "shared_name", "otherwise_unique"]);
	assert.ok(agent.state.systemPrompt.includes("First survives"));
	assert.ok(!agent.state.systemPrompt.includes("Omit entire package"));
	assert.ok(!agent.state.systemPrompt.includes("No gated builtin shadowing"));
	for (const id of ["b-collision", "d-builtin"]) {
		const info = f.host.list().find(item => item.id === id)!;
		assert.equal(info.status, "active"); assert.match(info.error!, /name collision/);
		assert.ok(await f.host.call(id, "context"));
		assert.ok(f.host.asset(id, ["main.js"]).bytes.length); // Warning does not shut down UI/backend.
	}
	assert.ok(f.changes() > changes);
	assert.equal(f.host.list().find(item => item.id === "a-first")!.error, undefined);
});

test("Claude-conditional send_to_user stays reserved when hidden and plugins append after model-bound builtins", async t => {
	const f = fixture(t); f.plugin("a-addon"); f.plugin("b-shadow");
	const addon = await f.context("a-addon"), shadow = await f.context("b-shadow");
	addon.registerTools({ agents: ["prober", "teacher", "practice"], create: () => [native("addon")] });
	shadow.registerInstructions({ agents: ["prober", "teacher", "practice"], text: "Must not replace output mechanics" });
	shadow.registerTools({ agents: ["prober", "teacher", "practice"], create: () => [native("send_to_user")] });
	const { readTool } = await import("../src/agent/tools/read.ts");
	const builders = {
		prober: (opts: AgentBuildOptions) => createProberAgent({ chatId: opts.chatId } as never, opts),
		teacher: (opts: AgentBuildOptions) => createTeacherAgent(undefined, opts),
		practice: (opts: AgentBuildOptions) => createPracticeAgent({ chatId: opts.chatId, chatStore: { getChat: () => null } } as never, opts),
	};
	for (const [provider, id, enabled] of [["openai", "gpt-fixture", false], ["openrouter", "anthropic/claude-fixture", true], ["claude-code", "sonnet", true]] as const) {
		const faux = createFauxCore({ provider, models: [{ id }] });
		const selected = { model: faux.getModel(), streamFn: faux.streamSimple };
		for (const [role, build] of Object.entries(builders)) {
			const opts = { engine: selected, chatId: `conditional-${role}` };
			const core = build(opts), extended = build({ ...opts, pluginContributions: f.host.agentContributions });
			assert.deepEqual(extended.state.tools.map(tool => tool.name), [...core.state.tools.map(tool => tool.name), "addon"]);
			assert.equal(extended.state.tools.filter(tool => tool.name === "send_to_user").length, enabled ? 1 : 0);
			assert.equal(extended.state.systemPrompt, core.state.systemPrompt);
			assert.match(f.host.list().find(info => info.id === "b-shadow")!.error!, /name collision/);
			if (role === "prober") assert.notEqual(extended.state.tools.find(tool => tool.name === "read")!.execute, readTool.execute);
		}
	}
});

test("plugin tools and Claude output preserve practice correction and mixed-batch pose stopping", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	ctx.registerTools({ agents: ["practice"], create: () => [native("practice_addon")] });
	const faux = createFauxCore({ provider: "anthropic", models: [{ id: "claude-plugin-fixture" }] });
	faux.setResponses([
		fauxAssistantMessage([
			fauxToolCall("send_to_user", { message: "Try this exercise." }, { id: "send-one" }),
			fauxToolCall("practice_addon", {}, { id: "addon-one" }),
			fauxToolCall("problem", { statement: "Incomplete", mode: "recall" }, { id: "bad-pose" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("practice_addon", {}, { id: "addon-two" }),
			fauxToolCall("send_to_user", { message: "Corrected exercise." }, { id: "send-two" }),
			fauxToolCall("problem", { statement: "What is two plus two?", mode: "recall", modelSolution: "Four." }, { id: "good-pose" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Must not continue before the learner answers."),
	]);
	const agent = createPracticeAgent({ chatId: "mixed-plugin-practice", chatStore: { getChat: () => null } }, {
		engine: { model: faux.getModel(), streamFn: faux.streamSimple }, chatId: "mixed-plugin-practice", pluginContributions: f.host.agentContributions,
	});
	await agent.prompt("Pose an offline exercise.");
	assert.equal(faux.state.callCount, 2);
	const poses = agent.state.messages.filter(message => message.role === "toolResult" && message.toolName === "problem");
	assert.equal(poses.length, 2); assert.equal(poses[0]!.role === "toolResult" && poses[0]!.isError, true); assert.equal(poses[1]!.role === "toolResult" && poses[1]!.isError, false);
});

test("context-specific factory errors omit that turn only; successful re-evaluation clears the active warning", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	ctx.registerInstructions({ agents: ["teacher"], text: "Restored on good context" });
	ctx.registerTools({ agents: ["teacher"], create(context) {
		if (context.chatId === "bad") throw Error("factory context rejected");
		return [native("recovered")];
	} });
	assert.deepEqual(f.host.agentContributions(turn("bad"), []), { instructions: [], tools: [] });
	assert.equal(f.host.list()[0]!.status, "active"); assert.match(f.host.list()[0]!.error!, /factory context rejected/);
	const recovered = f.host.agentContributions(turn("good"), []);
	assert.deepEqual(recovered.instructions, ["Restored on good context"]);
	assert.equal(recovered.tools[0]!.name, "recovered");
	assert.equal(f.host.list()[0]!.status, "active");
	assert.equal(f.host.list()[0]!.error, undefined);
	await f.host.refresh(); assert.equal(f.host.list()[0]!.error, undefined);
	f.host.agentContributions(turn("bad"), []);
	assert.match(f.host.list()[0]!.error!, /factory context rejected/);
	fs.writeFileSync(path.join(f.directory, "example", "main.js"), "export const updated = true;");
	await f.host.refresh();
	assert.match(f.host.list()[0]!.error!, /Restart required.*factory context rejected/);
	const changes = f.changes();
	assert.equal(f.host.agentContributions(turn("good"), []).tools[0]!.name, "recovered");
	assert.equal(f.host.list()[0]!.status, "active");
	assert.match(f.host.list()[0]!.error!, /Restart required/);
	assert.doesNotMatch(f.host.list()[0]!.error!, /factory context rejected|Agent contributions/);
	assert.ok(f.changes() > changes);
});

test("invalid native names, duplicate names, and malformed factories isolate their package loadout", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	ctx.registerInstructions({ agents: ["teacher"], text: "Must disappear with invalid tools" });
	for (const name of ["bad.name", "2leading", "space name", "", "x".repeat(65)]) {
		const off = ctx.registerTools({ agents: ["teacher"], create: () => [native(name)] });
		assert.deepEqual(f.host.agentContributions(turn(), []), { instructions: [], tools: [] });
		assert.match(f.host.list()[0]!.error!, /Invalid native plugin tool name/); off();
	}
	const duplicate = ctx.registerTools({ agents: ["teacher"], create: () => [native("same"), native("same")] });
	assert.equal(f.host.agentContributions(turn(), []).tools.length, 0); duplicate();
	for (const create of [() => null, () => [native("broken", null as never)], () => [{ ...native("bad_mode"), executionMode: "unknown" }], () => [{ ...native("bad_replay"), replay: "unknown" }], async () => { throw Error("async factory failure"); }]) {
		const off = ctx.registerTools({ agents: ["teacher"], create } as never);
		assert.deepEqual(f.host.agentContributions(turn(), []), { instructions: [], tools: [] }); off();
	}
	await Promise.resolve();
	assert.equal(f.host.list()[0]!.status, "active");
});

test("basic native-schema hygiene preserves extensions/unions/refs and ignores annotation data", () => {
	const schema = {
		type: "object", $defs: { choice: { type: ["string", "null"] } },
		properties: { choice: { $ref: "#/$defs/choice" } }, required: ["choice"],
		default: { type: "literal-data-not-a-type" }, examples: [{ properties: "literal-data" }],
		"x-extension": { type: "extension-owned", anyOf: "not-a-schema-position" },
	};
	const validator = validatePluginSchema(schema);
	assert.equal(validator.Check({ choice: null }), true);
	assert.equal(validator.Check({ choice: "native" }), true);
	assert.equal(validator.Check({ choice: 42 }), false);
	assert.equal(validatePluginSchema(Type.BigInt()).Check(1n), true);
	assert.equal(validatePluginSchema(Type.Function([Type.String()], Type.Boolean())).Check(() => true), true);
	assert.equal(validatePluginSchema(true).Check("any data"), true);
	assert.equal(validatePluginSchema(false).Check("any data"), false);
	assert.doesNotThrow(() => validatePluginSchema({ enum: [{ type: "data" }, { properties: [] }] }));
	assert.doesNotThrow(() => validatePluginSchema({ type: "string", required: false, exclusiveMinimum: false }));
	for (const malformed of [
		{ type: "not-a-json-schema-type" }, { properties: { nested: { type: "bogus" } } },
		{ properties: { nested: { anyOf: "not-an-array" } } }, { properties: [] },
		{ $defs: { nested: { items: 42 } } }, { required: "not-an-array" },
	]) assert.throws(() => validatePluginSchema(malformed), /Malformed native schema/);
});

test("malformed parameter/output schemas omit the whole package; later valid packages and native core still run", async t => {
	const f = fixture(t); f.plugin("a-invalid"); f.plugin("b-valid");
	const bad = await f.context("a-invalid"), good = await f.context("b-valid");
	bad.registerInstructions({ agents: ["teacher"], text: "Must not poison core" });
	good.registerInstructions({ agents: ["teacher"], text: "Valid appendix" });
	good.registerTools({ agents: ["teacher"], create: () => [native("shared_schema_tool")] });
	for (const [field, schema] of [
		["parameters", { type: "not-a-json-schema-type" }],
		["parameters", { type: "object", properties: { nested: { anyOf: "not-an-array" } } }],
		["outputSchema", { type: "not-a-json-schema-type" }],
		["outputSchema", { type: "object", properties: { nested: { type: "bogus" } } }],
	] as const) {
		const off = bad.registerTools({ agents: ["teacher"], create: () => [{ ...native("shared_schema_tool"), [field]: schema }] });
		const faux = createFauxCore({}); faux.setResponses([fauxAssistantMessage("Core remains usable")]);
		const agent = createTeacherAgent(undefined, { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, chatId: "schema-isolation", pluginContributions: f.host.agentContributions });
		assert.deepEqual(agent.state.tools.map(tool => tool.name), ["quiz", "ask_user_question", "shared_schema_tool"]);
		assert.ok(agent.state.systemPrompt.includes("Valid appendix"));
		assert.ok(!agent.state.systemPrompt.includes("Must not poison core"));
		assert.equal(f.host.list()[0]!.status, "active");
		assert.match(f.host.list()[0]!.error!, /Invalid native plugin tool schema/);
		assert.equal(f.host.list()[1]!.error, undefined);
		await agent.prompt("Offline schema regression");
		assert.equal(faux.state.callCount, 1); off();
	}
});

test("shared inference-option validation preserves the exact existing generation allowlist", () => {
	assert.deepEqual(validatePluginInferenceOptions(undefined), {});
	for (const cacheRetention of ["none", "short", "long"] as const) {
		const options = { cacheRetention, maxTokens: 12, temperature: 0, reasoning: "high" as const, thinkingBudgets: { high: 12 }, metadata: { nested: ["data"] } };
		const safe = validatePluginInferenceOptions(options);
		assert.deepEqual(safe, options); assert.notEqual(safe.metadata, options.metadata);
	}
	for (const options of [{ cacheRetention: "invalid" }, { maxTokens: 0 }, { signal: new AbortController().signal }, { apiKey: "not-allowed" }, { thinkingBudgets: { off: 1 } }]) assert.throws(() => validatePluginInferenceOptions(options as never));
});

test("captured executions combine caller/activation abort, fence late updates, and reject noncooperative late success", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	let started!: () => void, capturedSignal!: AbortSignal, update!: (result: AgentToolResult) => void;
	let startedPromise = new Promise<void>(resolve => { started = resolve; });
	ctx.registerTools({ agents: ["teacher"], create: () => [native("wait", async (_id, _input, signal, onUpdate) => {
		capturedSignal = signal!; update = onUpdate!; started();
		return await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
	})] });
	const tool = f.host.agentContributions(turn(), []).tools[0]!;
	const caller = new AbortController(); let updates = 0;
	const pending = tool.execute("call", {}, caller.signal, () => { updates++; });
	const rejected = assert.rejects(pending); await startedPromise;
	assert.notEqual(capturedSignal, ctx.signal);
	update(textResult("before")); assert.equal(updates, 1);
	caller.abort(); await rejected;
	assert.equal(ctx.signal.aborted, false); update(textResult("late")); assert.equal(updates, 1);
	startedPromise = new Promise<void>(resolve => { started = resolve; });
	const disablePending = tool.execute("call", {}); const disabled = assert.rejects(disablePending); await startedPromise;
	await f.host.setEnabled("example", false); await disabled;
	assert.equal(capturedSignal.aborted, true);
	await assert.rejects(tool.execute("late", {}), /disabled or unavailable/);
	const fresh = await f.context(); let finish!: (result: AgentToolResult) => void;
	fresh.registerTools({ agents: ["teacher"], create: () => [native("ignores_abort", async () => await new Promise(resolve => { finish = resolve; }))] });
	const captured = f.host.agentContributions(turn(), []).tools[0]!;
	const noncooperative = captured.execute("call", {}); const stopped = assert.rejects(noncooperative);
	await f.host.setEnabled("example", false); finish(textResult("late success")); await stopped;
});

test("native Pi Agent executes contributed tools with schemas, preparation, updates, result details and usage intact", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	const result = { content: [{ type: "text" as const, text: "Native result" }], details: { plugin: true, values: [1, 2] }, structuredContent: { value: 2 } };
	const schema = Type.Object({ value: Type.Number() });
	ctx.registerTools({ agents: ["teacher"], create: () => [{
		name: "native_roundtrip", label: "Native label", description: "Native semantics", parameters: schema, outputSchema: schema,
		replay: "safe", executionMode: "parallel",
		prepareArguments: args => ({ value: Number((args as { value: unknown }).value) }),
		execute: async (id, input, signal, onUpdate) => {
			assert.equal(id, "native-call"); assert.deepEqual(input, { value: 2 }); assert.equal(signal!.aborted, false);
			onUpdate?.({ content: [{ type: "text", text: "Working" }], details: { partial: true } }); return result;
		},
	}] });
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxToolCall("native_roundtrip", { value: "2" }, { id: "native-call" })], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
	let usage = 0, updates = 0;
	const agent = createTeacherAgent(undefined, { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, chatId: "native-chat", pluginContributions: f.host.agentContributions, onUsage: () => { usage++; } });
	agent.subscribe(event => { if (event.type === "tool_execution_update") updates++; });
	const captured = agent.state.tools.find(tool => tool.name === "native_roundtrip")!;
	assert.equal(captured.parameters, schema); assert.equal(captured.outputSchema, schema);
	assert.equal(captured.label, "Native label"); assert.equal(captured.replay, "safe"); assert.equal(captured.executionMode, "parallel");
	await agent.prompt("Offline test");
	const toolResult = agent.state.messages.find(message => message.role === "toolResult")!;
	assert.equal(toolResult.role, "toolResult");
	if (toolResult.role === "toolResult") {
		assert.deepEqual(toolResult.details, result.details); assert.deepEqual(toolResult.content, result.content);
		assert.notEqual(toolResult.isError, true);
	}
	assert.equal(faux.state.callCount, 2); assert.equal(usage, 2); assert.equal(updates, 1);
	await f.host.setEnabled("example", false);
	assert.throws(() => captured.prepareArguments!({ value: "2" }), /disabled or unavailable/);
});

test("server contribution accessor uses the initialized process-global host", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	ctx.registerInstructions({ agents: ["teacher"], text: "Accessor contribution" });
	const global = globalThis as typeof globalThis & { __lhPlugins?: unknown };
	const previous = global.__lhPlugins;
	global.__lhPlugins = { host: f.host, ready: Promise.resolve() };
	try {
		const { getPluginAgentContributions } = await import("../src/server/plugins.ts");
		const contributions = await getPluginAgentContributions();
		assert.deepEqual(contributions(turn(), []).instructions, ["Accessor contribution"]);
	} finally { if (previous === undefined) delete global.__lhPlugins; else global.__lhPlugins = previous; }
});
