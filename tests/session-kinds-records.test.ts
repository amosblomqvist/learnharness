// Session/record kinds — stage C (owner principles C1–C4 confirmed
// 2026-11-19): what the UI needs from the host — kind/record summaries,
// record views, the per-record extraction switch, and purge on deletion.
// Runs offline against an isolated data directory with the stage-B fixture.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { PluginBackendContext, PluginFrontendContext, PluginInfo } from "../src/core/plugins.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-records-"));
const data = path.join(root, "data");
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Unexpected external network"); };
const PLUGIN = "kinds-fixture", LESSON = "kinds-fixture:lesson", GRAPH_LESSON = "kinds-fixture:graph-lesson", NOTEBOOK = "kinds-fixture:notebook";
fs.cpSync(path.resolve("tests/fixtures/session-kinds-plugin"), path.join(data, "plugins", PLUGIN, "dist"), { recursive: true });

const { getPluginHost } = await import("../src/server/plugins.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { resolveChatRecord } = await import("../src/server/record-kinds.ts");
const { runRecordExtraction } = await import("../src/server/record-extraction.ts");
const { sessionCoverage, deleteChatSession } = await import("../src/server/chats.ts");
const { preparePluginRecordKind, preparePluginSessionKind } = await import("../src/core/plugin-session-kinds.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { recordExtractionEnabled } = await import("../src/core/settings-resolution.ts");
const { parseRecordsSettingsBody } = await import("../src/server/settings-body.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { PUT: putSettingsSection } = await import("../app/api/settings/[section]/route.ts");
const { POST: extractRoute } = await import("../app/api/graph/coverage/extract/route.ts");
const { DELETE: deleteChatRoute } = await import("../app/api/chats/[id]/route.ts");
const { PluginFrontendManager } = await import("../components/plugin-manager.ts");
const { kindCatalog, kindsForRecord, recordOfKind, sessionFilters, matchesSessionFilter } = await import("../components/session-kind-catalog.ts");

const host = await getPluginHost();
await host.setEnabled(PLUGIN, true);
type Control = { fail: boolean; gate?: (batch: { chatId: string }) => Promise<void>; purgeGate?: (chatId: string) => Promise<void>; purgeFail: boolean; purged: string[] };
const control = async () => await host.call(PLUGIN, "control") as Control;
const context = async () => await host.call(PLUGIN, "context") as PluginBackendContext;
const notebook = async () => await host.call(PLUGIN, "notebook") as Array<{ chatId: string }>;
after(async () => { await host.dispose(); globalThis.fetch = realFetch; fs.rmSync(root, { recursive: true, force: true }); });

const assistant = (id: string, text: string) => ({ ...fauxAssistantMessage(text), id }) as unknown as LhMessage;
const user = (id: string, text: string) => ({ ...newUserMessage(text), id }) as LhMessage;
function lessonChat(title: string, kind = LESSON) {
	const chat = chatStore.createChat(title, kind as `${string}:${string}`);
	chatStore.saveMessages(chat.id, [user(`${chat.id}-u1`, "teach me ".repeat(100)), assistant(`${chat.id}-a1`, "lesson text ".repeat(75))]);
	return chatStore.getChat(chat.id)!;
}
async function extracted(title: string) {
	const chat = lessonChat(title);
	const target = await resolveChatRecord(chat.kind);
	if (target.status !== "plugin") throw Error("expected plugin record");
	assert.equal((await runRecordExtraction({ chatStore }, chat.id, target, "manual")).status, "done");
	return { chat, coverageFile: path.join((await context()).dataDirectory, "records", "notebook", "coverage.jsonl") };
}
const putRecords = (body: unknown) => putSettingsSection(new Request("http://x/api/settings/records", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ section: "records" }) });
const extract = (chatId: string) => extractRoute(new Request("http://x/api/graph/coverage/extract", { method: "POST", body: JSON.stringify({ chatId }) }));
const del = (chatId: string, mode: string) => deleteChatRoute(new Request(`http://x/api/chats/${chatId}?mode=${mode}`, { method: "DELETE" }), { params: Promise.resolve({ id: chatId }) });

describe("C1 — summaries carry what the chrome needs; record views are owner-scoped", () => {
	it("validates icon and purge, and lists record/icon/chunkTokens/purge", () => {
		assert.throws(() => preparePluginSessionKind(PLUGIN, { id: "ok", label: "x", record: "graph", prompts: { prober: "a", teacher: "b" }, icon: " " }), /icon/);
		assert.throws(() => preparePluginRecordKind(PLUGIN, { id: "ok", label: "x", extract() {}, purge: "no" as never }), /purge/);
		const info = host.list().find((plugin) => plugin.id === PLUGIN)!;
		const lesson = info.sessionKinds!.find((kind) => kind.id === LESSON)!;
		assert.equal(lesson.record, NOTEBOOK);
		assert.match(lesson.icon ?? "", /data-fixture-icon="lesson"/);
		assert.equal(info.sessionKinds!.find((kind) => kind.id === GRAPH_LESSON)!.icon, undefined);
		assert.deepEqual(info.recordKinds, [{ id: NOTEBOOK, label: "Fixture notebook", chunkTokens: 500, purge: true }]);
	});

	it("registerRecordView namespaces under the registering plugin, rejects bad or duplicate ids, and expires with activation", async () => {
		const info = (id: string): PluginInfo => ({ id, origin: "community", enabled: true, status: "active", revision: "1", manifest: { apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", main: "index.js" } });
		const contexts: PluginFrontendContext[] = [];
		const manager = new PluginFrontendManager({ fetch: async () => Response.json({}), pathname: () => "/", navigate() {}, async importModule() { return { activate(ctx) {
			contexts.push(ctx);
			ctx.registerRecordView({ recordKind: "notebook", mount() {} });
		} }; } });
		try {
			manager.reconcile([info("one"), info("two")]); await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(manager.getSnapshot().recordViews!.map((view) => view.recordKindId), ["one:notebook", "two:notebook"]);
			assert.throws(() => contexts[0]!.registerRecordView({ recordKind: "notebook", mount() {} }), /Duplicate/);
			assert.throws(() => contexts[0]!.registerRecordView({ recordKind: "two:notebook", mount() {} }), /recordKind/);
			assert.throws(() => contexts[0]!.registerRecordView({ recordKind: "other" } as never), /mount/);
			manager.reconcile([info("two")]);
			assert.deepEqual(manager.getSnapshot().recordViews!.map((view) => view.recordKindId), ["two:notebook"]);
		} finally { manager.dispose(); }
	});
});

describe("C2/C3 — the client catalog", () => {
	const plugin = (id: string, extra: Partial<PluginInfo>) => ({ info: { id, origin: "community" as const, enabled: true, status: "active" as const, revision: "1", manifest: { apiVersion: 1 as const, id, name: `${id} name`, version: "1.0.0", minAppVersion: "0.4.1" }, ...extra } }) as never;
	const snapshot = {
		plugins: [
			plugin("lang", { sessionKinds: [{ id: "lang:lesson", label: "Lesson", record: "lang:vocab", icon: "<svg/>" }, { id: "lang:review", label: "Review", record: "graph" }], recordKinds: [{ id: "lang:vocab", label: "Vocabulary", chunkTokens: 800, purge: true }, { id: "lang:hidden", label: "No view", chunkTokens: 800, purge: false }] }),
			plugin("off", { enabled: false, status: "disabled", sessionKinds: [{ id: "off:x", label: "X", record: "graph" }] }),
		],
		recordViews: [{ pluginId: "lang", recordKindId: "lang:vocab", mount() {} }, { pluginId: "ghost", recordKindId: "ghost:r", mount() {} }],
	};
	const catalog = kindCatalog(snapshot);

	it("home shows the graph plus plugin records that have a view; graph alone means no switcher", () => {
		assert.deepEqual(catalog.homeRecords.map((record) => record.id), ["graph", "lang:vocab"]);
		assert.deepEqual(kindCatalog({ plugins: [], recordViews: [] }).homeRecords.map((record) => record.id), ["graph"]);
	});

	it("the mode switch lists the kinds writing into the shown record", () => {
		assert.deepEqual(kindsForRecord(catalog, "graph").map((kind) => kind.id), ["teach", "practice", "lang:review"]);
		assert.deepEqual(kindsForRecord(catalog, "lang:vocab").map((kind) => kind.id), ["lang:lesson"]);
	});

	it("resolves a chat's record client-side and lists filter segments for active kinds only", () => {
		assert.deepEqual(recordOfKind(catalog, undefined), { status: "graph" });
		assert.deepEqual(recordOfKind(catalog, "practice"), { status: "none" });
		assert.deepEqual(recordOfKind(catalog, "lang:review"), { status: "graph" });
		assert.equal(recordOfKind(catalog, "lang:lesson").status, "plugin");
		assert.equal(recordOfKind(catalog, "off:x").status, "unavailable");
		assert.deepEqual(sessionFilters(catalog), ["teach", "practice", "lang:lesson", "lang:review", "all"]);
		assert.equal(matchesSessionFilter(undefined, "teach"), true);
		assert.equal(matchesSessionFilter("off:x", "all"), true);
		assert.equal(matchesSessionFilter("off:x", "teach"), false);
	});
});

describe("C4 — the record's host-owned extraction switch", () => {
	it("settings: sanitizer keeps only plugin record ids with boolean switches; PUT is strict; absent = on", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, records: { [NOTEBOOK]: { extraction: false }, graph: { extraction: false }, "a:b": { extraction: "no" } } })!.records, { [NOTEBOOK]: { extraction: false }, "a:b": {} });
		assert.equal(parseRecordsSettingsBody({ graph: { extraction: false } }).ok, false);
		assert.equal(parseRecordsSettingsBody({ [NOTEBOOK]: { extraction: 1 } }).ok, false);
		assert.deepEqual(parseRecordsSettingsBody({ [NOTEBOOK]: { extraction: false } }), { ok: true, settings: { [NOTEBOOK]: { extraction: false } } });
		assert.equal(recordExtractionEnabled(null, NOTEBOOK), true);
		assert.equal(recordExtractionEnabled({ records: { [NOTEBOOK]: {} } }, NOTEBOOK), true);
		assert.equal(recordExtractionEnabled({ records: { [NOTEBOOK]: { extraction: false } } }, NOTEBOOK), false);
	});

	it("off: coverage reports it and manual extract refuses; on again: extract starts", async () => {
		const chat = lessonChat("Switch");
		assert.equal((await putRecords({ [NOTEBOOK]: { extraction: false } })).status, 200);
		try {
			assert.equal((await sessionCoverage(chat.id))!.record!.extraction, false);
			const refused = await extract(chat.id);
			assert.equal(refused.status, 409);
			assert.equal((await refused.json()).code, "record-extraction-disabled");
		} finally {
			assert.equal((await putRecords({})).status, 200);
		}
		assert.equal((await sessionCoverage(chat.id))!.record!.extraction, true);
		assert.equal((await extract(chat.id)).status, 202);
	});
});

