/**
 * Side questions, end to end in the browser store (owner follow-up,
 * 2026-11-02): two selections on the SAME paragraph are two windows —
 * two threads, each with its own quote, question, answer and model
 * context. The client store runs against the real server service through
 * a fetch shim; the model is pi's faux provider.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-flow-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { createSideChatService } = await import("../src/server/side-chat.ts");
const { SideChatStore, sideBlockKey } = await import("../components/side-chat-state.tsx");
const { parseSideAskInput, parseSideOpenInput, newUserMessage } = await import("../src/core/index.ts");
import { createFauxCore, fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { LhMessage, SideChatAnchor } from "../src/core/index.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const faux = createFauxCore({});
const contexts: TranscriptContext[] = [];
const service = createSideChatService({
	chatStore,
	engineFor: async () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
	instructions: () => "SIDE",
});
const answer = (text: string) =>
	faux.appendResponses([
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage(text);
		},
	]);

// The fetch shim: the store's URLs → the service, exactly as the routes do.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = String(input);
	const m = url.match(/^\/api\/chats\/([^/]+)\/side-chats(?:\/([^/]+))?(\/stop)?$/);
	if (!m) return realFetch(input, init);
	const [, chatId, threadId, stop] = m;
	const method = init?.method ?? "GET";
	const body = init?.body ? JSON.parse(String(init.body)) : undefined;
	if (!threadId && method === "GET") return Response.json(service.list(chatId!));
	if (!threadId && method === "POST") return service.ask(chatId!, parseSideAskInput(body));
	if (stop) return Response.json({ ok: service.stop(chatId!, threadId!) });
	if (method === "PATCH") return Response.json({ thread: service.setOpen(chatId!, threadId!, parseSideOpenInput(body)) });
	if (method === "DELETE") return Response.json({ ok: service.remove(chatId!, threadId!) });
	throw new Error(`unrouted ${method} ${url}`);
}) as typeof fetch;
after(() => {
	globalThis.fetch = realFetch;
});

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

function chatWithProse() {
	const chat = chatStore.createChat("flow");
	const prose = {
		...fauxAssistantMessage("The slope at a point is the limit of secant slopes. Secants need two points."),
		id: "msg_flowprose",
	} as unknown as LhMessage;
	chatStore.saveMessages(chat.id, [newUserMessage("teach me"), prose]);
	const anchor: SideChatAnchor = {
		messageId: prose.id,
		partId: `${prose.id}-t0`,
		blockIndex: 0,
		blockText: "The slope at a point is the limit of secant slopes. Secants need two points.",
	};
	return { chatId: chat.id, anchor, block: sideBlockKey(anchor.partId, 0) };
}

describe("side questions: two selections on one paragraph", () => {
	it("are two windows with their own quote, question, answer and fresh context", async () => {
		const { chatId, anchor, block } = chatWithProse();
		const store = new SideChatStore(chatId);

		// Selection 1 → window 1 → ask.
		const first = store.openAt(anchor, "limit of secant slopes");
		store.composerText.set(first, "why a limit?");
		answer("ANSWER-ONE");
		assert.equal(await store.ask(first), true);
		await until(() => store.windowsAt(block)[0]?.thread?.messages.length === 2 && !store.windowsAt(block)[0]!.answering, "first answer");

		// Selection 2 on the SAME paragraph → a SECOND window, not a quote in the first.
		const second = store.openAt(anchor, "need two points");
		let windows = store.windowsAt(block);
		assert.equal(windows.length, 2, "two windows after the paragraph");
		assert.deepEqual(windows[0]!.quotes, [], "the first window's composer did not receive the new selection");
		assert.deepEqual(windows[1]!.quotes, ["need two points"]);
		assert.notEqual(windows[0]!.renderKey, windows[1]!.renderKey);

		store.composerText.set(second, "why two?");
		answer("ANSWER-TWO");
		assert.equal(await store.ask(second), true);
		await until(() => store.windowsAt(block)[1]?.thread?.messages.length === 2 && !store.windowsAt(block)[1]!.answering, "second answer");

		windows = store.windowsAt(block);
		assert.equal(windows.length, 2);
		const [one, two] = windows.map((w) => w.thread!);
		assert.notEqual(one!.id, two!.id);
		assert.deepEqual(one!.messages.map((m) => [m.role, m.text, m.quotes]), [["user", "why a limit?", ["limit of secant slopes"]], ["assistant", "ANSWER-ONE", undefined]]);
		assert.deepEqual(two!.messages.map((m) => [m.role, m.text, m.quotes]), [["user", "why two?", ["need two points"]], ["assistant", "ANSWER-TWO", undefined]]);

		// Saved as two threads on the server.
		assert.deepEqual(chatStore.getChat(chatId)!.sideChats!.map((t) => t.messages.length), [2, 2]);

		// Fresh context: the second window's model call never saw the first conversation.
		const secondContext = JSON.stringify(contexts.at(-1)!.messages);
		assert.match(secondContext, /need two points/);
		assert.match(secondContext, /why two\?/);
		assert.doesNotMatch(secondContext, /why a limit\?|ANSWER-ONE|limit of secant slopes<\/|<quote>\nlimit of secant slopes/);
		assert.deepEqual(contexts.at(-1)!.messages.map((m) => m.role), ["system", "user"]);

		// Reopening a closed window opens it in place: no focus, no scroll.
		const threadKey = store.windowsAt(block)[0]!.key;
		store.consumeFocus(threadKey);
		store.setOpen(threadKey, false);
		store.setOpen(threadKey, true);
		assert.equal(store.windowsAt(block)[0]!.open, true);
		assert.equal(store.consumeFocus(threadKey), false);
	});

	it("two selections opened back to back (before asking) are two draft windows", () => {
		const { chatId, anchor, block } = chatWithProse();
		const store = new SideChatStore(chatId);
		const a = store.openAt(anchor, "first bit");
		const b = store.openAt(anchor, "second bit");
		const windows = store.windowsAt(block);
		assert.deepEqual(windows.map((w) => w.key), [a, b]);
		assert.deepEqual(windows.map((w) => w.quotes), [["first bit"], ["second bit"]]);
		// Each NEW window takes the cursor exactly once; nothing else does.
		assert.equal(store.consumeFocus(a), true);
		assert.equal(store.consumeFocus(a), false);
		// Closing one never touches the other.
		store.setOpen(a, false);
		assert.deepEqual(store.windowsAt(block).map((w) => w.key), [b]);
	});
});
