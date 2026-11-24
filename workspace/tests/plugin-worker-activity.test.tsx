import React, { act } from "react";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { Type } from "typebox";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PluginWorkerActivityMetadata } from "../src/agent/plugin-workers.ts";

// Isolate every application import, including catalog/auth lookups, from real data/accounts.
const directory = mkdtempSync(join(tmpdir(), "lh-worker-activity-"));
process.env.LH_DATA_DIR = join(directory, "data");
process.env.LH_AUTH_FILE = join(directory, "auth.json");
process.env.HOME = join(directory, "home");
process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
mkdirSync(process.env.HOME, { recursive: true });
writeFileSync(process.env.LH_AUTH_FILE, "{}");
(globalThis as Record<string, unknown>).React = React;
after(() => rmSync(directory, { recursive: true, force: true }));

const { createPluginWorkerService } = await import("../src/agent/plugin-workers.ts");
const { createPluginTaskRecordStore } = await import("../src/store/plugin-task-records.ts");
const { registerPluginWorkerActivity, pluginWorkerActivities, abortPluginWorkerActivity } = await import("../src/server/plugin-worker-activity.ts");
const { activityFeed } = await import("../src/server/observability.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { subscribe } = await import("../src/core/events.ts");
const { ActivityProvider, ActivitySection, toBlobs } = await import("../components/activity-dock.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { POST } = await import("../app/api/activity/abort/route.ts");
const pin = { provider: "offline-fixture", id: "held" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const metadata = (extra: Partial<PluginWorkerActivityMetadata> = {}): PluginWorkerActivityMetadata => ({
	id: "task", definitionId: "registered-worker", status: "queued", model: pin,
	createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...extra,
});
function fixture(t: TestContext, pluginId = "panel-fixture") {
	const activation = new AbortController();
	const store = createPluginTaskRecordStore(join(directory, pluginId, "tasks"));
	const observed: PluginWorkerActivityMetadata[] = [];
	const onChange = registerPluginWorkerActivity({ pluginId, pluginName: "Panel fixture", signal: activation.signal, cancel: id => service.cancel(id) });
	let lists = 0;
	const list = store.list.bind(store); store.list = () => { lists++; return list(); };
	const service = createPluginWorkerService({ store, signal: activation.signal,
		engineFor: () => new Promise(() => {}),
		onChange: value => { observed.push(value); onChange(value); },
	});
	service.register({ id: "registered-worker", instructions: "private instructions", resultSchema: Type.String() });
	t.after(async () => { activation.abort(); await service.dispose(); });
	const start = (requestId = "request") => service.start("registered-worker", { requestId,
		input: { privateInput: true }, prompt: "private prompt", model: pin, purpose: "user", maxTurns: 2 });
	return { service, store, activation, start, observed, lists: () => lists };
}

test("queued and running standalone tasks are live metadata-only rows; END removes only its task", async t => {
	const f = fixture(t);
	let announcements = 0;
	const unsubscribe = subscribe(event => { if (event.type === "activity-changed") announcements++; }); t.after(unsubscribe);
	const task = f.start();
	let feed = activityFeed();
	assert.equal(feed.pluginWorkers.length, 1);
	assert.equal(feed.pluginWorkers[0]?.status, "queued");
	assert.equal(feed.pluginWorkers[0]?.title, "Panel fixture · registered-worker");
	assert.equal(feed.pluginWorkers[0]?.id, `panel-fixture:${task.id}`);
	assert.equal(feed.pluginWorkers[0]?.costUsd, null);
	assert.equal(feed.pluginWorkers[0]?.contextLimit, null);
	assert.doesNotMatch(JSON.stringify(feed.pluginWorkers), /private prompt|privateInput|instructions|messages|partial|result|chatId/);
	assert.deepEqual(Object.keys(f.observed[0]!).sort(), ["activity", "createdAt", "definitionId", "id", "model", "status", "updatedAt", "usage"].sort());
	f.observed[0]!.model.id = "mutated observer clone";
	assert.equal(f.service.get(task.id).model.id, pin.id);
	await tick();
	feed = activityFeed();
	assert.equal(feed.pluginWorkers[0]?.status, "running");
	assert.equal(feed.pluginWorkers[0]?.activity, "starting");
	assert.equal(f.lists(), 1, "only initial recovery lists stored tasks, not activity updates");
	const other = f.start("other");
	assert.equal(abortPluginWorkerActivity(`panel-fixture:${task.id}`), true);
	assert.equal(f.service.get(task.id).status, "cancelled");
	assert.equal(f.service.get(other.id).status, "queued");
	assert.deepEqual(activityFeed().pluginWorkers.map(row => row.taskId), [other.id]);
	assert.equal(abortPluginWorkerActivity(`panel-fixture:${task.id}`), false);
	assert(announcements >= 4, "acceptance, execution, and completion announce existing activity event");
});

test("streaming deltas do not rescan tasks, clone transcripts, or publish partial text as activity", async t => {
	const activation = new AbortController();
	const store = createPluginTaskRecordStore(join(directory, "stream-fixture", "tasks"));
	let lists = 0; const originalList = store.list.bind(store); store.list = () => { lists++; return originalList(); };
	const changes: PluginWorkerActivityMetadata[] = [];
	const base: AssistantMessage = { role: "assistant", provider: pin.provider, model: pin.id, api: "fixture" as never,
		content: [{ type: "text", text: "" }], stopReason: "stop", timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const service = createPluginWorkerService({ store, signal: activation.signal, onChange: value => changes.push(value),
		engineFor: () => ({ model: { api: "fixture", provider: pin.provider, id: pin.id } as never,
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "start", partial: base });
				for (let i = 0; i < 2000; i++) stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: {
					...base, content: [{ type: "text", text: "x".repeat(i + 1) }],
				} });
				options?.signal?.addEventListener("abort", () => {
					const aborted = { ...base, stopReason: "aborted" as const };
					stream.push({ type: "error", reason: "aborted", error: aborted }); stream.end(aborted);
				}, { once: true });
				return stream;
			} }),
	});
	t.after(async () => { activation.abort(); await service.dispose(); });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	service.register({ id: "streamer", instructions: "private instructions", resultSchema: Type.String() });
	const task = service.start("streamer", { requestId: "stream", input: null, prompt: "private prompt", model: pin, purpose: "user", maxTurns: 1 });
	await tick();
	const before = changes.length;
	assert.equal((service.get(task.id).partial?.content[0] as { text: string }).text.length, 2000);
	const originalClone = globalThis.structuredClone;
	let transcriptClones = 0;
	t.mock.method(globalThis, "structuredClone", ((value: unknown) => {
		if (value && typeof value === "object" && ("messages" in value || "partial" in value)) transcriptClones++;
		return originalClone(value);
	}) as typeof structuredClone);
	t.mock.timers.tick(100); await tick();
	assert.equal(changes.length, before, "unchanged metadata is not republished on partial flush");
	assert.equal(transcriptClones, 0, "no subscribed view means no full-transcript cloning per delta/flush");
	assert.equal(lists, 1, "only bootstrap recovery lists task history");
	assert.doesNotMatch(JSON.stringify(changes), /private prompt|partial|messages|xxxxx/);
	service.cancel(task.id); await tick();
});

