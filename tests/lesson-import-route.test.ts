import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-import-route-"));
assert.equal(process.env.NODE_ENV, "test", "Continuation tests require NODE_ENV=test and offline engines");
process.env.LH_DATA_DIR = root; process.env.LH_AUTH_FILE = path.join(root, "unused-auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
let POST: (req: Request) => Promise<Response>, GET: (req: Request) => Promise<Response>;
let beginTurn: (id: string) => boolean, endTurn: (id: string) => void;
let bytes: Uint8Array;
const originalFetch = globalThis.fetch; let network = 0;
before(async () => {
	globalThis.fetch = async () => { network++; throw new Error("Network forbidden in import test"); };
	({ POST, GET } = await import("../app/api/lesson-import/route.ts"));
	({ beginTurn, endTurn } = await import("../src/server/turn-liveness.ts"));
	const source = fs.mkdtempSync(path.join(root, "synthetic-export-"));
	fs.mkdirSync(path.join(source, "chats"));
	fs.writeFileSync(path.join(source, "chats/chat_import.json"), JSON.stringify({ version: 1, id: "chat_import", title: "Authored offline route test", createdAt: "2026-01-01", updatedAt: "2026-01-01", settings: { model: { provider: "foreign_billing", id: "foreign_model" } }, messages: [{ id: "u", role: "user", content: "Synthetic", timestamp: 1 }] }));
	const { previewExport, downloadExport } = await import("../src/store/lesson-export.ts");
	bytes = downloadExport(source, ["chat_import"], "zip", { revision: previewExport(source, ["chat_import"]).revision, files: [], allowIncomplete: true }).bytes;
});
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
function request(action: string, extras: Record<string, string> = {}, origin = "http://localhost") {
	const form = new FormData(); form.set("action", action); form.set("file", new File([bytes as BlobPart], "synthetic.zip"));
	for (const [k, v] of Object.entries(extras)) form.set(k, v);
	return new Request("http://localhost/api/lesson-import", { method: "POST", headers: { Origin: origin }, body: form });
}
test("route rejects cross-origin, wrong content, oversized uploads, missing consent and live writers", async () => {
	assert.equal((await POST(request("preview", {}, "https://foreign.invalid"))).status, 403);
	assert.equal((await POST(new Request("http://localhost/api/lesson-import", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))).status, 415);
	assert.equal((await POST(new Request("http://localhost/api/lesson-import", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=test" }, body: new Uint8Array(32 * 1024 * 1024 + 65_537) }))).status, 400);
	assert.equal((await POST(request("install"))).status, 400);
	assert.equal(beginTurn("chat_import"), true);
	try { assert.equal((await POST(request("preview"))).status, 409); } finally { endTurn("chat_import"); }
	assert.equal(fs.existsSync(path.join(root, "chats/chat_import.json")), false); assert.equal(network, 0);
});
test("route accepts one native JSON lesson without graph or provider access", async () => {
	const raw = JSON.stringify({ version: 1, id: "chat_json", title: "Authored JSON", createdAt: "2026-01-01", updatedAt: "2026-01-01", messages: [] });
	function jsonRequest(action: string, revision = "") {
		const form = new FormData(); form.set("file", new File([raw], "lesson.json")); form.set("action", action);
		form.set("revision", revision); form.set("choices", "{}"); form.set("acknowledged", "true");
		return new Request("http://localhost/api/lesson-import", { method: "POST", body: form });
	}
	const p = await POST(jsonRequest("preview")); assert.equal(p.status, 200);
	const preview = await p.json(); assert.equal(preview.nodes, 0); assert.equal(preview.chains, 0);
	assert.equal((await POST(jsonRequest("install", preview.revision))).status, 200);
	assert.equal(fs.readFileSync(path.join(root, "chats/chat_json.json"), "utf8"), raw);
	assert.equal(network, 0);
});
test("real route imports without generation, then continues with the local model on explicit input", async () => {
	const p = await POST(request("preview")); assert.equal(p.status, 200); assert.equal(p.headers.get("cache-control"), "no-store");
	const preview = await p.json() as { revision: string };
	assert.equal((await POST(request("install", { revision: "stale", choices: "{}", acknowledged: "true" }))).status, 400);
	assert.equal((await POST(request("install", { revision: preview.revision, choices: "{}", acknowledged: "true" }))).status, 200);
	const active = fs.readFileSync(path.join(root, "chats/chat_import.json"));
	const list = await GET(new Request("http://localhost/api/lesson-import"));
	const { versions } = await list.json() as { versions: { id: string; sha: string }[] }; assert.equal(versions.length, 2);
	const v = versions.find(v => v.id === "chat_import")!;
	const download = await GET(new Request(`http://localhost/api/lesson-import?id=${v.id}&sha=${v.sha}`));
	assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition")!, /^attachment/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), active);
	const { handleChatInput, extraction, stores } = await import("../src/server/index.ts");
	assert.ok(stores.chatStore.pendingImport?.("chat_import"));
	assert.deepEqual(stores.chatStore.getChat("chat_import")!.settings, {});
	assert.equal((await handleChatInput("chat_import", { type: "continue" })).status, 409);
	assert.equal((await handleChatInput("chat_import", { type: "text", text: "Continue" })).status, 503);
	assert.ok(stores.chatStore.pendingImport?.("chat_import"));
	await assert.rejects(extraction.runExtraction("chat_import"), /Continue the lesson/);
	const job = stores.jobStore.createJob({ chatId: "chat_import", kind: "demo", toolCallId: "t" });
	const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
	await createJobRunner({ chatStore: stores.chatStore, jobStore: stores.jobStore,
		deliver: async () => { throw new Error("Delivery forbidden"); }, engineFor: () => { throw new Error("Model resolution forbidden"); } }).runJob(job.id);
	assert.match(stores.jobStore.getJob(job.id)!.error!, /Continue the lesson/);
	const { kickCompaction } = await import("../src/server/compaction.ts");
	const deps = { chatStore: stores.chatStore, engine: {} as never, modelId: "synthetic", kind: "teach" as const, thresholdTokens: 0, systemPromptTokens: 1,
		summarize: async () => { network++; throw new Error("Compaction forbidden"); } };
	kickCompaction(() => deps, "chat_import");
	const { GET: getChat } = await import("../app/api/chats/[id]/route.ts");
	const res = await getChat(new Request("http://localhost/api/chats/chat_import"), { params: Promise.resolve({ id: "chat_import" }) });
	assert.equal((await res.json()).awaitingInput, true);
	assert.deepEqual(fs.readFileSync(path.join(root, "chats/chat_import.json")), active); assert.equal(network, 0);
	const { writeSettings } = await import("../src/store/settings.ts");
	const localModel = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
	writeSettings({ version: 1, models: { strong: { model: localModel } } });
	const { createFauxCore, fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
	const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	let calls = 0;
	const faux = createFauxCore({});
	faux.setResponses([() => { calls++; return fauxAssistantMessage([fauxText("Offline continuation")]); }]);
	const ack = await handleChatInput("chat_import", { type: "text", text: "Continue" }, opts => {
		assert.equal(opts.engine!.model.provider, localModel.provider);
		assert.equal(opts.engine!.model.id, localModel.id);
		return createTeacherAgent(undefined, { ...opts, engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
	});
	assert.equal(ack.status, 200, await ack.clone().text());
	const turn = runningTurn("chat_import"); if (turn) await new Response(turn.subscribe()).text();
	assert.equal(calls, 1); assert.equal(network, 0);
	assert.equal(stores.chatStore.pendingImport?.("chat_import"), undefined);
	const continued = stores.chatStore.getChat("chat_import")!;
	assert.deepEqual(continued.settings?.model, localModel);
	assert.deepEqual(continued.messages[0], JSON.parse(active.toString()).messages[0]);
	assert.equal(continued.messages.length, 3);
	assert.equal((continued.messages[1] as { content: string }).content, "Continue");
	assert.ok(JSON.stringify(continued.messages[2]).includes("Offline continuation"));
	assert.deepEqual(Buffer.from(await (await GET(new Request(`http://localhost/api/lesson-import?id=${v.id}&sha=${v.sha}`))).arrayBuffer()), active);
	const reopened = await getChat(new Request("http://localhost/api/chats/chat_import"), { params: Promise.resolve({ id: "chat_import" }) });
	assert.equal((await reopened.json()).awaitingInput, false);
	assert.equal(calls, 1); assert.equal(network, 0);
});
