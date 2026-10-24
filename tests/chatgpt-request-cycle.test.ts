import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { piModels, piEngineForSpec, APP_IDENTITY } from "../src/agent/models.ts";
import { refreshChatGPTModels, chatGPTScopeCurrent } from "../src/agent/chatgpt-bridge.ts";
import { ChatGPTRequestCycle } from "../src/agent/chatgpt-request-cycle.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chatgpt-native-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { runPiTurn } = await import("../src/server/pi/ui-stream.ts");
import { newUserMessage, newNextMessage, newThinkingMessage, newAnswerResult, reconstructRequestCause, concludedByDismissalPair, type LhMessage } from "../src/core/native-messages.ts";

const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const realFetch = globalThis.fetch;
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const model = piModels().getModel("openai", "gpt-5") as Model<"openai-responses">;
let epoch = 1, revision = 1, background = true;
let cut: "lease" | "payload" | "full" | "afterFetch" | "none" = "none";
let leases: boolean[] = [], fetches = 0, toolFirst = false;
const status = () => ({ available: true, pending: false, allowBackgroundUse: background, activeId: "scratch", accounts: [{ id: "scratch", registration: "oaiapp_scratch", email: "dummy@example.invalid", connected: true, planEnabled: true, background: !background }], error: null });
const ipc = (m: unknown) => (process.emit as (name: string, m: unknown) => boolean)("message", m);
function revoke(full = false) {
 background = false; if (full) epoch++;
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch, authorityRevision: epoch, revision: ++revision }, status: status(), invalidate: full ? "all" : "background" });
}
before(() => {
 process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
 Object.defineProperty(process, "connected", { configurable: true, value: true });
 Object.defineProperty(process, "send", { configurable: true, value: (m: any, callback?: () => void) => {
  if (m.op === "lease") {
   leases.push(m.background);
   assert.equal(m.expectedAccountId, "scratch"); assert.equal(m.expectedAuthorityRevision, epoch); assert.equal(m.selectedModelId, model.id);
   if (m.background && (cut === "lease" || cut === "full")) { const full = cut === "full"; cut = "none"; revoke(full); }
  }
  const value = { epoch, authorityRevision: epoch, revision, ...(m.op === "lease" ? { accountId: "scratch", accessToken: "dummy-oauth-native" } : { status: status(), accountId: "scratch", models: [{ id: model.id, name: "Scratch" }] }) };
  queueMicrotask(() => ipc({ channel: "lh:chatgpt", id: m.id, op: m.op, ok: true, value })); callback?.(); return true;
 } });
 globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.headers.get("authorization"), "Bearer dummy-oauth-native");
  assert.equal(request.headers.get("user-agent"), APP_IDENTITY.userAgent.custom);
  const body = JSON.parse(await request.text()); assert.equal(body.model, model.id); assert.equal(body.store, false);
  fetches++;
  if (cut === "afterFetch") { cut = "none"; revoke(); throw new Error("admitted local abort"); }
  if (toolFirst && fetches === 1) {
   const call = { type: "function_call", id: "fc_again", call_id: "call_again", name: "again", namespace: "learnharness", arguments: "{}", status: "completed" };
   return new Response([{ type: "response.output_item.added", output_index: 0, item: call }, { type: "response.output_item.done", output_index: 0, item: call }, { type: "response.completed", response: { status: "completed", output: [call], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }
  const item = { id: "msg_native", type: "message", role: "assistant", content: [{ type: "output_text", text: "Accepted learner", annotations: [] }] };
  const events = [{ type: "response.created", response: { id: "resp_native" } }, { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }, { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Accepted learner" }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
 };
});
after(() => {
 if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
 if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
 globalThis.fetch = realFetch;
 fs.rmSync(scratch, { recursive: true, force: true });
 if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
 if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
});
const automatic = (id = "auto") => ({ id, role: "custom" as const, customType: "subagent-steer" as const, content: "Automatic result", details: { jobId: "dummy-job" }, display: true, timestamp: 2 });
async function nativeRun(where: typeof cut, staged: boolean, withLearner = true, commitThrows = false, lateAutomatic = false, withTool = false) {
 epoch++; revision++; background = true; cut = where; leases = []; fetches = 0; toolFirst = withTool;
 await refreshChatGPTModels([model]);
 const seed = newUserMessage("Initial learner"); const marker = automatic(); const learner = { ...newUserMessage("New learner"), id: "learner-late" };
 const messages = staged ? [seed, marker] : [seed];
 const purpose = { background: staged };
 let restored = 0, committed = 0, usage = 0, settled = 0, executed = 0, handedLate = false;
 let final: AgentMessage[] = [];
 let resolve!: () => void; const finished = new Promise<void>((done) => { resolve = done; });
 const cycle = new ChatGPTRequestCycle({ initialMessages: messages, staged: staged ? [marker] : undefined, foregroundOwed: !staged, purpose, scopeCurrent: chatGPTScopeCurrent,
  commitStaged: () => { if (commitThrows) throw new Error("scratch durable write failure"); committed++; },
  restoreAutomatic: (ids, retained) => { restored++; assert(ids.has(marker.id)); assert(!retained.has(marker.id)); agent.clearSteeringQueue(); },
 });
 const raw = piEngineForSpec({ provider: "chatgpt", id: model.id }, () => purpose.background, cycle);
 const engine = { ...raw, streamFn: (m: any, context: any, opts: any) => raw.streamFn(m, context, { ...opts, onPayload: async (payload: unknown) => { if (lateAutomatic && !handedLate) { handedLate = true; agent.steer(marker); } if (cut === "payload") { cut = "none"; await Promise.resolve(); revoke(); } return payload; } }) };
 const agent = createTeacherAgent(undefined, { engine, messages, chatId: "scratch-native-session", tools: withTool ? { again: { name: "again", label: "again", description: "scratch", parameters: Type.Object({}), execute: async () => { executed++; return { content: [{ type: "text" as const, text: "Done" }], details: {} }; } } } : {}, callPurpose: purpose, requestCycle: cycle, onUsage: () => usage++ });
 if (!staged && !lateAutomatic) agent.steer(marker);
 if (withLearner) agent.steer(learner);
 const handle = runPiTurn({ agent, requestCycle: cycle, onFinish: (m) => { settled++; final = m; resolve(); } });
 const firstView = new Response(handle.subscribe()).text();
 await finished;
 const wire = await firstView; const replay = await new Response(handle.subscribe()).text();
 assert.equal(settled, 1);
 assert.equal(replay.includes('"id":"auto"'), wire.includes('"id":"auto"'));
 assert.equal(replay.split('"type":"agent_end"').length, 2);
 const events = wire.split("\n\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as AgentEvent);
 assert.equal(events.filter((e) => e.type === "agent_end").length, 1);
 assert.equal(events.filter((e) => e.type === "agent_start").length, 1);
 return { cycle, agent, final, wire, events, restored, committed, usage, executed, leases: [...leases], fetches };
}
for (const where of ["lease", "payload"] as const) for (const staged of [false, true]) {
 test(`real native drain -> ${where} denial -> same Agent foreground recovery, staged=${staged}`, { timeout: 5000 }, async () => {
  const r = await nativeRun(where, staged);
  assert.equal(r.fetches, 1); assert.deepEqual(r.leases, [true, false]); assert.equal(r.usage, 1); assert.equal(r.restored, 1);
  assert(!r.wire.includes('"id":"auto"')); assert(!r.wire.includes('"stopReason":"error"'));
  assert.equal(r.final.filter((m) => (m as { id?: string }).id === "learner-late").length, 1);
  assert.equal(r.events.filter((e) => e.type === "message_end" && (e.message as { id?: string }).id === "learner-late").length, 1);
  assert.equal(r.events.filter((e) => e.type === "turn_start").length, 1);
  assert.equal(await r.cycle.admission, false);
 });
}
test("initial automatic denial without learner creates no usage/visible marker/durable prefix", async () => {
 const r = await nativeRun("lease", true, false); assert.equal(r.fetches, 0); assert.equal(r.usage, 0); assert.equal(r.committed, 0); assert.equal(await r.cycle.admission, false); assert(!r.wire.includes('"id":"auto"'));
});
test("full invalidation never internally retries under a new authority", async () => {
 const r = await nativeRun("full", true); assert.equal(r.fetches, 0); assert.equal(r.usage, 0); assert.deepEqual(r.leases, [true]);
});
test("successful staged prefix commits once before native dispatch and is visible exactly once", async () => {
 const r = await nativeRun("none", true, false); assert.equal(r.fetches, 1); assert.equal(r.committed, 1); assert.equal(await r.cycle.admission, true);
 assert.equal(r.events.filter((e) => e.type === "message_end" && (e.message as { id?: string }).id === "auto").length, 1);
});
test("durable staged input failure prevents dispatch and does not infer foreground replay", async () => {
 const r = await nativeRun("none", true, false, true); assert.equal(r.fetches, 0); assert.equal(r.usage, 0); assert.equal(await r.cycle.admission, false);
});
test("invalidation after fetch commitment cannot replay an admitted request", async () => {
 const r = await nativeRun("afterFetch", false); assert.equal(r.fetches, 1); assert.equal(r.restored, 0); assert.deepEqual(r.leases, [true]); assert.equal(await r.cycle.admission, true);
});

test("automatic arrival after completed foreground prose cannot manufacture another foreground request", async () => {
 const r = await nativeRun("lease", false, false, false, true);
 assert.equal(r.fetches, 1); assert.equal(r.usage, 1); assert.equal(r.restored, 1); assert.deepEqual(r.leases, [false, true]);
 assert(!r.wire.includes('"id":"auto"'));
});
test("unfinished foreground ordinary-tool chain recovers without rerunning the completed tool", async () => {
 const r = await nativeRun("lease", false, false, false, true, true);
 assert.equal(r.fetches, 2); assert.equal(r.executed, 1); assert.equal(r.usage, 2); assert.deepEqual(r.leases, [false, true, false]);
 assert.equal(r.final.filter((m) => m.role === "toolResult").length, 1);
 assert(!r.wire.includes('"id":"auto"'));
});

test("full native record reconstruction preserves original causes and reports genuine ambiguity", () => {
 const user = newUserMessage("Learner"); const auto = automatic();
 const assistant = { role: "assistant", id: "assistant", api: "openai-responses", provider: "chatgpt", model: model.id, content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 3, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as LhMessage;
 const result = { role: "toolResult", id: "result", toolName: "read", toolCallId: "call", content: [], details: {}, isError: false, timestamp: 4 } as LhMessage;
 for (const [origin, expected] of [[user, "foreground"], [auto, "background"]] as const) assert.equal(reconstructRequestCause(JSON.parse(JSON.stringify([origin, assistant, result]))), expected);
 assert.equal(reconstructRequestCause([auto, user, assistant, result]), "ambiguous");
 assert.equal(reconstructRequestCause([user, auto, assistant, result]), "background");
 assert.equal(reconstructRequestCause([assistant, result]), "ambiguous");
 assert.equal(reconstructRequestCause([auto, newThinkingMessage("problem", "working")]), "ambiguous");
 assert.equal(reconstructRequestCause([auto, assistant, newNextMessage()]), "foreground");
 assert.equal(reconstructRequestCause([user, ...concludedByDismissalPair("problem")]), "foreground");
 const question = { ...assistant, content: [{ type: "toolCall", id: "question", name: "quiz", arguments: {} }] } as LhMessage;
 assert.equal(reconstructRequestCause([auto, question, newAnswerResult("question", "quiz", { kind: "quiz", questionText: "Scratch", dontKnow: false, answers: [], answeredAt: "2026-10-24T00:00:00Z" })]), "foreground");
 assert.equal(reconstructRequestCause([auto, question, { ...newAnswerResult("question", "quiz", {}), details: null }]), "background");
 assert.equal(reconstructRequestCause([auto, question, newAnswerResult("orphan", "quiz", {})]), "ambiguous");
 assert.equal(reconstructRequestCause([user, { ...user, content: "conflict" }]), "ambiguous");
});