test("native host-job linkage deduplicates plugin+task through acceptance and running; core jobs unaffected", async t => {
	const f = fixture(t, "linked-fixture");
	const task = f.start();
	assert.equal(activityFeed().pluginWorkers.length, 1);
	const chat = chatStore.createChat("linked fixture chat");
	const job = jobStore.createJob({ kind: "plugin", chatId: chat.id, toolCallId: "linked-call", plugin: {
		pluginId: "linked-fixture", taskId: task.id, workerId: "registered-worker", toolName: "fixture_tool", requestId: "request",
	} });
	const core = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "core-call" });
	let feed = activityFeed();
	assert.equal(feed.pluginWorkers.length, 0, "no duplicate while worker is still queued");
	assert.deepEqual(feed.jobs.map(row => row.id).sort(), [core.id, job.id].sort());
	await tick();
	assert.equal(activityFeed().pluginWorkers.length, 0, "no duplicate after queued→running");
	const otherActivation = new AbortController(); t.after(() => otherActivation.abort());
	registerPluginWorkerActivity({ pluginId: "different-plugin", pluginName: "Other", signal: otherActivation.signal, cancel() {} })(metadata({ id: task.id }));
	feed = activityFeed();
	assert.equal(feed.pluginWorkers.length, 1, "dedup includes plugin identity, not just task UUID");
	const blobs = toBlobs(feed);
	assert.equal(blobs.find(row => row.id === job.id)?.process, "job", "linked END retains native abortJob route");
	assert.equal(blobs.find(row => row.id === core.id)?.process, "job");
	jobStore.updateJob(job.id, { status: "done" }); jobStore.updateJob(core.id, { status: "done" });
});

