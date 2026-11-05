import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { PluginBackendContext, PluginInference, PluginLearningData } from "../src/core/plugins.ts";
import type { PluginQuestionTypeDefinition } from "../src/core/plugin-questions.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";
import type { PluginWorkerService } from "../src/core/plugin-workers.ts";
import { createPluginHost } from "../src/server/plugin-host.ts";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-question-registration-"));
	const directory = path.join(root, "plugins");
	fs.mkdirSync(directory);
	const host = createPluginHost({ directory, appVersion: "0.4.1", createServices: () => ({
		learning: {} as PluginLearningData, inference: {} as PluginInference,
		agents: { dispose: async () => {} } as PluginAgentService,
		workers: { dispose: async () => {} } as PluginWorkerService,
		createBackgroundTool() { throw new Error("Unexpected background tool"); },
	}) });
	t.after(async () => { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
	function plugin(id = "example") {
		const location = path.join(directory, id, "dist");
		fs.mkdirSync(location, { recursive: true });
		fs.writeFileSync(path.join(location, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.0", backend: "backend.cjs" }));
		fs.writeFileSync(path.join(location, "backend.cjs"), "exports.activate = ctx => { ctx.handle('context', () => ctx); };");
	}
	async function context(id = "example") {
		await host.setEnabled(id, true);
		return await host.call(id, "context") as PluginBackendContext;
	}
	return { host, plugin, context };
}
const turn = (agent: "prober" | "teacher" | "practice" = "teacher") => ({ chatId: "question-chat", agent });
function definition(overrides: Partial<PluginQuestionTypeDefinition> = {}): PluginQuestionTypeDefinition {
	return { id: "format", label: "A question", contractVersion: 1, showThinking: true,
		questionSchema: Type.Object({ instruction: Type.String() }), answerSchema: Type.String(),
		teach: { toolName: "plugin_question", description: "Ask a native question" }, ...overrides };
}
function tool(name: string) {
	return { name, label: name, description: "Ordinary native tool", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ordinary" }], details: null }) };
}

test("question registration generates only explicitly declared agent variants and copies contracts", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	const schema = Type.Object({ instruction: Type.String() });
	const authored = definition({ questionSchema: schema, probe: { toolName: "plugin_probe", description: "Probe this format" } });
	ctx.registerQuestionType(authored);
	authored.label = "Mutated";
	authored.teach!.toolName = "mutated_name";
	schema.properties.instruction.type = "number" as never;
	const teach = f.host.agentContributions(turn(), []);
	assert.deepEqual(teach.tools, []);
	assert.equal(teach.questionTypes?.length, 1);
	const contribution = teach.questionTypes![0]!;
	assert.equal(contribution.pluginId, "example");
	assert.equal(contribution.variant, "teach");
	assert.equal(contribution.definition.label, "A question");
	assert.equal(contribution.definition.teach!.toolName, "plugin_question");
	assert.equal((contribution.definition.questionSchema as typeof schema).properties.instruction.type, "string");
	assert.ok(Object.isFrozen(contribution));
	assert.ok(Object.isFrozen(contribution.definition));
	assert.equal(f.host.agentContributions(turn("prober"), []).questionTypes?.[0]?.variant, "probe");
	assert.deepEqual(f.host.agentContributions(turn("practice"), []), { instructions: [], tools: [] });
});

test("teach-only registration does not invent a probe tool", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	ctx.registerQuestionType(definition());
	assert.deepEqual(f.host.agentContributions(turn("prober"), []), { instructions: [], tools: [] });
	assert.equal(f.host.agentContributions(turn(), []).questionTypes?.[0]?.definition.id, "format");
});

test("question collisions reject the entire package contribution, not its ordinary tools or instructions alone", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	let factories = 0;
	ctx.registerInstructions({ agents: ["teacher"], text: "Must not leak when rejected" });
	ctx.registerTools({ agents: ["teacher"], create: () => { factories++; return [tool("ordinary")]; } });
	const off = ctx.registerQuestionType(definition({ teach: { toolName: "reserved", description: "Reserved collision" } }));
	assert.deepEqual(f.host.agentContributions(turn(), ["reserved"]), { instructions: [], tools: [] });
	assert.equal(factories, 1);
	assert.equal(f.host.list()[0]!.status, "active");
	assert.match(f.host.list()[0]!.error!, /collision/);
	off();
	ctx.registerQuestionType(definition());
	const recovered = f.host.agentContributions(turn(), ["reserved"]);
	assert.deepEqual(recovered.instructions, ["Must not leak when rejected"]);
	assert.deepEqual(recovered.tools.map(entry => entry.name), ["ordinary"]);
	assert.equal(recovered.questionTypes?.length, 1);
	assert.equal(f.host.list()[0]!.error, undefined);
	assert.equal(factories, 2);
});

test("ordinary and question tool names share one per-package collision namespace", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	ctx.registerTools({ agents: ["teacher"], create: () => [tool("plugin_question")] });
	ctx.registerQuestionType(definition());
	assert.deepEqual(f.host.agentContributions(turn(), []), { instructions: [], tools: [] });
	assert.match(f.host.list()[0]!.error!, /collision/);
});

