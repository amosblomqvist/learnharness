import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createPluginHost, isPluginHostError } from "../src/server/plugin-host.ts";
import { createPluginInference, type PluginInferenceDeps } from "../src/server/plugin-inference.ts";
import { createPluginAgentService } from "../src/agent/plugin-agents.ts";
import { createPluginAgentRecordStore } from "../src/store/plugin-agent-records.ts";
import { createPluginLearningData } from "../src/server/plugin-learning.ts";
import type { PluginAgentRecord, PluginAgentSnapshot } from "../src/core/plugin-agents.ts";
import type { PluginNotification } from "../src/core/plugins.ts";
import type { PluginWorkerService } from "../src/core/plugin-workers.ts";
import type { ModelCatalogResponse } from "../src/core/contracts/models.ts";
import type { ChatRecord, ChatSummary } from "../src/core/contracts/chat.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import type { ServerEvent } from "../src/core/events.ts";

/** Hypothetical integration package, NOT a product feature. The backend uses
 * only its public context and Node builtins; it cannot import test/host internals.
 * Plain JSON schemas keep this genuinely external package dependency-free. */
const backend = `
const fs = require('node:fs');
const path = require('node:path');
const identity = require('./identity.cjs');
let activations = 0;
exports.activate = async ctx => {
  activations++;
  const catalog = await ctx.inference.catalog();
  const selected = catalog.defaults;
  if (!selected) throw new Error('Fixture requires explicit catalog defaults');
  const model = { ...selected.model, thinkingLevel: selected.thinkingLevel };
  const subscriptions = new Map();
  const observe = id => {
    if (subscriptions.has(id)) return;
    const off = ctx.agents.subscribe(id, snapshot => ctx.events.emit('session-state', {
      id: snapshot.id, status: snapshot.status,
      pending: snapshot.pending.map(call => call.toolCallId), messageCount: snapshot.messages.length
    }));
    subscriptions.set(id, off);
    ctx.cleanup(() => { off(); subscriptions.delete(id); });
  };
  ctx.cleanup(ctx.agents.register({
    id: 'integration-agent', instructions: 'Hypothetical ask then publish fixture.', model,
    tools: [
      { name: 'ask', kind: 'input', description: 'Request fixture input',
        parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
        resultSchema: { type: 'string', minLength: 1 } },
      { name: 'publish', description: 'Write a hypothetical plugin-local artifact', endRun: true,
        parameters: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false },
        execute: async (_callId, input, signal) => {
          if (signal.aborted || ctx.signal.aborted) throw new Error('Fixture publication cancelled');
          const artifact = { body: input.body, sourceTitles: ctx.learning.listSessions().map(session => session.title) };
          fs.writeFileSync(path.join(ctx.dataDirectory, 'publication.json'), JSON.stringify(artifact));
          fs.appendFileSync(path.join(ctx.dataDirectory, 'publications.jsonl'), JSON.stringify(artifact) + '\\n');
          ctx.events.emit('published', { filename: 'publication.json' });
          return { content: [{ type: 'text', text: 'Fixture publication written' }], details: { filename: 'publication.json' } };
        } }
    ]
  }));
  ctx.events.on(event => {
    if (event.type === 'record-changed') ctx.events.emit('learning-notice', { chatId: event.chatId });
  });
  ctx.handle('native', () => ({ filename: __filename, directory: __dirname, identity, activations, pluginId: ctx.manifest.id }));
  ctx.handle('learning', () => ({
    sessions: ctx.learning.listSessions(), session: ctx.learning.getSession('learning_fixture'),
    graphFormat: ctx.learning.readGraphFile('format.json'), propositionCount: ctx.learning.graph().propositions.length
  }));
  ctx.handle('create', () => { const snapshot = ctx.agents.create('integration-agent'); observe(snapshot.id); return snapshot; });
  ctx.handle('get', input => ctx.agents.get(input.id));
  ctx.handle('list', () => ctx.agents.list());
  ctx.handle('send', input => ctx.agents.send(input.id, input.text, { requestId: input.requestId, purpose: 'background' }));
  ctx.handle('answer', input => ctx.agents.answer(input.id, input.toolCallId, input.value, { requestId: input.requestId, purpose: 'user' }));
  for (const snapshot of ctx.agents.list()) observe(snapshot.id);
};
`;
const pin = { provider: "fixture", id: "integration-model", thinkingLevel: "off" } as const;
const catalog: ModelCatalogResponse = {
	models: [{ provider: pin.provider, id: pin.id, name: "Offline integration fixture", reasoning: false, input: ["text"], supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
	providers: [{ id: pin.provider, envVar: "", keyPresent: true }], defaults: { model: pin, thinkingLevel: "off" },
	rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null }, slots: { strong: { model: pin }, cheap: null, vision: null },
};
const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const response = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", api: "fixture" as never, provider: pin.provider, model: pin.id, content, stopReason: "toolUse", timestamp: 1, usage: structuredClone(usage) });
const disabled = (error: unknown) => isPluginHostError(error) && error.status === 409;

test("external native backend composes host, inference, persistent managed inputs and endRun publication across activation", { timeout: 8000 }, async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-integration-"));
	const plugins = path.join(root, "plugins"), packageDirectory = path.join(plugins, "integration-fixture");
	const dataDirectory = path.join(packageDirectory, "data"), learningDirectory = path.join(root, "synthetic-learning");
	fs.mkdirSync(packageDirectory, { recursive: true });
	fs.mkdirSync(learningDirectory);
	fs.writeFileSync(path.join(packageDirectory, "manifest.json"), JSON.stringify({ apiVersion: 1, id: "integration-fixture", name: "Hypothetical integration fixture", version: "1.0.0", minAppVersion: "0.3.0", backend: "backend.cjs" }));
	fs.writeFileSync(path.join(packageDirectory, "backend.cjs"), backend);
	fs.writeFileSync(path.join(packageDirectory, "identity.cjs"), "module.exports = 'native-relative-module';\n");
	const learningRecord: ChatRecord = { id: "learning_fixture", title: "Synthetic learning source", createdAt: "2026-01-01", updatedAt: "2026-01-01", messages: [{ id: "source_fixture_message", role: "user", content: "Synthetic source content, not learner data", timestamp: 1 }] };
	const learningFile = path.join(learningDirectory, "learning_fixture.json");
	fs.writeFileSync(learningFile, JSON.stringify(learningRecord));
	const learningBytes = fs.readFileSync(learningFile, "utf8");
	const summaries: ChatSummary[] = [{ id: learningRecord.id, title: learningRecord.title, createdAt: learningRecord.createdAt, updatedAt: learningRecord.updatedAt, kind: "teach", messageCount: 1, phase: "probe", pendingQuestion: false, pendingProblem: false }];
	const chatReads: Pick<ChatStore, "getChat" | "listChats"> = {
		getChat: id => id === learningRecord.id ? JSON.parse(fs.readFileSync(learningFile, "utf8")) as ChatRecord : null,
		listChats: () => structuredClone(summaries),
	};
	const graphReads: Pick<GraphStore, "readNodes" | "readChains" | "readCheckpoints" | "readCoverage" | "readSources" | "readPositions"> = {
		readNodes: () => [], readChains: () => [], readCheckpoints: () => [], readCoverage: () => [], readSources: () => [], readPositions: () => ({}),
	};
	const learning = createPluginLearningData({ directory: learningDirectory, chatStore: chatReads as ChatStore, graphStore: graphReads as GraphStore, isBusy: () => false, isCompacting: () => false, readMetadata: name => name === "format.json" ? { version: 1 } : null });

	const notifications: PluginNotification[] = [];
	const observers = new Set<(notification: PluginNotification) => void>();
	const events = new Set<(event: ServerEvent) => void>();
	const activationSignals: AbortSignal[] = [];
	const calls: { background: boolean; context: TranscriptContext }[] = [];
	let hostChanges = 0, agentChanges = 0;
	let releaseQuestion!: () => void;
	const questionGate = new Promise<void>(resolve => { releaseQuestion = resolve; });
	const asked = response([
		{ type: "thinking", thinking: "Fixture asks before publishing", thinkingSignature: "fixture-provider-signature" },
		{ type: "toolCall", id: "ask_fixture", name: "ask", arguments: { prompt: "Provide fixture publication text" } },
	]);
	const deps: PluginInferenceDeps = {
		catalog: () => structuredClone(catalog), providerKeyPresent: () => true,
		engineForSpec: (model, background) => ({ model: { api: "fixture", provider: model.provider, id: model.id } as never, level: "off", streamFn: (_model, context, options) => {
			const index = calls.length;
			calls.push({ background, context: structuredClone(context) });
			const stream = new AssistantMessageEventStream();
			if (index === 0) {
				void questionGate.then(() => {
					assert.equal(options?.signal?.aborted, false);
					stream.push({ type: "start", partial: asked }); stream.push({ type: "done", reason: "toolUse", message: asked }); stream.end();
				});
			} else {
				assert.equal(index, 1, "neither activation nor endRun/idempotent retries may launch another provider call");
				const answer = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "ask_fixture");
				assert(answer?.role === "toolResult");
				const body = JSON.parse((answer.content[0] as { text: string }).text) as string;
				const publish = response([{ type: "toolCall", id: "publish_fixture", name: "publish", arguments: { body } }]);
				stream.push({ type: "start", partial: publish }); stream.push({ type: "done", reason: "toolUse", message: publish }); stream.end();
			}
			return stream;
		} }),
	};
	const notify = (notification: PluginNotification) => {
		notifications.push(structuredClone(notification));
		for (const listener of [...observers]) listener(notification);
	};
	const checkpoint = (topic: string, matches: (data: unknown) => boolean = () => true): Promise<PluginNotification> => new Promise((resolve, reject) => {
		const timeout = setTimeout(() => { observers.delete(listener); reject(new Error(`Missing plugin checkpoint: ${topic}`)); }, 2500);
		const listener = (notification: PluginNotification) => {
			if (notification.topic !== topic || !matches(notification.data)) return;
			clearTimeout(timeout); observers.delete(listener); resolve(notification);
		};
		observers.add(listener);
		t.after(() => { clearTimeout(timeout); observers.delete(listener); });
	});
	const host = createPluginHost({
		directory: plugins, appVersion: "0.3.7", onChange: () => { hostChanges++; }, onNotification: notify,
		subscribeEvents(listener) { events.add(listener); return () => { events.delete(listener); }; },
		createServices({ manifest, dataDirectory: directory, signal }) {
			activationSignals.push(signal);
			const adapter = createPluginInference({ signal, dataDirectory: directory }, deps);
			const agents = createPluginAgentService({ store: createPluginAgentRecordStore(path.join(directory, "agents")), engineFor: adapter.engineFor, onUsage: adapter.onUsage, signal,
				onChange: () => { if (!signal.aborted) { agentChanges++; notify({ pluginId: manifest.id, topic: "agents-changed" }); } },
			});
			return { learning, inference: adapter.inference, agents, workers: { dispose: async () => {} } as PluginWorkerService,
				createBackgroundTool() { throw new Error("Unexpected background tool in agent integration fixture"); } };
		},
	});
	t.after(async () => { releaseQuestion(); await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
	const call = (operation: string, input?: unknown) => host.call("integration-fixture", operation, input);

	await host.initialize();
	assert.equal(host.list()[0]?.status, "disabled");
	assert.equal(activationSignals.length, 0);
	await assert.rejects(call("create"), disabled);
	await host.setEnabled("integration-fixture", true);
	assert.equal(host.list()[0]?.status, "active", host.list()[0]?.error);
	assert.deepEqual(await call("native"), { filename: fs.realpathSync(path.join(packageDirectory, "backend.cjs")), directory: fs.realpathSync(packageDirectory), identity: "native-relative-module", activations: 1, pluginId: "integration-fixture" });
	assert.deepEqual(await call("learning"), { sessions: [{ ...summaries[0], busy: false, compacting: false }], session: learningRecord, graphFormat: { version: 1 }, propositionCount: 0 });
	const learningNotice = checkpoint("learning-notice");
	for (const listener of events) listener({ type: "record-changed", chatId: "learning_fixture" });
	assert.deepEqual((await learningNotice).data, { chatId: "learning_fixture" });

	const created = await call("create") as PluginAgentSnapshot;
	assert.equal(created.definitionId, "integration-agent");
	const waitingCheckpoint = checkpoint("session-state", data => (data as { id: string; status: string }).id === created.id && (data as { status: string }).status === "waiting");
	const changeCheckpoint = checkpoint("agents-changed");
	const accepted = await call("send", { id: created.id, text: "Explicit hypothetical fixture task", requestId: "send_first" }) as PluginAgentSnapshot;
	assert.equal(accepted.status, "running", "host call returns acceptance, not model completion");
	assert.equal((await call("get", { id: created.id }) as PluginAgentSnapshot).status, "running");
	await changeCheckpoint;
	releaseQuestion();
	await waitingCheckpoint;
	const waiting = await call("get", { id: created.id }) as PluginAgentSnapshot;
	assert.equal(waiting.status, "waiting");
	assert.deepEqual(waiting.pending, [{ toolCallId: "ask_fixture", toolName: "ask", input: { prompt: "Provide fixture publication text" } }]);
	assert.equal(waiting.messages.filter(message => message.role === "toolResult").length, 0, "no synthetic input success placeholder is persisted");
	assert.deepEqual(waiting.messages.at(-1), { ...asked, thinkingLevel: "off" });
	assert.equal(calls.length, 1);
	assert.equal(fs.existsSync(path.join(dataDirectory, "publication.json")), false);
	const recordFile = path.join(dataDirectory, "agents", `${created.id}.json`);
	const persistedWaiting = fs.readFileSync(recordFile, "utf8");
	const usageFile = path.join(dataDirectory, "usage.jsonl");
	assert.equal(fs.readFileSync(usageFile, "utf8").trim().split("\n").length, 1);

	await host.setEnabled("integration-fixture", false);
	assert.equal(activationSignals[0]?.aborted, true);
	assert.equal(events.size, 0, "backend host-event listener detaches on disable");
	await assert.rejects(call("get", { id: created.id }), disabled);
	await assert.rejects(call("answer", { id: created.id, toolCallId: "ask_fixture", value: "ignored while disabled", requestId: "disabled_answer" }), disabled);
	assert.equal(fs.readFileSync(recordFile, "utf8"), persistedWaiting);
	const reattached = checkpoint("session-state", data => (data as { id: string; status: string }).id === created.id && (data as { status: string }).status === "waiting");
	await host.setEnabled("integration-fixture", true);
	await reattached;
	assert.equal(host.list()[0]?.status, "active", host.list()[0]?.error);
	assert.equal(activationSignals.length, 2);
	assert.equal((await call("native") as { activations: number }).activations, 2, "native module is cached while context activation is fresh");
	assert.equal(calls.length, 1, "reactivation must not replay inference or tools");
	assert.equal(fs.readFileSync(recordFile, "utf8"), persistedWaiting);
	assert.equal((await call("list") as PluginAgentSnapshot[]).length, 1);
	assert.deepEqual((await call("get", { id: created.id }) as PluginAgentSnapshot).pending, waiting.pending);
	await assert.rejects(call("answer", { id: created.id, toolCallId: "ask_fixture", value: 42, requestId: "invalid_answer" }), /Invalid answer/);
	assert.equal(calls.length, 1);

	const publishedCheckpoint = checkpoint("published");
	const idleCheckpoint = checkpoint("session-state", data => (data as { id: string; status: string }).id === created.id && (data as { status: string }).status === "idle");
	const answered = await call("answer", { id: created.id, toolCallId: "ask_fixture", value: "Fixture artifact body", requestId: "answer_once" }) as PluginAgentSnapshot;
	assert.equal(answered.status, "running");
	await publishedCheckpoint;
	await idleCheckpoint;
	const final = await call("get", { id: created.id }) as PluginAgentSnapshot;
	assert.equal(final.status, "idle");
	assert.deepEqual(final.pending, []);
	assert.deepEqual(final.acceptedInputs, ["send_first", "answer_once"]);
	assert.equal(final.messages.filter(message => message.role === "toolResult").length, 2);
	assert.deepEqual(fs.readdirSync(path.join(dataDirectory, "agents")), [`${created.id}.json`]);
	const artifact = { body: "Fixture artifact body", sourceTitles: [learningRecord.title] };
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDirectory, "publication.json"), "utf8")), artifact);
	assert.equal(fs.readFileSync(path.join(dataDirectory, "publications.jsonl"), "utf8"), `${JSON.stringify(artifact)}\n`);
	const rows = fs.readFileSync(usageFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { model: unknown; usage: unknown });
	assert.deepEqual(rows.map(row => row.model), [pin, pin]);
	assert.deepEqual(rows.map(row => row.usage), [usage, usage]);
	assert.deepEqual(calls.map(entry => entry.background), [true, false]);
	assert.equal(calls.length, 2, "publish endRun prevents an automatic third model call");
	const checkpointed = JSON.parse(fs.readFileSync(recordFile, "utf8")) as PluginAgentRecord;
	assert.equal(checkpointed.status, "idle");
	assert(checkpointed.messages.some(message => message.role === "toolResult" && message.toolCallId === "publish_fixture" && !message.isError));
	await call("answer", { id: created.id, toolCallId: "ask_fixture", value: "retry ignored", requestId: "answer_once" });
	await call("send", { id: created.id, text: "retry ignored", requestId: "send_first" });
	assert.equal(calls.length, 2);
	assert.equal(fs.readFileSync(path.join(dataDirectory, "publications.jsonl"), "utf8").trim().split("\n").length, 1);
	assert.equal(fs.readFileSync(learningFile, "utf8"), learningBytes, "plugin workflow never mutates learning records");
	assert.equal(fs.existsSync(path.join(dataDirectory, "chats")), false);
	assert(agentChanges > 0);
	assert(hostChanges >= 4);
	assert(notifications.every(notification => notification.pluginId === "integration-fixture"));
	await host.setEnabled("integration-fixture", false);
	await assert.rejects(call("create"), disabled);
	assert.equal(calls.length, 2);
});
