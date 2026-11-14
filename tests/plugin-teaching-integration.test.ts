import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ModelCatalogResponse } from "../src/core/contracts/models.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";
import type { PluginBackgroundResult, PluginWorkerService } from "../src/core/plugin-workers.ts";
import type { PluginLearningData } from "../src/core/plugins.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { SteerMessage } from "../src/core/contracts/jobs.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-teaching-plugin-"));
const data = path.join(root, "data");
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network in teaching-plugin integration"); };
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });

// Configure storage BEFORE loading any module which reads app paths.
const { createPluginHost } = await import("../src/server/plugin-host.ts");
const { createPluginInference } = await import("../src/server/plugin-inference.ts");
const { createPluginWorkerService } = await import("../src/agent/plugin-workers.ts");
const { createPluginTaskRecordStore } = await import("../src/store/plugin-task-records.ts");
const { createPluginBackgroundTool } = await import("../src/server/plugin-background-tools.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { registerJobAbort, unregisterJobAbort, isJobLive } = await import("../src/agent/subagents/aborts.ts");
const { projectView } = await import("../src/core/view.ts");

test("external teaching example composes native tools, validated workers, separate delivery and automatic native-record storage", { timeout: 10000 }, async t => {
	const directory = path.join(data, "plugins");
	fs.mkdirSync(directory, { recursive: true });
	const installed = path.join(directory, "teaching-extension");
	fs.cpSync(path.resolve("examples/plugins/teaching-extension"), installed, { recursive: true });
	const foreground = createFauxCore({}), worker = createFauxCore({});
	foreground.setResponses([
		fauxAssistantMessage([fauxToolCall("teaching_extension_echo", { text: "Native echo" }, { id: "echo_call" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("teaching_extension_note", { topic: "Finite sets" }, { id: "worker_call" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("The note worker was dispatched; its result arrives separately."),
	]);
	worker.setResponses([fauxAssistantMessage([fauxToolCall("submit_result", { result: { note: "A finite set has finitely many elements." } }, { id: "submit_call" })], { stopReason: "toolUse" })]);
	const model = worker.getModel(), pin = { provider: model.provider, id: model.id };
	const slot = { model: pin, thinkingLevel: "off" as const };
	const catalog: ModelCatalogResponse = {
		models: [{ ...pin, name: "Offline fixture", reasoning: false, supportedLevels: [], input: ["text"], contextWindow: 10000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		providers: [{ id: pin.provider, envVar: "FIXTURE_ONLY", keyPresent: true }], defaults: slot,
		slots: { strong: slot, cheap: slot, vision: slot }, rolePins: {} as ModelCatalogResponse["rolePins"],
	};
	let service!: PluginWorkerService;
	let delivered!: (message: SteerMessage) => void;
	const delivery = new Promise<SteerMessage>(resolve => { delivered = resolve; });
	const host = createPluginHost({ directory, appVersion: "0.3.7", createServices(info) {
		const inference = createPluginInference({ dataDirectory: info.dataDirectory, signal: info.signal }, {
			catalog: () => catalog, providerKeyPresent: () => true,
			engineForSpec: () => ({ model, level: "off", streamFn: (m, context, options) => {
				assert.equal(options?.maxTokens, 1024, "worker generation budget reaches every native model call");
				return worker.streamSimple(m, context, options);
			} }),
		});
		service = createPluginWorkerService({ store: createPluginTaskRecordStore(path.join(info.dataDirectory, "tasks")), engineFor: inference.engineFor, onUsage: inference.onUsage, signal: info.signal });
		return {
			learning: { directory: data } as PluginLearningData, inference: inference.inference,
			agents: { dispose: async () => {} } as PluginAgentService, workers: service,
			createBackgroundTool: (context, definition) => createPluginBackgroundTool({
				pluginId: info.manifest.id, context, definition, workers: service, signal: info.signal, isActive: () => !info.signal.aborted,
				jobStore, registerAbort: registerJobAbort, unregisterAbort: unregisterJobAbort,
				deliver: async message => { delivered(message); },
			}),
		};
	} });
	t.after(() => host.dispose());
	await host.initialize();
	assert.equal(foreground.state.callCount + worker.state.callCount, 0, "discovery makes no model calls");
	await host.setEnabled("teaching-extension", true);
	assert.equal(worker.state.callCount, 0, "activation registers definitions but does not start work");
	const chat = chatStore.createChat("Offline teaching extension proof");
	const agent = createTeacherAgent(undefined, { chatId: chat.id, engine: { model: foreground.getModel(), streamFn: foreground.streamSimple }, pluginContributions: host.agentContributions });
	assert.equal(host.list()[0]?.status, "active", JSON.stringify(host.list()));
	assert.equal(host.list()[0]?.error, undefined, JSON.stringify(host.list()));
	assert.match(agent.state.systemPrompt, /optional teaching-extension demonstration/);
	assert(agent.state.tools.some(tool => tool.name === "quiz"), "core tools remain available");
	await agent.prompt("Explicitly try the normal tool and background worker examples.");
	const steer = await delivery;
	const result = (steer.details as { result: PluginBackgroundResult }).result;
	assert.equal(result.outcome.status, "succeeded");
	assert.deepEqual(result.outcome.status === "succeeded" && result.outcome.result, { note: "A finite set has finitely many elements." });
	assert.match(steer.content, /finite set/);
	assert.equal(foreground.state.callCount, 3);
	assert.equal(worker.state.callCount, 1);
	const echoed = agent.state.messages.find(message => message.role === "toolResult" && message.toolCallId === "echo_call");
	assert(echoed?.role === "toolResult");
	assert.deepEqual(echoed.details, { text: "Native echo", chatId: chat.id, agent: "teacher" });
	const acknowledgement = agent.state.messages.find(message => message.role === "toolResult" && message.toolCallId === "worker_call");
	assert(acknowledgement?.role === "toolResult");
	assert.equal((acknowledgement.details as { dispatched: boolean }).dispatched, true);
	assert.equal(JSON.stringify(acknowledgement).includes("finitely many"), false, "later outcome never overwrites original ack");
	const nativeHistory = agent.state.messages.filter(message => (message as { role: string }).role !== "system")
		.map((message, index) => ({ ...message, id: `native_${index}` }) as LhMessage);
	chatStore.saveMessages(chat.id, [...nativeHistory, steer]);
	const saved = chatStore.getChat(chat.id)!;
	assert(saved.messages.some(message => message.id === steer.id));
	const view = projectView(saved.messages);
	assert(view.flatMap(message => message.parts).some(part => part.type === "tool-teaching_extension_echo"));
	assert(view.flatMap(message => message.parts).some(part => part.type === "data-subagent-artifact"));
	assert.equal(service.get(result.outcome.id).status, "succeeded");
	assert.match(fs.readFileSync(path.join(installed, "data", "usage.jsonl"), "utf8"), new RegExp(pin.provider));
	await host.setEnabled("teaching-extension", false);
	assert.equal(service.get(result.outcome.id).status, "succeeded", "disable preserves accepted results");
	assert.equal(isJobLive((acknowledgement.details as { jobId: string }).jobId), false);
	assert.deepEqual(host.agentContributions({ chatId: chat.id, agent: "teacher" }, []), { instructions: [], tools: [] });
});