test("disable interrupts unfinished work and removes rows/abort bindings; restart cannot replay it", async t => {
	const f = fixture(t, "disable-fixture"); const task = f.start(); await tick();
	f.activation.abort();
	assert.equal(f.store.get(task.id)?.status, "interrupted");
	assert.equal(activityFeed().pluginWorkers.length, 0);
	assert.equal(abortPluginWorkerActivity(`disable-fixture:${task.id}`), false);
	let engines = 0;
	const restart = createPluginWorkerService({ store: f.store, engineFor: () => { engines++; throw new Error("must not replay"); } });
	t.after(() => restart.dispose());
	assert.equal(restart.get(task.id).status, "interrupted");
	await tick(); assert.equal(engines, 0);
});

test("replacement activation owns shared registry across module entries; stale cleanup/callback cannot remove it", async () => {
	const first = new AbortController(); const next = new AbortController();
	const calls: string[] = [];
	const old = registerPluginWorkerActivity({ pluginId: "generation", pluginName: "Old", signal: first.signal, cancel: id => calls.push(`old:${id}`) });
	old(metadata());
	const duplicatePath = "../src/server/plugin-worker-activity.ts?duplicate=fixture";
	const duplicateModule = await import(duplicatePath);
	const fresh = duplicateModule.registerPluginWorkerActivity({ pluginId: "generation", pluginName: "New", signal: next.signal, cancel: (id: string) => calls.push(`new:${id}`) });
	try {
		fresh(metadata()); first.abort(); old(metadata({ status: "succeeded" }));
		assert.equal(pluginWorkerActivities()[0]?.title, "New · registered-worker");
		assert.equal(abortPluginWorkerActivity("generation:task"), true);
		assert.deepEqual(calls, ["new:task"]);
	} finally { first.abort(); next.abort(); }
	assert.equal(abortPluginWorkerActivity("generation:task"), false);
});

test("cancel/storage failures propagate rather than pretending a task is absent", () => {
	const signal = new AbortController();
	const changed = registerPluginWorkerActivity({ pluginId: "failure", pluginName: "Failure", signal: signal.signal, cancel() { throw new Error("storage failed"); } });
	try { changed(metadata()); assert.throws(() => abortPluginWorkerActivity("failure:task"), /storage failed/); }
	finally { signal.abort(); }
});

test("abort route validates namespaced END, handles completed tasks as 404, and leaves native durable job abort intact", async t => {
	const f = fixture(t, "route-fixture"); const task = f.start();
	const post = (kind: string, id: string) => POST(new Request("http://fixture/api/activity/abort", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id }),
	}));
	assert.equal((await post("plugin-worker", "../invalid")).status, 400);
	assert.equal((await post("unknown", "x")).status, 400);
	assert.equal((await post("plugin-worker", `route-fixture:${task.id}`)).status, 200);
	assert.equal(f.service.get(task.id).status, "cancelled");
	assert.equal((await post("plugin-worker", `route-fixture:${task.id}`)).status, 404);
	// No conversation exists: durable abort bookkeeping is tested without starting any teacher/provider.
	const job = jobStore.createJob({ kind: "plugin", chatId: "route-fixture-no-chat", toolCallId: "route-linked", plugin: {
		pluginId: "route-fixture", taskId: task.id, workerId: "registered-worker", toolName: "fixture_tool", requestId: "request",
	} });
	assert.equal((await post("job", job.id)).status, 200);
	assert.equal(jobStore.getJob(job.id)?.status, "error");
	assert.deepEqual(jobStore.getJob(job.id)?.delivery, { kind: "abort", status: "pending" });
	assert.equal((await post("job", job.id)).status, 409);
	assert.equal((await post("job", "absent-job")).status, 404);
});