describe("C4 — host serialization per record (q92)", () => {
	it("queues purge and extraction in order across sessions, without blocking another record", { timeout: 5000 }, async () => {
		const state = await control();
		const ctx = await context();
		const offRecord = ctx.registerRecordKind({ id: "other", label: "Other", extract() {} });
		const offKind = ctx.registerSessionKind({ id: "other-lesson", label: "Other lesson", record: `${PLUGIN}:other`, prompts: { prober: "a", teacher: "b" } });
		const first = lessonChat("First extraction");
		const remove = lessonChat("Purged during extraction");
		const next = lessonChat("Next extraction");
		const other = lessonChat("Other record", `${PLUGIN}:other-lesson`);
		const target = await resolveChatRecord(first.kind);
		const otherTarget = await resolveChatRecord(other.kind);
		if (target.status !== "plugin" || otherTarget.status !== "plugin") throw Error("expected plugin records");
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const purgeEntered = Promise.withResolvers<void>();
		const releasePurge = Promise.withResolvers<void>();
		let nextStarted = false;
		let purgeStarted = false;
		state.gate = async ({ chatId }) => {
			if (chatId === first.id) { firstEntered.resolve(); await releaseFirst.promise; }
			if (chatId === next.id) nextStarted = true;
		};
		state.purgeGate = async () => { purgeStarted = true; purgeEntered.resolve(); await releasePurge.promise; };
		const tasks: Promise<unknown>[] = [];
		try {
			const extracting = runRecordExtraction({ chatStore }, first.id, target, "manual");
			tasks.push(extracting);
			await firstEntered.promise;
			const deleting = del(remove.id, "purge");
			tasks.push(deleting);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(purgeStarted, false, "purge must wait for an active extract on the same record");
			releaseFirst.resolve();
			await purgeEntered.promise;
			const queued = runRecordExtraction({ chatStore }, next.id, target, "manual");
			tasks.push(queued);
			assert.equal((await runRecordExtraction({ chatStore }, other.id, otherTarget, "manual")).status, "done");
			assert.equal(nextStarted, false, "extract must wait for an active purge on the same record");
			releasePurge.resolve();
			assert.equal((await deleting).status, 200);
			assert.equal((await queued).status, "done");
			assert.equal((await extracting).status, "done");
			assert.equal(nextStarted, true);
		} finally {
			releaseFirst.resolve();
			releasePurge.resolve();
			await Promise.allSettled(tasks);
			delete state.gate;
			delete state.purgeGate;
			offKind(); offRecord();
		}
	});
});