test("question registrations are frozen before any package factory can replace them", async t => {
	const f = fixture(t); f.plugin("a"); f.plugin("b");
	const a = await f.context("a"), b = await f.context("b");
	const off = b.registerQuestionType(definition());
	let changed = false;
	a.registerTools({ agents: ["teacher"], create: () => {
		if (!changed) { changed = true; off(); b.registerQuestionType(definition({ label: "Next turn" })); }
		return [];
	} });
	assert.equal(f.host.agentContributions(turn(), []).questionTypes?.[0]?.definition.label, "A question");
	assert.equal(f.host.agentContributions(turn(), []).questionTypes?.[0]?.definition.label, "Next turn");
});

test("unregister affects future turns, disable invalidates accepted descriptors, and stale cleanup cannot remove replacements", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	const off = ctx.registerQuestionType(definition());
	const accepted = f.host.agentContributions(turn(), []).questionTypes![0]!;
	const resolved = f.host.resolveQuestionType("example", "format", 1);
	assert.equal(resolved.status, "available");
	off(); off();
	accepted.requireActive();
	assert.deepEqual(f.host.agentContributions(turn(), []), { instructions: [], tools: [] });
	if (resolved.status === "available") assert.throws(() => resolved.requireActive(), /unavailable/);
	ctx.registerQuestionType(definition({ label: "Replacement" }));
	off();
	assert.equal(f.host.agentContributions(turn(), []).questionTypes?.[0]?.definition.label, "Replacement");
	await f.host.setEnabled("example", false);
	assert.ok(accepted.signal.aborted);
	assert.throws(() => accepted.requireActive(), /disabled or unavailable/);
	assert.equal(f.host.resolveQuestionType("example", "format", 1).status, "unavailable");
	assert.throws(() => ctx.registerQuestionType(definition()), /no longer active/);
});

test("contract numbers alone preserve unavailable pending semantics; only explicit active-owner incompatibility authorizes cancellation", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	const off = ctx.registerQuestionType(definition({ contractVersion: 2 }));
	assert.equal(f.host.resolveQuestionType("example", "format", 2).status, "available");
	assert.equal(f.host.resolveQuestionType("example", "format", 1).status, "unavailable");
	off();
	ctx.registerQuestionType(definition({ contractVersion: 2, incompatibleContractVersions: [1] }));
	assert.equal(f.host.resolveQuestionType("example", "format", 1).status, "incompatible");
	assert.equal(f.host.resolveQuestionType("example", "format", 3).status, "unavailable");
	assert.equal(f.host.resolveQuestionType("other-owner", "format", 1).status, "unavailable");
	assert.equal(f.host.resolveQuestionType("example", "other-type", 1).status, "unavailable");
	await f.host.setEnabled("example", false);
	assert.equal(f.host.resolveQuestionType("example", "format", 1).status, "unavailable");
});

test("duplicate type IDs reject registration and dispositions remain activation-owned", async t => {
	const f = fixture(t); f.plugin(); const ctx = await f.context();
	const off = ctx.registerQuestionType(definition());
	assert.throws(() => ctx.registerQuestionType(definition({ contractVersion: 2 })), /Duplicate plugin question type/);
	await f.host.setEnabled("example", false);
	const next = await f.context();
	next.registerQuestionType(definition());
	off();
	assert.equal(f.host.resolveQuestionType("example", "format", 1).status, "available");
});
