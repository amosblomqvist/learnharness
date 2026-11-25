import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { piModels } from "../src/agent/models.ts";
import { toLlmMessages } from "../src/core/native-messages.ts";
import { buildSubagentSteer } from "../src/core/contracts.ts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chatgpt-background-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "scratch-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { stores } = await import("../src/server/stores.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { deliverJobResult, registerLiveAgent, unregisterLiveAgent, setTurnRunner, settleSteers, steerLiveChat } = await import("../src/server/jobs.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
let revision = 1;
function connection(background: boolean) {
	ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: revision++ }, invalidate: background ? "none" : "background", status: { available: true, pending: false, allowBackgroundUse: background, activeId: "scratch-account", accounts: [{ id: "scratch-account", connected: true, planEnabled: true, background: !background }], error: null } });
}
const originalSend = Object.getOwnPropertyDescriptor(process, "send"), originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
before(() => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (_message: unknown, callback?: (error: Error) => void) => { callback?.(new Error("unexpected fixture desktop request")); return false; } });
});
after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
	if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
});

for (const revokedAfterQueue of [false, true]) {
	test(`mixed learner+automatic batch: foreground runs, automatic result stays owned/deferred without consent (${revokedAfterQueue ? "revoked after handoff" : "initially off"})`, { timeout: 5000 }, async () => {
		connection(revokedAfterQueue);
		const chat = stores.chatStore.createChat("Scratch mixed queue");
		stores.chatStore.saveSettings(chat.id, { model: { provider: "chatgpt", id: "gpt-5" } });
		const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "scratch-job-call" });
		const result = { brief: "Scratch completed job result", sources: [] };
		stores.jobStore.updateJob(job.id, { status: "done", result, delivery: { kind: "result", status: "pending" } });
		const marker = buildSubagentSteer(job, result);
		const contexts: string[] = [];
		const native = piModels().getModel("openai", "gpt-5")!;
		const model = { ...native, provider: "chatgpt" };
		const agent = new Agent({ initialState: { model, messages: [{ role: "user", content: "Initial scratch learner input", timestamp: 1, id: "scratch-initial" } as AgentMessage] }, convertToLlm: toLlmMessages,
			streamFn: () => {
				contexts.push(JSON.stringify(agent.state.messages));
				const stream = new AssistantMessageEventStream();
				const output = { role: "assistant" as const, provider: "chatgpt", api: model.api, model: model.id, content: [{ type: "text" as const, text: "Scratch foreground response" }], stopReason: "stop" as const, timestamp: 2, usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: "stop", message: output }); stream.end();
				return stream;
			},
		});
		let wakes = 0;
		setTurnRunner(async (chatId, input) => {
			wakes++;
			assert.equal(input.type, "steers");
			if (input.type === "steers") stores.chatStore.saveMessages(chatId, [...stores.chatStore.getChat(chatId)!.messages, ...input.steers]);
			return 200;
		});
		assert(beginTurn(chat.id));
		registerLiveAgent(chat.id, agent);
		const delivered = deliverJobResult(marker);
		const learner = { id: "scratch-live-learner", role: "user", content: "Please continue my learning", timestamp: 3 } as never;
		assert(steerLiveChat(chat.id, learner));
		if (revokedAfterQueue) connection(false);
		await agent.continue();
		assert.equal(contexts.length, 1, "ordinary foreground tool-free call remains usable");
		assert(contexts[0]!.includes("Please continue my learning"));
		assert(!contexts[0]!.includes(marker.id), "automatic marker must not enter the foreground batch");
		assert(!agent.hasQueuedMessages());
		// Ordinary lease/catalog replies are not consent changes and must never
		// reset/replay a learner steer that the agent has already consumed.
		ipc({ channel: "lh:chatgpt", id: "ordinary-reply-with-no-pending-call", value: { accessToken: "scratch-only" } });
		assert(!agent.hasQueuedMessages());
		const persisted = persistTurn(stores.chatStore, chat.id, 0, agent.state.messages, false);
		unregisterLiveAgent(chat.id); endTurn(chat.id); settleSteers(chat.id, persisted);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(wakes, 0, "no background spin or spend while consent is absent");
		assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "pending", "delivery ownership must not be finalized or failed by deferral");
		assert.equal(stores.jobStore.getJob(job.id)!.status, "done", "worker completion is independent of consent deferral");
		assert.deepEqual(stores.jobStore.getJob(job.id)!.result, result);
		connection(true);
		await delivered;
		assert.equal(wakes, 1, "explicit consent resumes the preserved result exactly once");
		assert.equal(stores.jobStore.getJob(job.id)!.status, "done");
	});
}