describe("C4 — purge on deletion (owner q52)", () => {
	it("the route takes preserve|purge and refuses the old graph-named modes", async () => {
		const chat = lessonChat("Bad mode");
		const res = await del(chat.id, "delete-nodes");
		assert.equal(res.status, 400);
		assert.ok(chatStore.getChat(chat.id));
	});

	it("purge asks the plugin record to remove the session's traces, then deletes", async () => {
		const { chat, coverageFile } = await extracted("Purge me");
		assert.ok((await notebook()).some((row) => row.chatId === chat.id));
		const res = await del(chat.id, "purge");
		assert.equal(res.status, 200);
		assert.ok((await control()).purged.includes(chat.id));
		assert.ok(!(await notebook()).some((row) => row.chatId === chat.id), "the plugin removed its rows");
		assert.ok(!fs.readFileSync(coverageFile, "utf8").includes(chat.id), "host coverage rows removed");
		assert.equal(chatStore.getChat(chat.id), null);
	});

	it("preserve never calls purge", async () => {
		const { chat } = await extracted("Keep traces");
		assert.equal((await del(chat.id, "preserve")).status, 200);
		assert.ok(!(await control()).purged.includes(chat.id));
		assert.ok((await notebook()).some((row) => row.chatId === chat.id), "record data kept");
	});

	it("a failing purge refuses the deletion and keeps the session and its coverage", async () => {
		const { chat, coverageFile } = await extracted("Purge fails");
		(await control()).purgeFail = true;
		try {
			const res = await del(chat.id, "purge");
			assert.equal(res.status, 500);
			assert.equal((await res.json()).code, "purge_failed");
			assert.ok(chatStore.getChat(chat.id));
			assert.ok(fs.readFileSync(coverageFile, "utf8").includes(chat.id));
		} finally { (await control()).purgeFail = false; }
		assert.equal((await del(chat.id, "purge")).status, 200, "retry succeeds");
	});

	it("an unavailable record refuses purge but plain deletion still works", async () => {
		const { chat } = await extracted("Disabled purge");
		await host.setEnabled(PLUGIN, false);
		try {
			const res = await del(chat.id, "purge");
			assert.equal(res.status, 409);
			assert.equal((await res.json()).code, "record-kind-unavailable");
			assert.ok(chatStore.getChat(chat.id));
			assert.equal((await del(chat.id, "preserve")).status, 200);
		} finally { await host.setEnabled(PLUGIN, true); }
	});

	it("a record without purge refuses purge; a kind naming the graph purges graph traces as before", async () => {
		const ctx = await context();
		const offRecord = ctx.registerRecordKind({ id: "plain", label: "Plain", extract() {} });
		const offKind = ctx.registerSessionKind({ id: "plain-lesson", label: "Plain lesson", record: `${PLUGIN}:plain`, prompts: { prober: "a", teacher: "b" } });
		try {
			const chat = lessonChat("No purge", `${PLUGIN}:plain-lesson`);
			const res = await del(chat.id, "purge");
			assert.equal(res.status, 409);
			assert.equal((await res.json()).code, "purge-unsupported");
			assert.equal((await del(chat.id, "preserve")).status, 200);
		} finally { offKind(); offRecord(); }
		const graphChat = lessonChat("Graph purge", GRAPH_LESSON);
		const before = (await control()).purged.length;
		const res = await deleteChatSession(graphChat.id, "purge");
		assert.equal(res.ok, true);
		assert.equal((await control()).purged.length, before, "graph records never reach a plugin purge");
	});
});
