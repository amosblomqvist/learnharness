/**
 * Aside threads (issue #16) — the side channel's offline pins:
 *
 *   1. STORE ROUNDTRIP: saveAsides persists through the normal chat-store
 *      path; pre-aside records (no `asides` field) still load; a messages
 *      write never clobber the asides field (and vice versa); the session
 *      list never carries thread content.
 *   2. NON-POLLUTION: an aside Q&A lands in record.asides and NEVER in
 *      record.messages — toLlmMessages of the record, and the engine input
 *      of a subsequent MAIN turn, both exclude the aside content.
 *   3. LIVENESS: askAside refuses with 409 while a main turn holds turn
 *      liveness (and claims none of its own); one aside at a time.
 *   4. SNAPSHOT BOUNDS: the one-shot engine input is built from the LAST
 *      ASIDE_CONTEXT_MESSAGES user-facing exchanges + the current plan,
 *      never the whole transcript (fake-engine capture, the chat-flow
 *      pattern).
 *
 * The gates mirror chat-flow's setup: per-chat model pins (BYOK), the
 * openrouter key-present env, and direct service/route invocation.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatInput } from "../src/server/chat-handler.ts";
import { askAside, asideInFlight } from "../src/server/asides.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { subscribe, type ServerEvent } from "../src/core/events.ts";
import { newAsideThreadId } from "../src/core/asides.ts";
import { newUserMessage, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import type { AsideThread } from "../src/core/contracts.ts";
import type { Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { PATHS } from "../config.ts";

// Route-level pin (the chat-birth-stamp pattern): the asides route's own
// handler, driven directly with the runner's env.
const asidesRoute = await import("../app/api/chats/[id]/asides/route.ts");

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

// ─── helpers (the chat-flow setup discipline) ────────────────────────────────

/** A configured chat: per-chat model pin (BYOK) + a plan tree, exactly the
 *  production setup flow's record. */
function createConfiguredChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, {
		nodes: [
			{ id: "planet-order", title: "Planet order" },
			{ id: "solar-formation", title: "Solar formation" },
		],
		edges: [],
		version: 1,
	});
	return chat;
}

/** A synthetic completed assistant text message (the record's shape — the
 *  concludedByDismissalPair stamps discipline). */
let synthSeq = 0;
function assistantText(text: string): LhMessage {
	const usage: Usage = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		id: `msg_synth_${Date.now().toString(36)}_${(synthSeq++).toString(36)}`,
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		api: "faux",
		provider: "synthetic",
		model: "synthetic-test",
		usage,
		stopReason: "stop",
	} as LhMessage;
}

/** A scripted aside engine: one text answer, capturing every prompt it
 *  received (the scriptedTeacher capture pattern). */
function scriptedAside(answer = "Aside answer: Mercury is closest."):
	{ engine: PiEngine; calls: string[] } {
	const calls: string[] = [];
	const faux = createFauxCore({});
	faux.setResponses([
		((context: { messages: Array<{ content: unknown }> }) => {
			calls.push(context.messages.map((m) => JSON.stringify(m.content)).join("\n"));
			return fauxAssistantMessage([fauxText(answer)]);
		}) as unknown as FauxResponseStep,
	]);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

function asidePost(chatId: string, text: unknown): Promise<Response> {
	return asidesRoute.POST(
		new Request(`http://test/api/chats/${chatId}/asides`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		}),
		{ params: Promise.resolve({ id: chatId }) },
	);
}

/** Drain a running main turn's SSE to completion (the CONNECTION DIET B
 *  pattern) so settlement persists before assertions. */
async function drainSettled(chatId: string): Promise<void> {
	const handle = runningTurn(chatId);
	if (!handle) return; // already settled inside the handler's awaits
	await new Response(handle.subscribe()).text();
}

const createdFiles: string[] = [];
function track(id: string) {
	createdFiles.push(`${id}.json`);
	return id;
}
after(() => {
	for (const f of createdFiles) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, f));
		} catch {
			/* already gone */
		}
	}
});

// ─── 1. store roundtrip + version tolerance ──────────────────────────────────

