import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { collectCitations, type LhMessage, type SideChatThread } from "../src/core/index.ts";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { useSideThread } from "../components/use-side-thread.ts";

test("a delayed GET cannot rewind newer streamed text; selected quote retains its actual native source", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const callbacks = new Map<string, (raw: string) => void>();
	const source: NotifySource = { close() {}, onOpen() {}, onEvent(name, cb) { callbacks.set(name, cb); } };
	let writer!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
	const frame = (value: unknown) => writer.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
	let getCount = 0; let requestBody: Record<string, unknown> | undefined;
	let release!: (response: Response) => void;
	const delayed = new Promise<Response>((resolve) => { release = resolve; });
	const fakeFetch: typeof fetch = async (_url, options) => {
		if (options?.method === "POST") { requestBody = JSON.parse(String(options.body)); return new Response(stream); }
		return ++getCount === 1 ? Response.json({ threads: [], answering: {} }) : delayed;
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, document, window, fetch: fakeFetch, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const messages: LhMessage[] = [
		{ ...fauxAssistantMessage([fauxToolCall("read", { path: "synthetic.md" }, { id: "read" })], { stopReason: "toolUse" }), id: "work" },
		{ id: "read_result", role: "toolResult", toolCallId: "read", toolName: "read", content: [{ type: "text", text: "Synthetic" }], isError: false, timestamp: 1 },
		{ ...fauxAssistantMessage("Quoted actual prose."), id: "lesson" },
	];
	const thread: SideChatThread = { id: "side_work", anchor: { messageId: "work", partId: "work-t0", blockIndex: 0, blockText: "Segment" }, open: true, createdAt: "2026-11-06T00:00:00Z",
		messages: [{ id: "ask", role: "user", text: "Clarify", at: "2026-11-06T00:00:00Z" }] };
	let side!: ReturnType<typeof useSideThread>;
	function Harness() { side = useSideThread("chat_test", messages); return null; }
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	try {
		await act(async () => root.render(<ServerEventsProvider connect={() => source}><Harness /></ServerEventsProvider>));
		await act(async () => side.open({ anchor: { kind: "composer" }, passage: { text: "Quoted actual prose.", sourceMessageId: "lesson", selector: { start: 0, end: 20, prefix: "", suffix: "" } } }));
		assert.equal(side.state!.segmentId, "work");
		await act(async () => { assert.equal(await side.ask("Clarify"), true); });
		const citation = collectCitations((requestBody!.quoteCitations as string[])[0]!)[0]!.citation;
		assert.equal(citation.messageId, "lesson"); assert.equal(citation.start, 0); assert.equal(citation.end, 20);
		await act(async () => { frame({ type: "thread", thread }); frame({ type: "text", text: "Older partial" }); });
		await act(async () => callbacks.get("side-chats-changed")!(JSON.stringify({ chatId: "chat_test" })));
		assert.equal(getCount, 2);
		await act(async () => frame({ type: "text", text: "New streamed tail" }));
		await act(async () => release(Response.json({ threads: [thread], answering: { side_work: "Older partial" } })));
		assert.equal(side.state!.streamText, "New streamed tail"); assert.equal(side.state!.answering, true);
		side.saveDraft(thread.id, "Saved old-step draft");
		messages.push({ id: "answer", role: "user", content: "Main answer", timestamp: 2 }, { ...fauxAssistantMessage("A new explanation"), id: "next" });
		await act(async () => side.expand());
		assert.equal(side.currentSegmentId, "next");
		assert.equal(side.state!.threadId, thread.id, "lesson progression never silently switches the open conversation");
		await act(async () => side.open({ sourceMessageId: side.currentSegmentId!, anchor: { kind: "composer" } }));
		assert.equal(side.state!.threadId, "side_next"); assert.equal(side.state!.mode, "panel");
		assert.equal(side.draftFor(thread.id), "Saved old-step draft"); assert.equal(side.draftFor("side_next"), "");
		await act(async () => frame({ type: "text", text: "OLD THREAD AFTER NAVIGATION" }));
		assert.equal(side.state!.streamText, ""); assert.deepEqual(side.state!.messages, []);
		await act(async () => { frame({ type: "done", thread }); writer.close(); });
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
});
