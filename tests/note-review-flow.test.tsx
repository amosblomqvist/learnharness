/**
 * Note review in the browser store: Review opens a review thread after the
 * last prose block, Rewrite note fetches the smallest fix and the notes
 * controller applies it to the highlighted text only (with Undo). The
 * store runs against the real services through a fetch shim; the model is
 * pi's faux provider.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-note-review-flow-"));
process.env.LH_DATA_DIR = TMP_DATA;

// A DOM for the window tests that click (set before the browser modules load).
const dom = parseHTML("<!DOCTYPE html><html><body></body></html>");
Object.assign(dom.document, { compatMode: "CSS1Compat" });
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 0 });
const reveals: unknown[] = [];
Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView: (opts: unknown) => void reveals.push(opts) });
const { createRoot } = await import("react-dom/client");

const { chatStore } = await import("../src/store/chats.ts");
const { createSideChatService } = await import("../src/server/side-chat.ts");
const { createNoteRewriter } = await import("../src/server/note-rewrite.ts");
const { SideChatStore, sideBlockKey } = await import("../components/side-chat-state.tsx");
const { SideChatWindow } = await import("../components/side-chat.tsx");
const { NotesController, NotesProvider } = await import("../components/notes-state.tsx");
const { parseSideAskInput, parseSideOpenInput, newUserMessage, SIDE_REVIEW_REQUEST } = await import("../src/core/index.ts");
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { LhMessage, SideChatAnchor, SideChatThread } from "../src/core/index.ts";
import type { NotesEditorPort } from "../components/notes-state.tsx";
import type { SideWindowView } from "../components/side-chat-state.tsx";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const faux = createFauxCore({});
const engineFor = async () => ({ model: faux.getModel(), streamFn: faux.streamSimple });
const service = createSideChatService({ chatStore, engineFor, instructions: () => "REVIEW" });
const rewriter = createNoteRewriter({ chatStore, engineFor, instructions: () => "REWRITE" });
const answer = (text: string) => faux.appendResponses([() => fauxAssistantMessage(text)]);
const STALE_NOTE = "This part of your notes changed. Highlight it again and click Review.";

// The fetch shim: the store's URLs → the services, exactly as the routes do.
const posts: unknown[] = [];
/** The saved notes each rewrite call saw. */
const rewriteSaw: (string | undefined)[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = String(input);
	const notesPut = url.match(/^\/api\/chats\/([^/]+)\/notes$/);
	if (notesPut && init?.method === "PUT") {
		chatStore.saveNotes(notesPut[1]!, JSON.parse(String(init.body)).text);
		return Response.json({ ok: true });
	}
	const m = url.match(/^\/api\/chats\/([^/]+)\/side-chats(?:\/([^/]+))?(\/stop|\/rewrite)?$/);
	if (!m) return realFetch(input, init);
	const [, chatId, threadId, action] = m;
	const method = init?.method ?? "GET";
	const body = init?.body ? JSON.parse(String(init.body)) : undefined;
	if (!threadId && method === "GET") return Response.json(service.list(chatId!));
	if (!threadId && method === "POST") {
		posts.push(body);
		return service.ask(chatId!, parseSideAskInput(body));
	}
	if (action === "/stop") return Response.json({ ok: service.stop(chatId!, threadId!) });
	if (action === "/rewrite") {
		rewriteSaw.push(chatStore.getChat(chatId!)?.notes);
		return rewriter.rewrite(chatId!, threadId!);
	}
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

function memoryStorage() {
	const store = new Map<string, string>();
	return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
}

/** An editor stand-in backed by a string, reporting edits like the real one. */
function fakePort(notes: InstanceType<typeof NotesController>): NotesEditorPort {
	let doc = notes.text();
	const edit = (next: string) => {
		doc = next;
		notes.onEdit(doc);
	};
	return {
		replace: (from, to, insert) => edit(doc.slice(0, from) + insert + doc.slice(to)),
		append: (block) => edit(`${doc}${block}`),
		reset: (text) => void (doc = text),
	};
}

function chatWithProse() {
	const chat = chatStore.createChat("review flow");
	const prose = { ...fauxAssistantMessage("The pull acts on the network, not on A."), id: `msg_rf${Date.now().toString(36)}` } as unknown as LhMessage;
	chatStore.saveMessages(chat.id, [newUserMessage("teach me"), prose]);
	const anchor: SideChatAnchor = { messageId: prose.id, partId: `${prose.id}-t0`, blockIndex: 0, blockText: "The pull acts on the network, not on A." };
	return { chat, anchor, block: sideBlockKey(anchor.partId, 0) };
}

async function openAnsweredReview(highlight: string, from: number) {
	const { chat, anchor, block } = chatWithProse();
	const store = new SideChatStore(chat.id);
	answer("Close, but A does change.");
	const accepted = await store.openReview(anchor, { highlight, from });
	const renderKey = store.windowsAt(block).at(-1)?.renderKey;
	await until(() => store.windowsAt(block).at(-1)?.thread?.messages.length === 2 && !store.windowsAt(block).at(-1)!.answering, "review answer");
	return { chat, store, block, accepted, renderKey: renderKey!, key: store.windowsAt(block).at(-1)!.key };
}

describe("note review flow", () => {
	it("openReview posts anchor + review + request, saves a review thread", async () => {
		const { chat, store, block, accepted, renderKey } = await openAnsweredReview("A fixed?", 0);
		assert.equal(accepted, true);
		const thread = chatStore.getChat(chat.id)!.sideChats![0]!;
		assert.deepEqual(thread.review, { highlight: "A fixed?", from: 0 });
		assert.equal(thread.messages[0]!.text, SIDE_REVIEW_REQUEST);
		assert.equal(thread.messages[0]!.quotes, undefined);
		assert.deepEqual(posts.at(-1), { anchor: thread.anchor, text: SIDE_REVIEW_REQUEST, quotes: [], review: { highlight: "A fixed?", from: 0 } });
		const view = store.windowsAt(block).at(-1)!;
		assert.deepEqual(view.review, { highlight: "A fixed?", from: 0 });
		assert.equal(view.renderKey, renderKey, "the draft window became the thread without a remount");
		assert.equal(store.composerText.has(renderKey), false, "the request is not left in the follow-up box");
		// Scrolled into view once; it does not take the cursor from the notes.
		assert.equal(store.consumeReveal(renderKey), true);
		assert.equal(store.consumeReveal(renderKey), false);
		assert.equal(store.consumeFocus(renderKey), false);
	});

	it("a side question is never revealed and has no review", () => {
		const { chat, anchor, block } = chatWithProse();
		const store = new SideChatStore(chat.id);
		const key = store.openAt(anchor, "a bit");
		assert.equal(store.consumeReveal(key), false);
		assert.equal(store.windowsAt(block)[0]!.review, undefined);
	});

	it("rewrite applies to the highlighted text only; undo restores", async () => {
		const { chat, store, key } = await openAnsweredReview("A fixed?", 5);
		const notes = new NotesController(chat.id, "keep\nA fixed?\nkeep", { storage: memoryStorage() });
		notes.attach(fakePort(notes));
		faux.appendResponses([() => fauxAssistantMessage("A moves via the network")]);
		const out = await store.rewrite(key);
		assert.ok("replacement" in out, JSON.stringify(out));
		const undo = notes.replaceHighlight("A fixed?", 5, out.replacement)!;
		assert.equal(notes.text(), "keep\nA moves via the network\nkeep");
		assert.equal(notes.undoRewrite(undo), true);
		assert.equal(notes.text(), "keep\nA fixed?\nkeep");
		notes.dispose();
	});

	it("a highlight over 4,000 characters round-trips unclipped and Rewrite applies", async () => {
		const long = `${"step ".repeat(900)}A fixed?`;
		const { chat, store, block, key } = await openAnsweredReview(long, 5);
		assert.equal(chatStore.getChat(chat.id)!.sideChats![0]!.review!.highlight, long);
		const review = store.windowsAt(block).at(-1)!.review!;
		assert.equal(review.highlight, long);
		const notes = new NotesController(chat.id, `keep\n${long}\nkeep`, { saveDelayMs: 60_000, storage: memoryStorage() });
		faux.appendResponses([() => fauxAssistantMessage("A moves")]);
		const out = await store.rewrite(key);
		assert.ok("replacement" in out, JSON.stringify(out));
		assert.ok(notes.replaceHighlight(review.highlight, review.from, out.replacement));
		assert.equal(notes.text(), "keep\nA moves\nkeep");
		notes.dispose();
	});

	it("rewrite reports the server's refusal", async () => {
		const { chat } = chatWithProse();
		assert.deepEqual(await new SideChatStore(chat.id).rewrite("side_missing"), { error: "Unknown chat or side thread" });
	});

	it("replaceHighlight returns null and leaves notes unchanged when the text is gone", () => {
		const notes = new NotesController("c1", "edited since", { storage: memoryStorage() });
		assert.equal(notes.replaceHighlight("A fixed?", 0, "x"), null);
		assert.equal(notes.text(), "edited since");
	});

	it("lastProseAnchor is the last side-enabled block in DOM order", () => {
		const { chat, anchor } = chatWithProse();
		const store = new SideChatStore(chat.id);
		const later = { ...anchor, blockIndex: 2, blockText: "Later." };
		store.blocks.set("p#0", anchor);
		store.blocks.set("p#2", later);
		const { document } = parseHTML(
			`<html><body><div data-side-block="p#0" data-side-enabled=""></div><div data-side-block="p#2" data-side-enabled=""></div><div data-side-block="p#4"></div></body></html>`,
		);
		assert.equal(store.lastProseAnchor(document), later);
		assert.equal(store.lastProseAnchor(parseHTML("<html><body><div data-side-block='p#4'></div></body></html>").document), null);
	});
});

describe("Rewrite note in the window", () => {
	it("keeps Undo and the rewritten text across remounts, and opens the notes", async () => {
		const { chat, store, block } = await openAnsweredReview("A fixed?", 5);
		// A second copy of the original wording must never be the one rewritten.
		const original = "keep\nA fixed?\nkeep\nA fixed?";
		const notes = new NotesController(chat.id, original, { saveDelayMs: 60_000, storage: memoryStorage() });
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const render = (over: Partial<SideWindowView> = {}) =>
			act(async () =>
				root.render(
					<NotesProvider controller={notes}>
						<SideChatWindow view={{ ...store.windowsAt(block).at(-1)!, ...over }} store={store} />
					</NotesProvider>,
				),
			);
		const remount = async (over: Partial<SideWindowView>) => {
			await render(over);
			assert.equal(host.querySelector('[data-testid="note-rewrite"]'), null, "the button unmounted");
			await render();
		};
		const click = async (testId: string, done: () => boolean) => {
			const el = host.querySelector(`[data-testid="${testId}"]`);
			assert.ok(el, testId);
			await act(async () => {
				el.dispatchEvent(new dom.window.Event("click", { bubbles: true }) as unknown as Event);
				await until(done, testId);
			});
		};
		const rewriteTo = async (replacement: string, expected: string) => {
			faux.appendResponses([() => fauxAssistantMessage(replacement)]);
			await click("note-rewrite", () => notes.text() === expected);
		};

		await render();
		assert.deepEqual(reveals, [{ block: "nearest", behavior: "smooth" }], "a new review window scrolls into view once");
		assert.equal(notes.getSnapshot().open, false);
		await rewriteTo("A moves", "keep\nA moves\nkeep\nA fixed?");
		assert.equal(notes.getSnapshot().open, true, "the notes open to show the change");

		await remount({ open: false }); // fold and reopen
		const undoButton = host.querySelector('[data-testid="note-rewrite-undo"]');
		assert.ok(undoButton, "Undo survives the fold");
		assert.equal(undoButton.getAttribute("aria-label"), "Undo rewrite");
		assert.equal(undoButton.getAttribute("title"), "Undo rewrite");
		assert.equal(undoButton.textContent, "");
		await click("note-rewrite-undo", () => notes.text() === original);
		assert.equal(host.querySelector('[data-testid="note-rewrite-undo"]'), null);

		await rewriteTo("A moves twice", "keep\nA moves twice\nkeep\nA fixed?");
		assert.equal(rewriteSaw.at(-1), original, "the undone notes were saved before the call");
		await remount({ answering: true }); // a follow-up answering
		await rewriteTo("A moves thrice", "keep\nA moves thrice\nkeep\nA fixed?");
		assert.ok(host.querySelector('[data-testid="note-rewrite-undo"]'));
		assert.equal(reveals.length, 1, "remounts never scroll");

		// The highlight was edited away: no model call, the stale message.
		const calls = rewriteSaw.length;
		const edited = "keep\nA moved on\nkeep\nA fixed?";
		notes.onEdit(edited);
		await click("note-rewrite", () => chatStore.getChat(chat.id)!.notes === edited);
		assert.equal(host.querySelector('[role="alert"]')?.textContent, STALE_NOTE);
		assert.equal(rewriteSaw.length, calls);
		assert.equal(notes.text(), edited);

		await act(async () => root.unmount());
		host.remove();
		const key = store.windowsAt(block).at(-1)!.key;
		assert.ok(store.rewrites.has(key));
		await store.remove(key);
		assert.equal(store.rewrites.has(key), false, "deleting the thread drops its rewrite state");
	});
});

describe("review window render", () => {
	const anchor: SideChatAnchor = { messageId: "m", partId: "m-t0", blockIndex: 0, blockText: "A paragraph." };
	const question = { id: "u1", role: "user" as const, text: SIDE_REVIEW_REQUEST, at: "" };
	const reply = { id: "a1", role: "assistant" as const, text: "Close, but A moves.", at: "" };
	const reviewThread: SideChatThread = { id: "side_r", anchor, review: { highlight: "A **fixed** here?", from: 0 }, open: true, createdAt: "", messages: [question, reply] };
	const view = (over: Partial<SideWindowView> = {}): SideWindowView => ({
		key: "side_r",
		renderKey: "side_r",
		blockKey: sideBlockKey("m-t0", 0),
		anchor,
		thread: reviewThread,
		review: reviewThread.review,
		open: true,
		quotes: [],
		answering: false,
		streamText: "",
		sending: false,
		error: null,
		...over,
	});
	const store = new SideChatStore("chat_render");
	const answeredReviewView = view();
	const answeredSideView = view({ thread: { ...reviewThread, review: undefined }, review: undefined });
	const answeringReviewView = view({ thread: { ...reviewThread, messages: [question] }, answering: true });
	const failedReviewView = view({ thread: { ...reviewThread, messages: [question, { ...reply, error: "boom" }] } });

	it("a review window shows Rewrite note only once answered", () => {
		assert.match(renderToStaticMarkup(<SideChatWindow view={answeredReviewView} store={store} />), /data-testid="note-rewrite"/);
		assert.doesNotMatch(renderToStaticMarkup(<SideChatWindow view={answeredSideView} store={store} />), /note-rewrite/);
		assert.doesNotMatch(renderToStaticMarkup(<SideChatWindow view={answeringReviewView} store={store} />), /note-rewrite/);
		assert.doesNotMatch(renderToStaticMarkup(<SideChatWindow view={failedReviewView} store={store} />), /note-rewrite/);
	});

	it("Rewrite note sits left of the follow-up box; header and bar show the notebook and the highlight", () => {
		const { document } = parseHTML(`<html><body>${renderToStaticMarkup(<SideChatWindow view={answeredReviewView} store={store} />)}</body></html>`);
		const rewrite = document.querySelector('[data-testid="note-rewrite"]')!;
		assert.equal(rewrite.getAttribute("aria-label"), "Rewrite note");
		assert.equal(rewrite.getAttribute("title"), "Rewrite note");
		assert.equal(rewrite.textContent, "");
		assert.ok(rewrite.querySelector("svg.lucide-wand-sparkles"));
		assert.equal(rewrite.closest("form"), null);
		assert.equal(rewrite.previousElementSibling?.getAttribute("data-testid"), "side-chat-collapse-bottom");
		assert.equal(rewrite.nextElementSibling?.tagName, "FORM");
		const header = document.querySelector("header")!;
		assert.ok(header.querySelector("svg.lucide-notebook-pen"));
		assert.match(header.textContent!, /“A fixed here\?”/);
		const bar = parseHTML(`<html><body>${renderToStaticMarkup(<SideChatWindow view={view({ open: false })} store={store} />)}</body></html>`).document.querySelector('[data-testid="side-chat-bar"]')!;
		assert.ok(bar.querySelector("svg.lucide-notebook-pen"));
		assert.match(bar.textContent!, /“A fixed here\?”/);
	});

	it("a review window is labelled a note review; a side window keeps its wording", () => {
		const render = (v: SideWindowView) => parseHTML(`<html><body>${renderToStaticMarkup(<SideChatWindow view={v} store={store} />)}</body></html>`).document;
		const attr = (d: ReturnType<typeof render>, testId: string, name = "aria-label") => d.querySelector(`[data-testid="${testId}"]`)!.getAttribute(name);
		const labels = (d: ReturnType<typeof render>) =>
			[attr(d, "side-chat-window"), attr(d, "side-chat-toggle"), attr(d, "side-chat-delete"), attr(d, "side-chat-collapse-bottom"), attr(d, "side-chat-send"), attr(d, "side-chat-input", "placeholder")];
		assert.deepEqual(labels(render(answeredReviewView)), ["Note review", "Collapse note review", "Delete note review", "Collapse note review", "Send follow-up", "Ask a follow-up…"]);
		assert.deepEqual(labels(render(answeredSideView)), ["Side question", "Collapse side question", "Delete side question", "Collapse side question", "Send side question", "Ask a follow-up…"]);
		assert.equal(attr(render(view({ open: false })), "side-chat-bar"), "Open note review: A fixed here?");
		assert.equal(attr(render(view({ open: false, thread: answeredSideView.thread, review: undefined })), "side-chat-bar"), "Open side question: A paragraph.");
		// The review request is in flight: no messages yet, still a follow-up box.
		const sending = render(view({ key: "draft_r", renderKey: "draft_r", thread: undefined, sending: true }));
		assert.equal(attr(sending, "side-chat-input", "placeholder"), "Ask a follow-up…");
		assert.equal(attr(sending, "side-chat-close"), "Discard note review");
	});

	it("the delete confirmation names a review", async () => {
		for (const [v, prompt] of [
			[answeredReviewView, "Delete this review?"],
			[answeredSideView, "Delete this side question?"],
		] as const) {
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = createRoot(host);
			await act(async () => root.render(<SideChatWindow view={v} store={store} />));
			await act(async () => void host.querySelector('[data-testid="side-chat-delete"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true }) as unknown as Event));
			assert.ok(host.querySelector("header")!.textContent!.includes(prompt), prompt);
			await act(async () => root.unmount());
			host.remove();
		}
	});
});