describe("aside store roundtrip", () => {
	it("saveAsides persists and reloads through the normal chat-store path", () => {
		const id = track(chatStore.createChat("Asides: roundtrip").id);
		const thread: AsideThread = {
			id: newAsideThreadId(),
			createdAt: new Date().toISOString(),
			messages: [
				{ role: "user", text: "why is Mercury first?", at: new Date().toISOString() },
				{ role: "assistant", text: "It formed closest to the young Sun.", at: new Date().toISOString() },
			],
		};
		chatStore.saveAsides(id, [thread]);
		const loaded = chatStore.getChat(id)!;
		assert.equal(loaded.asides?.length, 1);
		assert.deepEqual(loaded.asides![0]!.messages.map((m) => m.role), ["user", "assistant"]);
		assert.match(loaded.asides![0]!.messages[1]!.text, /young Sun/);
	});

	it("a pre-aside record (no asides field) still loads — absence is tolerated", () => {
		const id = track("chat_asides_legacy_unit");
		fs.writeFileSync(
			path.join(PATHS.chats, `${id}.json`),
			JSON.stringify({
				id,
				title: "Legacy, pre-asides",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				messages: [],
			}),
		);
		const loaded = chatStore.getChat(id);
		assert.ok(loaded, "the legacy record loads");
		assert.equal(loaded!.asides, undefined, "no asides field, no guess");
		// A later aside append on the legacy record works (lazy adoption).
		chatStore.saveAsides(id, [
			{ id: newAsideThreadId(), createdAt: new Date().toISOString(), messages: [{ role: "user", text: "q", at: new Date().toISOString() }] },
		]);
		assert.equal(chatStore.getChat(id)!.asides!.length, 1);
	});

	it("field-wise isolation: a messages write never clobbers asides (and the summary carries none)", () => {
		const id = track(chatStore.createChat("Asides: isolation").id);
		chatStore.saveAsides(id, [
			{ id: newAsideThreadId(), createdAt: new Date().toISOString(), messages: [{ role: "user", text: "kept?", at: new Date().toISOString() }] },
		]);
		const messagesBefore = chatStore.getChat(id)!.messages.length;
		chatStore.saveMessages(id, [newUserMessage("a main-turn write")]);
		const after = chatStore.getChat(id)!;
		assert.equal(after.messages.length, messagesBefore + 1);
		assert.equal(after.asides?.length, 1, "the asides field survived the messages write");
		const summary = chatStore.listChats().find((s) => s.id === id);
		assert.ok(summary, "the session lists");
		assert.equal("asides" in summary, false, "the list payload never carries thread content");
	});
});

// ─── 2. the non-pollution contract ────────────────────────────────────────────

describe("aside non-pollution (the main projection never sees asides)", () => {
	it("an aside Q&A persists to record.asides; a subsequent MAIN turn's engine input excludes it", async () => {
		const chat = createConfiguredChat("Asides: non-pollution");
		track(chat.id);
		chatStore.saveMessages(chat.id, [
			newUserMessage("teach me the solar system"),
			assistantText("The solar system has eight planets."),
		]);
		const messagesBefore = chatStore.getChat(chat.id)!.messages;

		const { engine: asideEngine } = scriptedAside();
		const res = await askAside(chat.id, "Wait — why is Mercury first?", { engine: asideEngine });
		assert.equal(res.status, 200);
		const body = (await res.json()) as { thread?: AsideThread };
		assert.equal(body.thread?.messages.length, 2, "one Q&A pair in the thread");

		const saved = chatStore.getChat(chat.id)!;
		assert.equal(saved.messages.length, messagesBefore.length, "the main record did not grow");
		assert.equal(saved.asides?.length, 1, "the pair lives in the aside thread");
		assert.match(saved.asides![0]!.messages[1]!.text, /Mercury is closest/);

		// The static projection of the record excludes the aside content.
		const wire = toLlmMessages(saved.messages as never);
		const wireText = JSON.stringify(wire);
		assert.doesNotMatch(wireText, /Mercury is first/, "toLlmMessages carries no aside question");
		assert.doesNotMatch(wireText, /Mercury is closest/, "toLlmMessages carries no aside answer");

		// The dynamic pin: a REAL subsequent main turn — the teacher's engine
		// input (the captured prompt) must exclude both halves of the aside.
		const main = scriptedAside("Main turn reply.");
		const mainEngine: PiEngine = main.engine;
		const mainCalls = main.calls;
		const ack = await handleChatInput(chat.id, { type: "text", text: "continue the lesson" }, (opts) =>
			createTeacherAgent(undefined, { engine: mainEngine, messages: opts.messages }),
		);
		assert.equal(ack.status, 200);
		await drainSettled(chat.id);
		assert.equal(mainCalls.length, 1, "the teacher made its model call");
		assert.doesNotMatch(mainCalls[0]!, /Mercury is first/, "the aside question never reached the teacher");
		assert.doesNotMatch(mainCalls[0]!, /Mercury is closest/, "the aside answer never reached the teacher");
		assert.match(mainCalls[0]!, /continue the lesson/, "sanity: the real input did reach it");
	});

	it("announces the persisted thread with record-changed (the notify-then-fetch law)", async () => {
		const chat = createConfiguredChat("Asides: event");
		track(chat.id);
		const got: ServerEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === "record-changed") got.push(e);
		});
		try {
			const res = await askAside(chat.id, "quick one?", { engine: scriptedAside().engine });
			assert.equal(res.status, 200);
			assert.ok(
				got.some((e) => e.chatId === chat.id),
				"record-changed carried the chatId for other views",
			);
		} finally {
			off();
		}
	});
});

// ─── 3. liveness: the 409 family ─────────────────────────────────────────────