test("successful completion drops rows; usage/model remain metadata and registry reads never announce", () => {
	const activation = new AbortController();
	const changed = registerPluginWorkerActivity({ pluginId: "usage", pluginName: "Usage", signal: activation.signal, cancel() {} });
	let events = 0; const off = subscribe(event => { if (event.type === "activity-changed") events++; });
	try {
		changed(metadata({ status: "running", usage: { model: "offline-fixture:held", steps: 1,
			inputTokens: 100, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: undefined,
			lastStep: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: undefined },
		} }));
		const feed = activityFeed(); const beforeReads = events;
		assert.equal(feed.pluginWorkers[0]?.usage?.steps, 1);
		feed.pluginWorkers[0]!.model.id = "mutated feed";
		assert.equal(activityFeed().pluginWorkers[0]?.model.id, pin.id);
		assert.equal(events, beforeReads);
		changed(metadata({ status: "succeeded" }));
		assert.deepEqual(activityFeed().pluginWorkers, []);
	} finally { off(); activation.abort(); }
});

test("native row displays standalone metadata, has no session link, and END uses task namespace; closing view leaves work alive", async t => {
	const f = fixture(t, "view-fixture"); const task = f.start(); await tick();
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const oldFetch = globalThis.fetch;
	const calls: { url: string; body: unknown }[] = [];
	globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }); return Response.json({ ok: true }); };
	const root = createRoot(document.querySelector("#root")!);
	try {
		await act(async () => { root.render(<ActivitySection feed={activityFeed()} />); });
		assert.match(document.body.textContent!, /Panel fixture · registered-worker/);
		const detail = document.querySelector("button[aria-expanded]")!;
		await act(async () => { detail.dispatchEvent(new window.Event("click", { bubbles: true })); });
		assert.equal(document.querySelector("a[href^='/chat/']"), null);
		assert.match(document.body.textContent!, /offline-fixture:held/);
		assert.match(document.body.textContent!, /Context—/);
		await act(async () => { document.querySelector("[data-testid='activity-abort']")!.dispatchEvent(new window.Event("click", { bubbles: true })); });
		assert.deepEqual(calls, [{ url: "/api/activity/abort", body: { kind: "plugin-worker", id: `view-fixture:${task.id}` } }]);
	} finally {
		await act(async () => root.unmount()); globalThis.fetch = oldFetch;
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
	assert.equal(f.service.get(task.id).status, "running", "unmounting view never disposes the worker");
});

test("ActivityProvider refreshes worker rows from activity-changed without polling", async t => {
	const f = fixture(t, "push-fixture"); const task = f.start(); await tick();
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const oldFetch = globalThis.fetch;
	let fetches = 0;
	globalThis.fetch = async () => { fetches++; return Response.json(activityFeed()); };
	const frames = new Map<string, (data: string) => void>();
	const connect = () => ({ close() {}, onOpen() {}, onEvent(name: string, callback: (data: string) => void) { frames.set(name, callback); } });
	const forward = subscribe(event => { if (event.type === "activity-changed") frames.get(event.type)?.("{}"); });
	const root = createRoot(document.querySelector("#root")!);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		await act(async () => { root.render(<ServerEventsProvider connect={connect}><ActivityProvider><ActivitySection /></ActivityProvider></ServerEventsProvider>); });
		assert.equal(fetches, 1);
		assert(document.querySelector("[data-testid='activity-blob-plugin-worker']"));
		await act(async () => { t.mock.timers.tick(10_000); });
		assert.equal(fetches, 1, "no standing activity poll");
		await act(async () => { f.service.cancel(task.id); t.mock.timers.tick(250); });
		assert.equal(fetches, 2, "worker event schedules the existing refresh");
		assert.equal(document.querySelector("[data-testid='activity-blob-plugin-worker']"), null);
	} finally {
		forward(); await act(async () => root.unmount()); t.mock.timers.reset(); globalThis.fetch = oldFetch;
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