describe("aside liveness refusals", () => {
	it("refuses with 409 while a main turn holds liveness — no partial write, no aside claim", async () => {
		const chat = createConfiguredChat("Asides: main-turn refusal");
		track(chat.id);
		assert.equal(beginTurn(chat.id), true, "the main turn claims the chat");
		const res = await askAside(chat.id, "any question?", { engine: scriptedAside().engine });
		assert.equal(res.status, 409);
		assert.match((await res.json()).error, /after the current reply/);
		assert.equal(chatStore.getChat(chat.id)!.asides, undefined, "nothing persisted");
		assert.equal(asideInFlight(chat.id), false, "the refusal claimed no aside liveness");
		endTurn(chat.id);

		// After the turn settles, the same ask goes through.
		const ok = await askAside(chat.id, "any question?", { engine: scriptedAside().engine });
		assert.equal(ok.status, 200);
	});

	it("one aside at a time: a second concurrent ask gets the busy 409", async () => {
		const chat = createConfiguredChat("Asides: one at a time");
		track(chat.id);
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const first = askAside(chat.id, "slow question", {
			answerer: async () => {
				await gate;
				return { text: "slow answer", usage: zeroUsage() };
			},
		});
		await new Promise((r) => setTimeout(r, 25)); // let the first claim
		assert.equal(asideInFlight(chat.id), true, "the first aside is running");
		const second = await askAside(chat.id, "impatient question", {
			answerer: async () => ({ text: "never", usage: zeroUsage() }),
		});
		assert.equal(second.status, 409);
		assert.match((await second.json()).error, /already being answered/);
		release();
		const done = await first;
		assert.equal(done.status, 200);
		assert.equal(asideInFlight(chat.id), false, "the claim released");
		assert.equal(chatStore.getChat(chat.id)!.asides![0]!.messages.length, 2, "exactly one pair persisted");
	});

	it("the route mirrors the service: 404 unknown chat, 400 bad text", async () => {
		const missing = await asidePost("chat_asides_nonexistent", "hi");
		assert.equal(missing.status, 404);
		const chat = createConfiguredChat("Asides: route validation");
		track(chat.id);
		const empty = await asidePost(chat.id, "   ");
		assert.equal(empty.status, 400);
		const notString = await asidePost(chat.id, 42);
		assert.equal(notString.status, 400);
	});
});

// ─── 4. the bounded snapshot (fake-engine capture) ───────────────────────────

describe("aside snapshot bounds", () => {
	it("the one-shot engine input carries the last 12 user-facing exchanges + the plan + the question — never the deep history", async () => {
		const chat = createConfiguredChat("Asides: snapshot bounds");
		track(chat.id);
		// 15 exchanges: only the LAST 12 user-facing messages may ride.
		const seeded: LhMessage[] = [];
		for (let i = 1; i <= 15; i++) {
			seeded.push(newUserMessage(`note ${i}`));
			seeded.push(assistantText(`tutor reply ${i}`));
		}
		chatStore.saveMessages(chat.id, seeded);

		const { engine, calls } = scriptedAside();
		const res = await askAside(chat.id, "why is Mercury first?", { engine });
		assert.equal(res.status, 200);
		assert.equal(calls.length, 1, "one model call (the one-shot seam)");

		const prompt = calls[0]!;
		// The question and the plan are present.
		assert.match(prompt, /why is Mercury first\?/);
		assert.match(prompt, /Planet order/, "the current plan rides the snapshot");
		// The bound: the last 12 user-facing messages (notes 10-15, replies
		// 10-15 — 30 lines of exchange end at note 10), never the deep history.
		assert.match(prompt, /note 10/, "the 12th-newest user-facing message is included");
		assert.match(prompt, /note 15/, "the newest exchange is included");
		assert.doesNotMatch(prompt, /note 9/, "everything older than the bound is dropped");
		assert.doesNotMatch(prompt, /tutor reply 9/, "the bound applies to tutor lines alike");
		// The answering doctrine is the ASIDE prompt, not the teaching prompt.
		assert.match(prompt, /You answer quick aside questions/, "the dedicated aside system prompt composes");
		assert.match(prompt, /Do not quiz the learner/);
	});

	it("assistant tool traffic and thinking never ride the excerpt (user-facing prose only)", async () => {
		const chat = createConfiguredChat("Asides: excerpt fold");
		track(chat.id);
		const noisy = assistantText("clean prose");
		// A tool-call assistant message: model-facing in the lesson, but NOT
		// user-facing prose — the excerpt must skip its call payload.
		const tooly = {
			...assistantText(""),
			content: [{ type: "toolCall", id: "call-x", name: "research", arguments: { query: "SECRET-TOOL-ARG" } }],
		} as LhMessage;
		chatStore.saveMessages(chat.id, [newUserMessage("hi"), tooly, noisy]);
		const { engine, calls } = scriptedAside();
		const res = await askAside(chat.id, "what did you mean?", { engine });
		assert.equal(res.status, 200);
		assert.match(calls[0]!, /clean prose/, "assistant prose is included");
		assert.doesNotMatch(calls[0]!, /SECRET-TOOL-ARG/, "tool payloads are excluded from the aside context");
	});
});

function zeroUsage(): Usage {
	return {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
