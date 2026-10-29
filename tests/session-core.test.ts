/**
 * SESSION MODEL tests (components/session-core.ts — Wave D): the pure state
 * machine that replaced useChat + the AI-SDK transport. Everything the old
 * transport/merge suites pinned survives here on the native wire:
 *
 * - the 409 IDENTITY-RETRY (postInputEvent): the event was never persisted
 *   pre-acceptance, so the retry waits out the racing turn and re-POSTs
 *   the SAME body — no merge, no record read;
 * - the reattach path (resumeStream): record refetch, then the SAME
 *   verbatim-AgentEvent consume as a POST; turn-settled is the terminal;
 *   byte-split SSE frames never corrupt (the framing pin);
 * - append-only ADOPTION (adoptRecord/absorbed): server-added steers show
 *   mid-turn, the record rewrite bails to the idle full sync, and the
 *   optimistic entries the write-ahead absorbed never double their
 *   bubbles;
 * - the view application (applyWireEvent → projectView): full-partial
 *   replaces, the fork-2 question-placeholder ignore, execution states,
 *   raw error display (owner ruling);
 * - the continuation fold (needsContinuation): the mount/sync seam's
 *   native replacement for lastAssistantMessageIsCompleteWithToolCalls.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { absorbed, pendingCallTool, SessionModel } from "../components/session-core.ts";
import type { ChatInput } from "../src/core/input-events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newUserMessage, newAnswerResult, newThinkingMessage, needsContinuation, endsInDismissal, pendingQuestionOf } from "../src/core/native-messages.ts";
import { endsInFailedTurn, newCompactionMarker, newPlanBlockMessage, projectView } from "../src/core/index.ts";
import { dismissedAnswer } from "../src/core/question-core.ts";
import { buildAnswer, type QuestionData } from "../src/core/question-core.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** SSE-frame each object the way the server's subscriber stream does. */
function sse(...events: unknown[]): string {
	return events.map((e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`)).join("");
}

/** A Response whose body drips `text` in `slice`-byte reads (the framing pin). */
function dripped(text: string, slice: number, status = 200): Response {
	const bytes = new TextEncoder().encode(text);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < bytes.length; i += slice) {
				controller.enqueue(bytes.slice(i, i + slice));
			}
			controller.close();
		},
	});
	return new Response(body, { status });
}

/** A plain single-read 200 body. */
function sseResponse(...events: unknown[]): Response {
	return new Response(sse(...events), { status: 200 });
}

/** CONNECTION DIET B mock (owner, 2026-10-10 — parallel-session freeze
 *  postmortem): send() no longer consumes the POST response — it acks,
 *  closes, and reattaches. The wire sequence a send drives: POST /api/chat
 *  (tiny JSON ack) → GET /api/chats/chat_x (record refetch — the
 *  write-ahead absorbs the optimistic bubble) → GET .../stream (the SSE
 *  wire). `userText` seeds the record's write-ahead user message; `post`
 *  overrides the ack (409/error-path tests keep their own scripts);
 *  `onPost` observes the POST body. */
function dietFetch(opts: {
	stream: () => Response;
	userText?: string;
	post?: () => Response;
	onPost?: (body: string) => void;
}): typeof globalThis.fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/chat") {
			if (opts.onPost && typeof init?.body === "string") opts.onPost(init.body);
			return opts.post?.() ?? Response.json({ ok: true });
		}
		if (url === "/api/chats/chat_x") {
			const messages =
				opts.userText === undefined ? [] : [{ id: "u1", role: "user", content: opts.userText, timestamp: 1 }];
			return Response.json({ messages });
		}
		if (url === "/api/chats/chat_x/stream") return opts.stream();
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
}

function assistantMsg(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
		timestamp: 0,
		provider: "openrouter",
		model: "test",
	} as unknown as LhMessage;
}

/** A streaming assistant partial (pi events carry the FULL partial — and
 * NO message.id: the id exists only once the server's persistTurn stamps
 * the record; the client tracks the in-flight message by slot). */
function partial(blocks: unknown[], stopReason?: string): Record<string, unknown> {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			content: blocks,
			...(stopReason ? { stopReason } : {}),
			usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
			provider: "openrouter",
			model: "test",
		},
		assistantMessageEvent: { type: "text", textDelta: "" },
	};
}

function model(opts: Partial<ConstructorParameters<typeof SessionModel>[0]> = {}): SessionModel {
	return new SessionModel({ chatId: "chat_x", initialMessages: [], ...opts });
}

// ─── the 409 identity-retry ────────────────────────────────────────────────

interface Call {
	url: string;
	body: string | undefined;
}

function installFetch(routes: {
	chatPOST: (call: Call, attempt: number) => Response;
	jobsGET?: (poll: number) => boolean;
}): Call[] {
	const calls: Call[] = [];
	let poll = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, body: init?.body as string | undefined });
		if (url === "/api/chat" && init?.method === "POST") {
			return routes.chatPOST(calls.at(-1)!, calls.filter((c) => c.url === "/api/chat").length);
		}
		if (url.startsWith("/api/jobs")) return Response.json({ turnInFlight: routes.jobsGET?.(++poll) ?? false });
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
	return calls;
}

describe("postInputEvent (the 409 identity-retry)", { skip: process.env.NO_SLOW ? true : undefined }, () => {
	it("the model's default fetch is RECEIVER-SAFE (the browser 'Illegal invocation' pin)", async () => {
		// The live empty-session bug (2026-09-26): storing globalThis.fetch
		// UNBOUND and calling it as this.fetch(...) throws "Illegal
		// invocation" in the browser (native fetch requires this === Window;
		// Node's undici doesn't care, so every test passed while the app was
		// dead). Pin the browser's receiver discipline with a strict stub.
		let receiverWasGlobal = false;
		globalThis.fetch = (function (this: unknown, ...args: Parameters<typeof fetch>) {
			if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
			receiverWasGlobal = true;
			return Promise.resolve(sseResponse("[DONE]"));
		}) as typeof fetch;
		const m = model(); // NO injected fetch — exercises the default wrapper
		const res = await m.postInputEvent({ type: "text", text: "hi" });
		assert.equal(res.status, 200);
		assert.ok(receiverWasGlobal, "the default wrapper calls fetch with the global receiver");
	});

	it("passes non-409 responses through untouched", async () => {
		const calls = installFetch({ chatPOST: () => new Response("stream", { status: 200 }) });
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		const res = await m.postInputEvent({ type: "text", text: "hi" });
		assert.equal(res.status, 200);
		assert.equal(calls.length, 1, "no polling, single call");
		assert.deepEqual(JSON.parse(calls[0]!.body!), { chatId: "chat_x", input: { type: "text", text: "hi" } });
	});

	it("waits out the turn, then re-POSTs the SAME event body (identity retry)", async () => {
		const event: ChatInput = { type: "text", text: "my question while the wake turn ran" };
		const calls = installFetch({
			chatPOST: (_c, n) => (n === 1 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
			jobsGET: (poll) => poll <= 1, // first poll: still running; second: done
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		const res = await m.postInputEvent(event);
		assert.equal(res.status, 200);
		const posts = calls.filter((c) => c.url === "/api/chat");
		assert.equal(posts.length, 2, "one 409, one retry");
		assert.equal(posts[1]!.body, posts[0]!.body, "the event body is byte-identical");
	});

	it("never reads the record — the event is the only payload", async () => {
		const calls = installFetch({
			chatPOST: (_c, n) => (n === 1 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		assert.equal((await m.postInputEvent({ type: "text", text: "q" })).status, 200);
		assert.equal(
			calls.filter((c) => c.url.startsWith("/api/chats/")).length,
			0,
			"the retry never reads the record — the server owns it",
		);
	});

	it("loops on repeated 409s, re-POSTing the same event each time", async () => {
		const event: ChatInput = { type: "answer", toolCallId: "call-1", answer: { correct: true } as never };
		const calls = installFetch({
			chatPOST: (_c, n) => (n <= 2 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		assert.equal((await m.postInputEvent(event)).status, 200);
		const posts = calls.filter((c) => c.url === "/api/chat");
		assert.equal(posts.length, 3);
		assert.ok(posts.every((c) => c.body === posts[0]!.body), "every attempt carries the same event");
	});

	it("gives up after the deadline and surfaces the last 409", async () => {
		const calls = installFetch({
			chatPOST: () => new Response("busy", { status: 409 }),
			jobsGET: () => true,
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		const res = await m.postInputEvent({ type: "text", text: "q" });
		assert.equal(res.status, 409);
		const polls = calls.filter((c) => c.url.startsWith("/api/jobs")).length;
		assert.ok(polls <= 15, `expected bounded polling (~10×10ms), got ${polls}`);
	});
});

// ─── send: optimistic appends + wire consumption ────────────────────────────

describe("send (one input event, verbatim consumption)", () => {
	it("optimistically appends the text, POSTs {chatId, input}, consumes to [DONE]", async () => {
		const posts: string[] = [];
		globalThis.fetch = dietFetch({
			onPost: (b) => posts.push(b),
			userText: "my topic", // the write-ahead the record refetch absorbs
			stream: () =>
				sseResponse(
					{ type: "agent_start" },
					{ type: "message_start", message: { role: "assistant", content: [] } },
					partial([{ type: "text", text: "hello there" }]),
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello there" }], stopReason: "stop" } },
					{ type: "agent_end", messages: [] },
					"[DONE]",
				),
		});

		const m = model();
		const pending = m.send({ type: "text", text: "my topic" });
		// The optimistic bubble is INSTANT (the instant-answer UX seam):
		assert.equal(m.getState().status, "submitted");
		assert.match((m.getState().nativeMessages.at(-1) as { id?: string }).id ?? "", /^c_/);
		assert.equal(m.getState().messages.at(-1)!.parts[0]!.text, "my topic");
		await pending;
		assert.deepEqual(JSON.parse(posts[0]!), { chatId: "chat_x", input: { type: "text", text: "my topic" } });
		assert.equal(m.getState().status, "ready");
		// The streamed assistant REPLACED through full partials (never deltas):
		const view = m.getState().messages;
		assert.equal(view.at(-1)!.role, "assistant");
		assert.equal(view.at(-1)!.parts.at(-1)!.text, "hello there");
	});

	it("N id-less updates replace the SAME tail slot (the per-chunk divider bug pin)", async () => {
		// pi's wire (captured live, 2026-09-26): message_start/update/end carry
		// AssistantMessages with NO id. The bug: minting a fresh id per event
		// made every message_update APPEND a full copy — the tail grew one
		// message per chunk, and projectView's step separators + thinking
		// blocks made the transcript fill with dividers mid-stream (cleaned up
		// only by the settle sync). The fix: the in-flight message is tracked
		// by slot; updates REPLACE it.
		let push: (e: unknown) => void = () => {};
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (e) => controller.enqueue(enc.encode(e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`));
			},
		});
		globalThis.fetch = dietFetch({ userText: "go", stream: () => new Response(body, { status: 200 }) });
		const m = model();
		const done = m.send({ type: "text", text: "go" });
		const settle = () => new Promise((r) => setTimeout(r, 0));

		push({ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } });
		for (const text of ["Hel", "Hello", "Hello wor", "Hello world"]) {
			push(partial([{ type: "thinking", thinking: "hmm" }, { type: "text", text }]));
			await settle();
		}
		// MID-STREAM: exactly ONE assistant message in the tail — never one
		// per chunk — carrying the LATEST partial (full snapshot, not deltas).
		const assistants = m.getState().nativeMessages.filter((x) => (x as { role?: string }).role === "assistant");
		assert.equal(assistants.length, 1, "one streaming message, replaced in place");
		assert.equal(m.getState().messages.at(-1)!.parts.filter((p) => p.type === "text").length, 1);
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "Hello world");
		// Stable id across updates → stable view-part keys (no per-chunk
		// remount of the whole transcript, mermaid included).
		const idMid = (assistants[0] as { id?: string }).id;
		assert.match(idMid ?? "", /^c_/, "client-minted slot id");

		push({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello world" }], stopReason: "stop" } });
		push({ type: "agent_end", messages: [] });
		push("[DONE]");
		await done;
		const final = m.getState().nativeMessages.filter((x) => (x as { role?: string }).role === "assistant");
		assert.equal(final.length, 1);
		assert.equal((final[0] as { id?: string }).id, idMid, "same slot through message_end");
	});

	it("a 503 refusal surfaces the RAW body text (parseModelsRefusal's contract)", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ code: "models_not_configured", missing: ["strong"] }), {
				status: 503,
			})) as typeof globalThis.fetch;
		const m = model();
		await m.send({ type: "text", text: "q" });
		const state = m.getState();
		assert.equal(state.status, "error");
		assert.equal(
			state.error!.message,
			JSON.stringify({ code: "models_not_configured", missing: ["strong"] }),
			"the banner carries the raw envelope — the refusal flow JSON-parses it",
		);
	});

	it("the optimistic answer result attaches to the pending quiz part at once", async () => {
		const quizCall = {
			id: "call-1",
			role: "assistant",
			content: [
				{ type: "text", text: "Q?" },
				{ type: "toolCall", id: "call-1", name: "quiz", arguments: { question: "Q?", choices: ["a", "b"] } },
			],
			stopReason: "toolUse",
			usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
			provider: "openrouter",
			model: "test",
			timestamp: 0,
		} as unknown as LhMessage;
		let postBody = "";
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === "/api/chat") {
				postBody = init?.body as string;
				return sseResponse("[DONE]");
			}
			throw new Error(`unexpected fetch: ${String(input)}`);
		}) as typeof globalThis.fetch;
		const m = model({ initialMessages: [newUserMessage("hi"), quizCall] });
		const pending = m.submitAnswer("quiz", "call-1", { correct: true } as never);
		// The dock's AnsweredCard state — before any server round-trip:
		const state = m.getState();
		const quizPart = state.messages
			.flatMap((v) => v.parts)
			.find((p) => p.type === "tool-quiz")!;
		assert.equal(quizPart.state, "output-available");
		assert.deepEqual(quizPart.output, { correct: true });
		await pending;
		assert.deepEqual(JSON.parse(postBody), {
			chatId: "chat_x",
			input: { type: "answer", toolCallId: "call-1", answer: { correct: true } },
		});
	});

	it("ignores the question placeholder's clean execution end (fork 2) and keeps errors", async () => {
		// The dock's mount gate keys on the part STATE the live execution
		// layer drives MID-STREAM: a clean question execution stays
		// input-available (the in-memory "Question posed" placeholder
		// never shows); an INVALID call is output-error and NEVER mounts
		// (the modal-realism crash pin).
		const enc = new TextEncoder();
		let push: (e: unknown) => void = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (e) => controller.enqueue(enc.encode(e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`));
			},
		});
		globalThis.fetch = dietFetch({ userText: "q", stream: () => new Response(body, { status: 200 }) });
		const m = model();
		const done = m.send({ type: "text", text: "q" });
		const settle = () => new Promise((r) => setTimeout(r, 0));
		push({
			type: "message_start",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "q1", name: "quiz", arguments: {} },
					{ type: "toolCall", id: "bad1", name: "quiz", arguments: {} },
				],
			},
		});
		await settle();
		push({ type: "tool_execution_end", toolCallId: "q1", toolName: "quiz", isError: false, result: { content: [{ type: "text", text: "Question posed" }], details: { placeholder: true } } });
		push({ type: "tool_execution_end", toolCallId: "bad1", toolName: "quiz", isError: true, result: { content: [{ type: "text", text: "correctAnswer does not match any option value" }], details: undefined } });
		await settle();
		const parts = m.getState().messages.flatMap((v) => v.parts).filter((p) => p.type === "tool-quiz");
		assert.equal(parts.length, 2);
		assert.equal(parts[0]!.state, "input-available", "the clean placeholder is IGNORED — the dock mounts on it");
		assert.equal(parts[1]!.state, "output-error");
		assert.equal(parts[1]!.errorText, "correctAnswer does not match any option value");
		// turn_end carries the placeholder as a toolResult MESSAGE (details:
		// null — tool-execute questionResult): it must not flip the part to
		// output-available either — the AnsweredCard would read .dismissed off
		// null and crash the whole render (the live crash, 2026-09-26).
		push({
			type: "turn_end",
			message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "toolUse" },
			toolResults: [
				{
				id: "tr_q1",
				role: "toolResult",
				toolCallId: "q1",
				toolName: "quiz",
				content: [{ type: "text", text: "Question posed — the turn ends here; the learner's graded answer arrives as this call's result." }],
				details: null,
				isError: false,
			} as never,
			],
		});
		await settle();
		const afterTurnEnd = m.getState().messages.flatMap((v) => v.parts).filter((p) => p.type === "tool-quiz");
		assert.equal(afterTurnEnd[0]!.state, "input-available", "the placeholder toolResult keeps the dock's mount state");
		assert.equal(afterTurnEnd[0]!.output, undefined, "no null output ever reaches the AnsweredCard");
		push({ type: "agent_end", messages: [] });
		push("[DONE]");
		await done;
	});

it("Wave C: markers injected mid-run (custom role, follow-up delivery) append to the tail by id", () => {
	// A never-settling fetch: the send only needs to flip the model into its
	// streaming status synchronously — its POST floats (never rejects) while
	// the injected wire events are asserted.
	const m = model({ fetch: () => new Promise<Response>(() => {}) });
	m.adoptRecord([
		{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never,
	] as never);
	void m.send({ type: "text", text: "hello" });

	// pi emits message_start + message_end for an injected follow-up marker
	// (no streaming partials) — both must UPSERT the same tail slot by id.
	const marker = {
		id: "steer_job_x_1",
		role: "custom",
		customType: "subagent-steer",
		content: "The research result arrived.",
		display: true,
		details: { jobId: "job_x", kind: "research" },
		timestamp: 2,
	};
	m.applyWireEvent({ type: "message_start", message: marker } as never);
	m.applyWireEvent({ type: "message_end", message: marker } as never);

	const state = m.getState();
	const ids = state.messages.map((v) => v.parts.length);
	assert.ok(state.messages.length >= 2, "the marker produced a view message");
	const tail = state.messages.at(-1)!;
	assert.equal(tail.role, "user", "a steer marker projects as a user-role view message");
	assert.ok(
		tail.parts.some((p) => p.type === "data-subagent-artifact"),
		"the marker renders its artifact part (SubagentSteerCard)",
	);

	// A re-delivery of the same id (message_end replay) must NOT duplicate.
	m.applyWireEvent({ type: "message_end", message: marker } as never);
	const again = m.getState();
	assert.equal(again.messages.length, state.messages.length, "same id upserts, never appends a second copy");
});

	it("a provider error rides VERBATIM (owner ruling) — no masking anywhere", async () => {
		globalThis.fetch = dietFetch({
			userText: "q",
			stream: () =>
				sseResponse(
					partial([{ type: "text", text: "" }]),
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "OpenRouter 429: rate limited" } },
					{ type: "agent_end", messages: [] },
					"[DONE]",
				),
		});
		const m = model();
		await m.send({ type: "text", text: "q" });
		assert.equal(m.getState().status, "ready");
		assert.equal(m.getState().error!.message, "OpenRouter 429: rate limited");
	});
});

// ─── provider failures: one marker-aware rule for live and saved records ────

describe("provider-error banner (live and saved)", () => {
	function failed(id = "failed", errorMessage: string | undefined = "Google 500: fixture failure"): LhMessage {
		return { ...assistantMsg(id, ""), content: [], stopReason: "error", errorMessage } as LhMessage;
	}

	it("restores an empty failed response on load and full sync without adding a transcript card", () => {
		const record = [newUserMessage("topic"), failed()];
		const m = model({ initialMessages: record });
		assert.equal(m.getState().error?.message, "Google 500: fixture failure");
		assert.equal(m.getState().status, "ready");
		assert.equal(m.readyRef, true, "a restored provider failure does not block retry");
		assert.deepEqual(m.getState().nativeMessages, record, "diagnostic history stays intact");
		assert.equal(m.getState().messages.length, 1, "only the user bubble, no permanent error card");
		const synced = model();
		synced.setMessages(record);
		assert.equal(synced.getState().error?.message, m.getState().error?.message);
		const adopted = model({ initialMessages: record.slice(0, 1) });
		adopted.adoptRecord(record);
		assert.equal(adopted.getState().error?.message, m.getState().error?.message);
	});

	it("uses the existing fallback wording when the saved failure has no error text", () => {
		const withoutText = { ...failed(), errorMessage: undefined } as LhMessage;
		assert.equal(model({ initialMessages: [withoutText] }).getState().error?.message, "An error occurred.");
		assert.equal(model().getState().error, null);
	});

	it("substantive later input/output supersedes the failure, including aborts", () => {
		const failure = failed();
		const later: LhMessage[] = [
			newUserMessage("retry"),
			assistantMsg("success", "Hello"),
			{ ...assistantMsg("aborted", ""), stopReason: "aborted", errorMessage: "Aborted" } as LhMessage,
			newThinkingMessage("problem", "my attempt"),
			resultMsg("call"),
		];
		for (const entry of later) {
			const m = model({ initialMessages: [failure] });
			m.applyWireEvent({ type: "message_end", message: failure });
			assert.ok(m.getState().error, "the live failure is initially visible");
			m.setMessages([failure, entry]);
			assert.equal(m.getState().error, null, `live banner superseded by ${entry.role}`);
			assert.equal(model({ initialMessages: [failure, entry] }).getState().error, null, "reopened view agrees");
		}
	});

	it("plan and compaction markers preserve the banner on sync, adoption and reopen", async () => {
		const failure = failed();
		const record = [newUserMessage("topic"), failure];
		const markers = [
			newPlanBlockMessage("plan", { kind: "full", nodes: [], edges: [], current: null }),
			newCompactionMarker("summary", { firstKeptMessageId: failure.id, tokensBefore: 100, model: "fixture", at: "2026-01-01T00:00:00Z" }),
		];
		for (const marker of markers) {
			const saved = [...record, marker];
			let posts = 0;
			const m = model({ initialMessages: record, fetch: async () => { posts++; throw new Error("unexpected request"); } });
			m.setMessages(saved);
			assert.equal(m.getState().error?.message, failure.role === "assistant" ? failure.errorMessage : undefined);
			assert.equal(model({ initialMessages: saved }).getState().error?.message, m.getState().error?.message);
			const adopted = model({ initialMessages: record });
			adopted.adoptRecord(saved);
			assert.equal(adopted.getState().error?.message, m.getState().error?.message);
			assert.equal(endsInFailedTurn(saved), marker.customType === "plan-block", "later compaction removes Retry eligibility, not the error notice");
			await m.continueIfOwed(saved);
			assert.equal(posts, 0, "restoring the banner is never an automatic retry");
			m.setMessages([...saved, newUserMessage("continue from here")]);
			assert.equal(m.getState().error, null, "new learner input supersedes the notice");
		}
	});

	it("a newer live message supersedes the failure before its response finishes", () => {
		const m = model();
		m.applyWireEvent({ type: "message_end", message: failed() });
		assert.ok(m.getState().error);
		m.applyWireEvent({ type: "message_start", message: assistantMsg("next", "") });
		assert.equal(m.getState().error, null);
		m.applyWireEvent({ type: "message_end", message: assistantMsg("next", "Hello") });
		assert.equal(m.getState().error, null);
	});

	it("does not treat an unfinished assistant's error-shaped partial as a completed failure", () => {
		const m = model();
		const failure = failed();
		m.applyWireEvent({ type: "message_start", message: failure });
		assert.equal(m.getState().error, null);
		m.applyWireEvent({ type: "message_update", message: failure });
		assert.equal(m.getState().error, null);
		m.applyWireEvent({ type: "message_end", message: failure });
		assert.equal(m.getState().error?.message, "Google 500: fixture failure");
	});

	for (const input of [{ type: "text", text: "retry" }, { type: "continue" }, { type: "retry" }] as const) {
		it(`hides the old failure during the optimistic ${input.type} wait, then shows a new live failure`, async () => {
			let acknowledge!: (response: Response) => void;
			const ack = new Promise<Response>((resolve) => { acknowledge = resolve; });
			const old = failed("old", "old failure");
			const fresh = failed("fresh", "new failure");
			let finish!: () => void;
			const stream = new ReadableStream<Uint8Array>({ start(controller) {
				finish = () => {
					controller.enqueue(new TextEncoder().encode(sse("[DONE]")));
					controller.close();
				};
			} });
			const m = model({ initialMessages: [old], fetch: async (url) => {
				if (url === "/api/chat") return ack;
				if (url === "/api/chats/chat_x") return Response.json({ messages: [old] });
				if (url === "/api/chats/chat_x/stream") return new Response(stream);
				throw new Error(`unexpected fetch: ${url}`);
			} });
			assert.equal(m.getState().error?.message, "old failure");
			const sending = m.send(input);
			assert.equal(m.getState().status, "submitted");
			assert.equal(m.getState().error, null, "hidden even before the acknowledgement");
			acknowledge(Response.json({ ok: true }));
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(m.getState().error, null, "refetching the old failed record does not resurrect it");
			m.applyWireEvent({ type: "message_start", message: fresh });
			assert.equal(m.getState().error, null, "no error from an unfinished partial");
			m.applyWireEvent({ type: "message_end", message: fresh });
			assert.equal(m.getState().status, "submitted");
			assert.equal(m.getState().error?.message, "new failure", "new failure appears before stream closure");
			finish();
			await sending;
			assert.equal(m.getState().error?.message, "new failure");
		});
	}

	it("hides the old failure immediately on fresh-mount reattach, and restores final-entry truth at idle", async () => {
		let settle!: (response: Response) => void;
		const response = new Promise<Response>((resolve) => { settle = resolve; });
		const m = model({ initialMessages: [failed()], fetch: async () => response });
		const attaching = m.resumeStream(false);
		assert.equal(m.getState().status, "submitted");
		assert.equal(m.getState().error, null);
		settle(sseResponse({ type: "turn-settled" }, "[DONE]"));
		await attaching;
		assert.equal(m.getState().error?.message, "Google 500: fixture failure", "no newer entry superseded it");
	});

	it("recovers a failure that settled before the submitter could attach to its stream", async () => {
		const record = [newUserMessage("topic"), failed()];
		const m = model({ fetch: async (url) => {
			if (url === "/api/chat") return Response.json({ ok: true });
			if (url === "/api/chats/chat_x") return Response.json({ messages: record });
			if (url === "/api/chats/chat_x/stream") return sseResponse({ type: "turn-settled" }, "[DONE]");
			throw new Error(`unexpected fetch: ${url}`);
		} });
		m.setReattachSettled(() => m.setMessages(record));
		await m.send({ type: "text", text: "topic" });
		assert.equal(m.getState().status, "ready");
		assert.equal(m.getState().error?.message, "Google 500: fixture failure");
	});

	it("a newer live provider failure replaces an earlier attachment error immediately", async () => {
		let attempts = 0;
		const seen: Array<{ status: string; error: string | undefined }> = [];
		const m = model({ fetch: async () => {
			if (++attempts === 1) return new Response("earlier attach failure", { status: 500 });
			return sseResponse(
				{ type: "message_start", message: failed("new", "new provider failure") },
				{ type: "message_end", message: failed("new", "new provider failure") },
				"[DONE]",
			);
		} });
		await m.resumeStream(false);
		assert.equal(m.getState().error?.message, "earlier attach failure");
		m.onChange = () => { seen.push({ status: m.status, error: m.getState().error?.message }); };
		await m.resumeStream(false);
		assert.ok(seen.some((s) => s.status === "streaming" && s.error === "new provider failure"), "new failure wins before stream closure");
		assert.equal(m.getState().error?.message, "new provider failure");
		assert.equal(model({ initialMessages: m.getState().nativeMessages }).getState().error?.message, "new provider failure", "live and reopened views agree");
	});

	it("an aborted older consume cannot restore the old banner during a replacement reattach", async () => {
		let attempts = 0;
		let firstRead!: () => void;
		const reading = new Promise<void>((resolve) => { firstRead = resolve; });
		let settleReplacement!: (response: Response) => void;
		const replacement = new Promise<Response>((resolve) => { settleReplacement = resolve; });
		const m = model({ initialMessages: [failed()], fetch: async (_url, init) => {
			if (++attempts > 1) return replacement;
			return new Response(new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(sse({ type: "agent_start" })));
					init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
				},
				pull() { firstRead(); },
			}));
		} });
		const first = m.resumeStream(false);
		await reading;
		const second = m.resumeStream(false);
		await first;
		assert.equal(m.getState().status, "submitted", "old cleanup must not settle the replacement attempt");
		assert.equal(m.getState().error, null, "old saved failure stays hidden during the replacement's Thinking wait");
		settleReplacement(sseResponse(
			{ type: "message_start", message: failed("new", "replacement failure") },
			{ type: "message_end", message: failed("new", "replacement failure") },
			"[DONE]",
		));
		await second;
		assert.equal(m.getState().error?.message, "replacement failure");
	});

	it("keeps loop/request errors transient, with the existing precedence and clearError behavior", async () => {
		const m = model({ initialMessages: [failed()] });
		m.applyWireEvent({ type: "error", errorText: "loop failure" });
		assert.equal(m.getState().error?.message, "loop failure");
		assert.equal(model({ initialMessages: m.getState().nativeMessages }).getState().error?.message, "Google 500: fixture failure");
		m.clearError();
		assert.equal(m.getState().error?.message, "Google 500: fixture failure");
		m.fetch = async () => new Response("request refused", { status: 500 });
		await m.send({ type: "text", text: "retry" });
		assert.equal(m.getState().error?.message, "request refused");
		assert.equal(model({ initialMessages: m.getState().nativeMessages }).getState().error, null, "request errors are not fabricated as saved messages");
		m.clearError();
		assert.equal(m.getState().error, null);
	});
});

describe("truncated stream recovery", () => {
	const truncated = () => sseResponse({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
	const completed = () => sseResponse({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "complete" }] } }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "complete" }], stopReason: "stop" } }, "[DONE]");

	it("reattaches once after EOF without DONE and replaces the incomplete replay", async () => {
		let streams = 0;
		const m = model({ fetch: dietFetch({ userText: "go", stream: () => ++streams === 1 ? truncated() : completed() }) });
		await m.send({ type: "text", text: "go" });
		assert.equal(streams, 2);
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error, null);
		assert.equal(m.getState().nativeMessages.filter(m => m.role === "assistant").length, 1);
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "complete");
	});

	it("surfaces an error after a second truncation without retrying the input", async () => {
		let streams = 0;
		let posts = 0;
		const m = model({ fetch: dietFetch({ onPost: () => posts++, stream: () => { streams++; return truncated(); } }) });
		await m.send({ type: "text", text: "go" });
		assert.equal(posts, 1);
		assert.equal(streams, 2);
		assert.equal(m.status, "error");
		assert.equal(m.getState().error?.message, "The connection dropped before the turn completed.");
	});

	it("reports the approved connection error when the recovery record read fails", async () => {
		let reads = 0;
		const m = model({ fetch: async (url) => {
			if (String(url) === "/api/chat") return Response.json({ ok: true });
			if (String(url).endsWith("/stream")) return truncated();
			if (++reads === 1) return Response.json({ messages: [] });
			throw new TypeError("synthetic offline");
		} });
		await m.send({ type: "text", text: "go" });
		assert.equal(m.status, "error");
		assert.equal(m.getState().error?.message, "The connection dropped before the turn completed.");
	});

	it("accepts turn-settled when the original turn finished during the disconnection", async () => {
		let streams = 0;
		let settled = 0;
		const m = model({ onReattachSettled: () => { settled++; }, fetch: dietFetch({ stream: () => ++streams === 1 ? truncated() : sseResponse({ type: "turn-settled" }, "[DONE]") }) });
		await m.send({ type: "text", text: "go" });
		assert.equal(streams, 2);
		assert.equal(settled, 1);
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error, null);
	});

	it("also recovers a rejected body read but does not relabel event-application bugs", async () => {
		let streams = 0;
		const m = model({ fetch: dietFetch({ stream: () => ++streams === 1 ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("synthetic read failure")); } })) : completed() }) });
		await m.send({ type: "text", text: "go" });
		assert.equal(streams, 2);
		assert.equal(m.status, "ready");
		streams = 0;
		const broken = model({ fetch: dietFetch({ stream: () => { streams++; return completed(); } }) });
		broken.applyWireEvent = () => { throw new Error("synthetic event application bug"); };
		await broken.send({ type: "text", text: "go" });
		assert.equal(streams, 1);
		assert.equal(broken.getState().error?.message, "synthetic event application bug");
	});

	it("recovers an AbortError body rejection unless the view was actually cancelled", async () => {
		let streams = 0;
		const m = model({ fetch: dietFetch({ stream: () => ++streams === 1 ? new Response(new ReadableStream({
			start(controller) { controller.error(new DOMException("synthetic unexpected read abort", "AbortError")); },
		})) : completed() }) });
		await m.send({ type: "text", text: "go" });
		assert.equal(streams, 2);
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error, null);
	});

	it("uses the approved drop message when recovery record headers arrive but its body read fails", async () => {
		let reads = 0;
		const m = model({ fetch: async (url) => {
			if (String(url) === "/api/chat") return Response.json({ ok: true });
			if (String(url).endsWith("/stream")) return truncated();
			if (++reads === 1) return Response.json({ messages: [] });
			return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("synthetic record-body transport failure")); } }));
		} });
		await m.send({ type: "text", text: "go" });
		assert.equal(m.status, "error");
		assert.equal(m.getState().error?.message, "The connection dropped before the turn completed.");
	});

	it("preserves malformed-event diagnostics rather than calling them network drops", async () => {
		let streams = 0;
		const m = model({ fetch: dietFetch({ stream: () => { streams++; return new Response("data: {broken}\n\n"); } }) });
		await m.send({ type: "text", text: "go" });
		assert.equal(streams, 1);
		assert.equal(m.status, "error");
		assert.notEqual(m.getState().error?.message, "The connection dropped before the turn completed.");
		assert.match(m.getState().error!.message, /JSON|property name/);
	});

	it("reports a failed recovery stream request without attempting a third attachment", async () => {
		let streams = 0;
		const m = model({ fetch: dietFetch({ stream: () => ++streams === 1 ? truncated() : new Response("synthetic unavailable", { status: 503 }) }) });
		await m.send({ type: "text", text: "go" });
		assert.equal(streams, 2);
		assert.equal(m.status, "error");
		assert.equal(m.getState().error?.message, "The connection dropped before the turn completed.");
	});

	it("a superseded consume cannot recover or overwrite its replacement's state", async () => {
		let streams = 0;
		let closeFirst!: () => void;
		let beganReading!: () => void;
		const reading = new Promise<void>(resolve => { beganReading = resolve; });
		const m = model({ fetch: dietFetch({ stream: () => ++streams === 1 ? new Response(new ReadableStream({
			start(controller) { closeFirst = () => controller.close(); },
			pull() { beganReading(); },
		}, { highWaterMark: 0 })) : completed() }) });
		const first = m.resumeStream(false);
		await reading;
		await m.resumeStream(false);
		closeFirst();
		await first;
		assert.equal(streams, 2);
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error, null);
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "complete");
	});
});

describe("automatic continuation after recovery failure", () => {
	const question = { ...assistantMsg("question", ""), content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "Q?" } }] } as LhMessage;
	const answer = buildAnswer({ id: "q1", kind: "quiz", question: "Q?", mode: "single-select", options: [], createdAt: "fixture" }, { dontKnow: true });
	const answered = [question, newAnswerResult("q1", "quiz", answer)];

	it("a retained failure seeds the banner and blocks continuation even after banner dismissal", async () => {
		let posts = 0;
		const m = model({ initialMessages: answered, initialError: "The reply could not be saved.", fetch: dietFetch({ onPost: () => posts++, stream: () => sseResponse("[DONE]") }) });
		assert.equal(SessionModel.needsContinuation(answered), true);
		assert.equal(m.getState().error?.message, "The reply could not be saved.");
		await m.continueIfOwed(answered);
		assert.equal(posts, 0);
		m.clearError();
		await m.continueIfOwed(answered);
		assert.equal(posts, 0, "closing the banner is not permission to retry the model");
		await m.send({ type: "text", text: "explicit learner input" });
		assert.equal(posts, 1);
		assert.equal(m.getState().error, null);
	});

	it("a new server-owned turn clears the retained banner without releasing Thinking", () => {
		const m = model({ initialMessages: answered, initialError: "The reply could not be saved." });
		assert.equal(m.getState().error?.message, "The reply could not be saved.");
		assert.equal(m.applyWireEvent({ type: "agent_start" }), false);
		assert.equal(m.getState().error, null, "positive new-turn evidence replaces the old transient notice");
	});

	it("a live failed save cannot auto-continue the accepted answer during canonical sync", async () => {
		let posts = 0;
		const m = model({ initialMessages: answered, fetch: dietFetch({ onPost: () => posts++, stream: () => sseResponse("[DONE]") }) });
		m.applyWireEvent({ type: "error", errorText: "The reply could not be saved." });
		m.setMessages(answered);
		await m.continueIfOwed(answered);
		assert.equal(posts, 0);
	});

	it("a healthy owed continuation still starts once through the normal send gate", async () => {
		let posts = 0;
		const m = model({ initialMessages: answered, fetch: dietFetch({ onPost: () => posts++, stream: () => sseResponse("[DONE]") }) });
		await m.continueIfOwed(answered);
		assert.equal(posts, 1);
	});
});

// ─── failed answer submissions (no replay without canonical reconciliation) ──

describe("answer submission recovery", () => {
	const question = {
		...assistantMsg("question", "Q?"),
		content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "Q?" } }],
	} as LhMessage;
	const answer = buildAnswer({ id: "q1", kind: "quiz", question: "Q?", mode: "single-select", options: [], createdAt: "fixture" }, { dontKnow: true, thinking: "keep my reasoning" });

	it("restores the question after a failed POST and checks the record before another POST", async () => {
		const calls: string[] = [];
		let posts = 0;
		const m = model({ initialMessages: [question], fetch: async (url) => {
			calls.push(String(url));
			if (String(url) === "/api/chat") {
				posts++;
				return posts === 1 ? new Response("request refused", { status: 500 }) : Response.json({ ok: true });
			}
			if (String(url).endsWith("/stream")) return sseResponse("[DONE]");
			return Response.json({ messages: [question], turnInFlight: false });
		} });
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(m.getState().messages[0]!.parts.find(p => p.toolCallId === "q1")!.state, "input-available");
		assert.equal(m.status, "error");
		m.clearError(); // dismissing the banner must not disable recovery
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(posts, 2, "error must not permanently close the send gate");
		assert.deepEqual(calls.slice(0, 3), ["/api/chat", "/api/chats/chat_x", "/api/chat"]);
	});

	it("retains all submitted draft channels until the canonical answer resolves the call", async () => {
		const form = { selection: { selected: new Set([1]), otherSelected: true, dontKnow: false }, thinking: "reasoning", other: "custom answer", text: "free text", confidenceIndex: 4 };
		const m = model({ initialMessages: [question], fetch: async () => { throw new TypeError("offline"); } });
		m.saveQuestionDraft("q1", { form });
		m.saveQuestionDraft("q1", { readingThinking: "reading reasoning" });
		await m.submitAnswer("quiz", "q1", answer);
		assert.deepEqual(m.questionDraft("q1"), { form, readingThinking: "reading reasoning" });
		m.setMessages([question]);
		assert.deepEqual(m.questionDraft("q1"), { form, readingThinking: "reading reasoning" });
		assert.equal(m.questionDraft("q2"), undefined, "a different question never inherits the draft");
		m.adoptRecord([question, newAnswerResult("q1", "quiz", answer)]);
		assert.equal(m.questionDraft("q1"), undefined, "only confirmed native resolution clears it");
	});

	it("a final 409 restores the question instead of leaving an optimistic answer", async () => {
		const m = model({ initialMessages: [question], waitMaxMs: 0, fetch: async () => new Response("busy", { status: 409 }) });
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(m.getState().nativeMessages.length, 1);
		assert.equal(m.status, "error");
	});

	it("does not repost an answer whose acceptance acknowledgement was lost", async () => {
		let posts = 0;
		const saved = JSON.parse(JSON.stringify([question, newAnswerResult("q1", "quiz", answer)])) as LhMessage[];
		const m = model({ initialMessages: [question], fetch: async (url) => {
			if (String(url) === "/api/chat") { posts++; throw new TypeError("failed fetch"); }
			return Response.json({ messages: saved, turnInFlight: false });
		} });
		await m.submitAnswer("quiz", "q1", answer);
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(posts, 1);
		assert.equal(m.status, "ready");
		assert.deepEqual(m.getState().nativeMessages, saved);
	});

	it("reattaches to an accepted running turn instead of posting another answer", async () => {
		const calls: string[] = [];
		const m = model({ initialMessages: [question], fetch: async (url) => {
			calls.push(String(url));
			if (String(url) === "/api/chat") throw new TypeError("failed fetch");
			if (String(url).endsWith("/stream")) return sseResponse("[DONE]");
			return Response.json({ messages: [question, newAnswerResult("q1", "quiz", answer)], turnInFlight: true });
		} });
		await m.submitAnswer("quiz", "q1", answer);
		await m.submitAnswer("quiz", "q1", answer);
		assert.deepEqual(calls, ["/api/chat", "/api/chats/chat_x", "/api/chats/chat_x/stream"]);
		assert.equal(m.status, "ready");
	});

	it("keeps the question and makes no further POST while reconciliation is unreachable", async () => {
		const calls: string[] = [];
		const m = model({ initialMessages: [question], fetch: async (url) => { calls.push(String(url)); throw new TypeError("offline"); } });
		await m.submitAnswer("quiz", "q1", answer);
		await m.submitAnswer("quiz", "q1", answer);
		assert.deepEqual(calls, ["/api/chat", "/api/chats/chat_x"]);
		assert.equal(m.status, "error");
		assert.equal(m.getState().nativeMessages.some(m => m.role === "toolResult"), false);
	});

	it("does not undo an acknowledged dismissal when an unrelated send's record read fails", async () => {
		const m = model({ initialMessages: [question], fetch: async (url) => {
			if (String(url).endsWith("/dismiss") || String(url) === "/api/chat") return Response.json({ ok: true });
			throw new TypeError("record read failed");
		} });
		await m.dismissQuestion("q1", dismissedAnswer("quiz", "Q?"));
		await m.send({ type: "text", text: "move on" });
		assert.equal(m.status, "error");
		const part = m.getState().messages.flatMap(m => m.parts).find(p => p.toolCallId === "q1")!;
		assert.equal(part.state, "output-available");
		assert.equal((part.output as { dismissed: boolean }).dismissed, true);
	});

	it("restores an unconfirmed optimistic answer when the post-ack record read fails", async () => {
		let posts = 0;
		let reads = 0;
		const saved = JSON.parse(JSON.stringify([question, newAnswerResult("q1", "quiz", answer)])) as LhMessage[];
		const m = model({ initialMessages: [question], fetch: async (url) => {
			if (String(url) === "/api/chat") { posts++; return Response.json({ ok: true }); }
			if (++reads === 1) throw new TypeError("record read failed");
			return Response.json({ messages: saved, turnInFlight: false });
		} });
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(m.status, "error");
		assert.equal(m.getState().nativeMessages.some(m => m.role === "toolResult"), false);
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(posts, 1, "the acknowledged answer must not be reposted");
		assert.equal(m.status, "ready");
		assert.deepEqual(m.getState().nativeMessages, saved);
	});

	for (const next of [{ type: "text", text: "a distinct new message" }, { type: "thinking", problemCallId: "problem1", text: "new practice thinking" }] as const) {
		it(`preserves the existing POST/409-wait path for a new ${next.type} submission after an error`, async () => {
			const posted: ChatInput[] = [];
			const m = model({ pollMs: 0, fetch: async (url, init) => {
				if (String(url) === "/api/chat") {
					posted.push(JSON.parse(String(init?.body)).input);
					if (posted.length === 1) throw new TypeError("failed fetch");
					if (posted.length === 2) return new Response("busy", { status: 409 });
					return Response.json({ ok: true });
				}
				if (String(url).startsWith("/api/jobs")) return Response.json({ turnInFlight: false });
				if (String(url).endsWith("/stream")) return sseResponse("[DONE]");
				return Response.json({ messages: [], turnInFlight: true });
			} });
			await m.send({ type: "text", text: "original input" });
			await m.send(next);
			assert.deepEqual(posted, [{ type: "text", text: "original input" }, next, next]);
			assert.equal(m.status, "ready");
		});
	}

	it("accepts immediate/recovery submissions and dismissals while a live question placeholder is in the tail", async () => {
		for (const dismiss of [false, true]) {
			let posts = 0;
			const m = model({ initialMessages: [question], fetch: async (url) => {
				if (String(url) === "/api/chat" || String(url).endsWith("/dismiss")) {
					posts++;
					return new Response("refused", { status: 500 });
				}
				return Response.json({ messages: [question], turnInFlight: false });
			} });
			m.applyWireEvent({ type: "turn_end", message: question, toolResults: [{ role: "toolResult", toolCallId: "q1", toolName: "quiz",
				content: [{ type: "text", text: "Question posed" }], details: null, isError: false, timestamp: 1 }] });
			const key = pendingQuestionOf([question])!.key;
			if (dismiss) await m.dismissQuestion("q1", answer, key);
			else {
				await m.submitAnswer("quiz", "q1", answer, key);
				await m.submitAnswer("quiz", "q1", answer, key);
			}
			assert.equal(posts, dismiss ? 1 : 2, "placeholder must not reject the render's question identity");
		}
	});

	it("does not mistake an old same-id answer for resolution of the current question during recovery", async () => {
		let posts = 0;
		const newer = { ...question, id: "new-question" } as LhMessage;
		const record = [question, newAnswerResult("q1", "quiz", answer), newer];
		const m = model({ initialMessages: record, fetch: async (url) => {
			if (String(url) === "/api/chat") { posts++; return new Response("refused", { status: 500 }); }
			return Response.json({ messages: record, turnInFlight: false });
		} });
		const key = pendingQuestionOf(record)!.key;
		m.saveQuestionDraft(key, { readingThinking: "NEW reasoning" });
		await m.submitAnswer("quiz", "q1", answer, key);
		await m.submitAnswer("quiz", "q1", answer, key);
		assert.equal(posts, 2, "an older occurrence's result does not forbid retrying this one");
		assert.equal(m.questionDraft(key)?.readingThinking, "NEW reasoning");
		m.setMessages([...record, newAnswerResult("q1", "quiz", answer)]);
		assert.equal(m.questionDraft(key), undefined);
	});

	it("adopts a newer same-id occurrence instead of reposting an older question's answer", async () => {
		let posts = 0;
		const newer = { ...question, id: "new-question" } as LhMessage;
		const m = model({ initialMessages: [question], fetch: async (url) => {
			if (String(url) === "/api/chat") { posts++; throw new TypeError("offline"); }
			return Response.json({ messages: [question, newer], turnInFlight: false });
		} });
		const key = pendingQuestionOf([question])!.key;
		await m.submitAnswer("quiz", "q1", answer, key);
		await m.submitAnswer("quiz", "q1", answer, key);
		assert.equal(posts, 1);
		assert.equal(m.status, "ready");
		assert.equal(pendingQuestionOf(m.getState().nativeMessages)?.messageId, "new-question");
	});

	it("rejects stale render callbacks locally, including same-id silent dismissals", async () => {
		let requests = 0;
		const m = model({ initialMessages: [question], fetch: async () => { requests++; return Response.json({ ok: true }); } });
		const oldKey = pendingQuestionOf([question])!.key;
		const newer = { ...question, id: "new-question" } as LhMessage;
		m.setMessages([question, newer]);
		await m.submitAnswer("quiz", "q1", answer, oldKey);
		await m.dismissQuestion("q1", answer, oldKey);
		assert.equal(requests, 0);
		assert.equal(m.getState().nativeMessages.length, 2, "no optimistic answer targets the newer question");
	});

	it("uses the newest occurrence's tool for optimistic answers and dismissals", async () => {
		const older = { ...question, id: "old-ask", content: [{ type: "toolCall", id: "q1", name: "ask_user_question", arguments: {} }] } as LhMessage;
		for (const dismiss of [false, true]) {
			const m = model({ initialMessages: [older, question], fetch: async () => { throw new TypeError("offline"); } });
			const key = pendingQuestionOf([older, question])!.key;
			let optimisticTool: string | undefined;
			m.onChange = () => {
				const result = m.getState().nativeMessages.find(m => m.role === "toolResult");
				if (result?.role === "toolResult") optimisticTool = result.toolName;
			};
			if (dismiss) await m.dismissQuestion("q1", answer, key);
			else await m.submitAnswer("quiz", "q1", answer, key);
			assert.equal(optimisticTool, "quiz");
		}
	});

	it("does not leak drafts between same-id questions, and preserves unique-id live handover", () => {
		const m = model({ initialMessages: [question] });
		const oldKey = pendingQuestionOf([question])!.key;
		m.saveQuestionDraft(oldKey, { readingThinking: "old reasoning" });
		const newer = { ...question, id: "new-question" } as LhMessage;
		m.setMessages([question, newer]);
		const newKey = pendingQuestionOf([question, newer])!.key;
		assert.notEqual(oldKey, newKey);
		assert.equal(m.questionDraft(newKey), undefined);
		assert.equal(m.questionDraft(oldKey), undefined);

		const live = { ...question, id: "c_live" };
		m.setMessages([live]);
		const liveKey = pendingQuestionOf([live])!.key;
		m.saveQuestionDraft(liveKey, { readingThinking: "live reasoning" });
		m.setMessages([question]);
		assert.equal(m.questionDraft(pendingQuestionOf([question])!.key)?.readingThinking, "live reasoning");
	});

	it("adopts a changed pending question instead of sending the stale answer", async () => {
		let posts = 0;
		const newer = { ...question, id: "new-question", content: [{ type: "toolCall", id: "q2", name: "quiz", arguments: {} }] } as LhMessage;
		const m = model({ initialMessages: [question], fetch: async (url) => {
			if (String(url) === "/api/chat") { posts++; throw new TypeError("failed fetch"); }
			return Response.json({ messages: [question, newer], turnInFlight: false });
		} });
		await m.submitAnswer("quiz", "q1", answer);
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(posts, 1);
		assert.deepEqual(m.getState().nativeMessages, [question, newer]);
		assert.equal(m.status, "ready");
	});
});

// ─── reattach (resumeStream) ────────────────────────────────────────────────

describe("resumeStream (the reattach path)", () => {
	it("refetches the record, then GETs the stream endpoint", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/chats/chat_x") return Response.json({ messages: [] });
			if (url === "/api/chats/chat_x/stream")
				return dripped(sse({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }, "[DONE]"), 8);
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		await m.resumeStream();
		assert.deepEqual(urls, ["/api/chats/chat_x", "/api/chats/chat_x/stream"]);
		assert.equal(m.getState().status, "ready");
	});

	it("ATTACH-FIRST (owner, reattach round 2026-10-02): a fresh-mount reattach skips the blocking record refetch", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/chats/chat_x/stream")
				return sseResponse(
					{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" } },
					{ type: "agent_end", messages: [] },
					"[DONE]",
				);
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		await m.resumeStream(false);
		// one round-trip: straight to the stream — the page render already
		// read the record; the replay rebuilds the partial regardless.
		assert.deepEqual(urls, ["/api/chats/chat_x/stream"]);
		assert.equal(m.getState().status, "ready");
		// the mid-session caller (handoff watch) keeps the default refetch
		// (the earlier test in this block pins that order).
	});

	it("OPTIMISTIC SUBMIT (owner, optimistic round 2026-10-02): send flips status synchronously — the placeholder is live before the server answers anything", async () => {
		let release!: (r: Response) => void;
		const gate = new Promise<Response>((res) => (release = res));
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x") return gate; // the POST hangs
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		// send() runs synchronously to its first await — status is already
		// "submitted" (and the optimistic user bubble is appended) before
		// the server has answered ANYTHING.
		const p = m.send({ type: "text", text: "q" });
		assert.equal(m.getState().status, "submitted", "the placeholder is live pre-first-chunk");
		assert.equal(m.getState().messages.at(-1)!.role, "user", "the optimistic bubble is up");
		release(Response.json({ messages: [] }));
		await p;
		// the reattach path is the same synchronous flip (resumeStream sets
		// submitted at entry, before its fetches).
	});

	it("PROTOCOL EVENTS RELEASE NOTHING (owner, optimistic round 3): agent_start keeps the placeholder; the first APPLIED event flips streaming", async () => {
		// The round-2 bug chain, fixed at the machine: status used to flip
		// streaming at the first wire BYTE (agent_start, emitted before the
		// provider has produced anything), vanishing the placeholder into an
		// empty wait. Now the flip waits for an event applyWireEvent ACTS
		// on — the placeholder (gated on submitted) covers the whole
		// provider-connect gap, and the applied event's message renders the
		// thinking row even when its content is empty (view.ts projection).
		let releaseProtocol!: () => void;
		let releaseRest!: () => void;
		const protocolGate = new Promise<void>((res) => (releaseProtocol = res));
		const restGate = new Promise<void>((res) => (releaseRest = res));
		const body = new ReadableStream<Uint8Array>({
			async start(c) {
				const enc = new TextEncoder();
				c.enqueue(enc.encode(sse({ type: "agent_start" }, { type: "turn_start" })));
				await protocolGate; // the provider is slow — nothing but protocol so far
				c.enqueue(enc.encode(sse({ type: "message_start", message: { role: "assistant", content: [] } })));
				await restGate; // the message arrived; its first token is still pending
				c.enqueue(
					enc.encode(
						sse({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] } }),
					),
				);
				c.enqueue(enc.encode(sse({ type: "agent_end", messages: [] }, "[DONE]")));
				c.close();
			},
		});
		globalThis.fetch = dietFetch({ userText: "q", stream: () => new Response(body) });
		const m = model();
		const p = m.send({ type: "text", text: "q" });
		assert.equal(m.getState().status, "submitted", "the action is optimistic: placeholder up pre-everything");
		await new Promise((r) => setTimeout(r, 25)); // agent_start + turn_start consumed
		assert.equal(
			m.getState().status,
			"submitted",
			"protocol events apply NOTHING — the placeholder holds through the connect gap",
		);
		releaseProtocol();
		await new Promise((r) => setTimeout(r, 25)); // message_start consumed
		assert.equal(m.getState().status, "streaming", "the first APPLIED event flips streaming — the thinking row renders");
		releaseRest();
		await p;
		assert.equal(m.getState().status, "ready");
	});

	it("SESSION START SURVIVES A STOP() RACING THE SUBMIT (owner, 2026-10-10 — the dead-practice-start postmortem)", async () => {
		// React StrictMode's simulated remount fires the unmount cleanup
		// (~8ms in) while the ?prompt first send's POST is in flight — the
		// exact live repro: pre-fix, the POST rode consumeAbort and died
		// with AbortError, the page's sentInitial guard never retried, and
		// the session sat dead until a second message (which then persisted
		// WITHOUT the first). The law: submits are not abortable by view
		// teardown — the POST completes, the turn is server-side, and the
		// dead view attaches no stream.
		let resolvePost!: () => void;
		let postAborted = false;
		const fetches: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			fetches.push(url);
			if (url === "/api/chat") {
				init?.signal?.addEventListener("abort", () => {
					 postAborted = true;
				});
				await new Promise<void>((r) => {
					 resolvePost = () => r();
				});
				return Response.json({ ok: true });
			}
			if (url === "/api/chats/chat_x") {
				return Response.json({ messages: [{ id: "u1", role: "user", content: "quiz me", timestamp: 1 }] });
			}
			if (url === "/api/chats/chat_x/stream") return new Response("data: [DONE]\n\n", { status: 200 });
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		const sending = m.send({ type: "text", text: "quiz me" });
		await new Promise((r) => setTimeout(r, 5)); // the POST is in flight
		m.stop(); // StrictMode's simulated unmount lands mid-submit
		resolvePost(); // the ack completes anyway
		await sending;
		assert.equal(postAborted, false, "the submit POST carries no teardown signal at all");
		assert.ok(fetches.includes("/api/chat"), "the submit reached the server");
		assert.ok(!fetches.some((u) => u.endsWith("/stream")), "a dead view attaches no stream — the turn is server-side");
		assert.equal(m.getState().status, "ready");
	});

	it("REATTACH REPLAYS ONTO A CLEAN SLATE (owner, optimistic round 3): an aborted attempt's partials never double", async () => {
		// StrictMode's simulated remount aborts the first resume mid-replay;
		// its partial tail survived into the retry and the replay DOUBLED
		// every message (the record refetch's accidental tail reset died
		// with attach-first). resumeStream now wipes the tail itself.
		let hold!: () => void;
		const holdGate = new Promise<void>((res) => (hold = res));
		let calls = 0;
		const enc = new TextEncoder();
		const replay = () => {
			calls++;
			if (calls === 1)
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(c) {
							c.enqueue(
								enc.encode(
									sse({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "part one" }] } }),
								),
							);
							await holdGate; // aborted here (the partial stays in the tail)
							c.enqueue(enc.encode(sse({ type: "agent_end", messages: [] }, "[DONE]")));
							c.close();
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			return new Response(
				new ReadableStream<Uint8Array>({
					async start(c) {
						c.enqueue(
							enc.encode(
								sse(
									{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "part one" }] } },
									{ type: "agent_end", messages: [] },
									"[DONE]",
								),
							),
						);
						c.close();
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		};
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x/stream") return replay();
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		const attempt1 = m.resumeStream(false);
		await new Promise((r) => setTimeout(r, 25)); // attempt 1 consumed its partial
		// the simulated remount: attempt 2 aborts attempt 1 mid-replay
		const attempt2 = m.resumeStream(false);
		hold(); // attempt 1's gate resolves after it was already aborted
		await Promise.allSettled([attempt1, attempt2]);
		const texts = m
			.getState()
			.messages.flatMap((msg) => msg.parts.filter((p) => p.type === "text").map((p) => (p as { text?: string }).text));
		assert.deepEqual(texts, ["part one"], "the replayed turn appears exactly ONCE — no doubles");
	});

	it("turn-settled fires the settle hook and ends cleanly", async () => {
		let settled = 0;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x") return Response.json({ messages: [] });
			if (url === "/api/chats/chat_x/stream") return dripped(sse({ type: "turn-settled" }, "[DONE]"), 8);
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model({ onReattachSettled: () => settled++ });
		await m.resumeStream();
		assert.equal(settled, 1);
		assert.equal(m.getState().status, "ready");
		assert.equal(m.getState().error, null);
	});

	it("a replayed CONTINUATION mounts BESIDE the seeded message (the SDK replace-last seam is dead)", async () => {
		// The seeded record ends with an assistant message; the replayed
		// turn continues with its OWN assistant message — the view groups
		// them as one document with a step separator (pixel-identical to a
		// live continuation; the settle sync lands the canon).
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x") return Response.json({ messages: [assistantMsg("seed", "the question")] });
			if (url === "/api/chats/chat_x/stream")
				return sseResponse(
					{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "the reaction" }] } },
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the reaction" }], stopReason: "stop" } },
					{ type: "agent_end", messages: [] },
					"[DONE]",
				);
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model({ initialMessages: [assistantMsg("seed", "the question")] });
		await m.resumeStream();
		const view = m.getState().messages;
		assert.equal(view.length, 1, "one continuous assistant document");
		assert.deepEqual(
			view[0]!.parts.map((p) => p.type),
			["step-start", "text", "step-start", "text"],
			"seeded message keeps rendering; the run mounts with a step separator",
		);
	});

	it("survives a body split byte-by-byte across reads (the framing pin)", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x") return Response.json({ messages: [] });
			if (url === "/api/chats/chat_x/stream")
				return dripped(
					sse(
						{ type: "message_start", message: { role: "assistant", content: [] } },
						partial([{ type: "text", text: "hi" }]),
						{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" } },
					) + sse("[DONE]"),
					1,
				);
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		await m.resumeStream();
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "hi");
	});

	it("an unhappy endpoint surfaces the error banner", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x") return Response.json({ messages: [] });
			if (url === "/api/chats/chat_x/stream") return new Response("boom", { status: 500 });
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		await m.resumeStream();
		const state = m.getState();
		assert.equal(state.status, "error");
		assert.match(state.error!.message, /boom/);
	});
});

// ─── adoption (append-only ground rules, owner 2026-09-15) ──────────────────

function userText(id: string, text: string): LhMessage {
	return { ...newUserMessage(text), id };
}

describe("adoptRecord — append-only adoption", () => {
	it("splices a server-added steer between the record and the live tail", () => {
		const m = model({ initialMessages: [userText("u1", "topic")] });
		m.applyWireEvent({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "streaming" }] } });
		const steer = { ...newUserMessage("steered content"), id: "steer_1" } as LhMessage & { role: "user" };
		const record = [userText("u1", "topic"), steer];
		m.adoptRecord(record);
		const ids = m.getState().nativeMessages.map((x) => x.id);
		assert.deepEqual(ids.slice(0, 2), ["u1", "steer_1"], "the steer shows NOW");
		assert.match(ids[2] ?? "", /^c_/, "the live streaming tail stays last (client slot id)");
	});

	it("a missing base id (record rewrite) bails — the idle full sync is the net", () => {
		const m = model({ initialMessages: [userText("u1", "a"), userText("u2", "b")] });
		m.adoptRecord([userText("u2", "b")]); // u1 vanished: a rewrite, not an append
		assert.deepEqual(
			m.getState().nativeMessages.map((x) => x.id),
			["u1", "u2"],
			"the adoption is a no-op on a non-append",
		);
	});

	it("absorbs the optimistic entries the record has taken over (no doubled bubbles)", () => {
		// A text send's optimistic bubble (local c_ id): the write-ahead's
		// server copy absorbs it by CONTENT — the bubble never doubles.
		const optimistic = { ...newUserMessage("my question"), id: "c_local_1" } as LhMessage;
		const serverCopy = { ...newUserMessage("my question"), id: "srv_9" } as LhMessage;
		assert.ok(absorbed(optimistic, [userText("u1", "topic"), serverCopy]), "content match absorbs the local copy");
		assert.ok(!absorbed(serverCopy, [optimistic]), "server stamps are never absorbed");
		assert.ok(!absorbed({ ...newUserMessage("my question") }, [serverCopy]), "an id-less message is never absorbed");
		// The answer result absorbs by toolCallId (ids differ, content may too —
		// the toolCallId is the identity of an answer).
		const answer = { ...newAnswerResult("call-1", "quiz", { correct: true }), id: "c_local_2" } as LhMessage;
		assert.ok(
			absorbed(answer, [{ ...newAnswerResult("call-1", "quiz", { correct: true }), id: "srv_10" } as LhMessage]),
			"the answer result absorbs by toolCallId",
		);
	});

	it("setMessages is the full snapshot swap (the idle settle sync)", () => {
		const m = model({ initialMessages: [userText("u1", "old")] });
		m.setMessages([userText("u1", "old"), userText("u2", "new"), assistantMsg("a1", "reply")]);
		assert.deepEqual(
			m.getState().nativeMessages.map((x) => (x as { id?: string }).id),
			["u1", "u2", "a1"],
		);
	});
});

// ─── the continuation fold (mount/sync seam) ────────────────────────────────

function assistantWithCall(id: string, callId: string, name = "research"): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: { topic: "x" } }],
		stopReason: "toolUse",
		usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
		provider: "openrouter",
		model: "test",
		timestamp: 0,
	} as unknown as LhMessage;
}

function resultMsg(callId: string, name = "research"): LhMessage {
	return {
		...newAnswerResult(callId, name, { ok: true }),
		id: `r_${callId}`,
	} as unknown as LhMessage;
}

describe("needsContinuation (the native lastAssistantMessageIsCompleteWithToolCalls)", () => {
	it("a record ending on a fully-answered tool call continues", () => {
		const messages = [userText("u1", "topic"), assistantWithCall("a1", "call-r1"), resultMsg("call-r1")];
		assert.equal(needsContinuation(messages), true);
	});

	it("text-tailed records never continue", () => {
		const messages = [userText("u1", "topic"), assistantMsg("a1", "done talking")];
		assert.equal(needsContinuation(messages), false);
	});

	it("a dangling question never fires a turn (the dock owns it)", () => {
		const messages = [userText("u1", "topic"), assistantWithCall("a1", "call-q1", "quiz")];
		assert.equal(needsContinuation(messages), false);
	});

	it("parallel quizzes: only ALL-answered continues (the dock still owns the open one)", () => {
		const messages = [
			userText("u1", "topic"),
			{
				...assistantWithCall("a1", "call-a"),
				content: [
					{ type: "toolCall", id: "call-a", name: "quiz", arguments: {} },
					{ type: "toolCall", id: "call-b", name: "quiz", arguments: {} },
				],
			} as unknown as LhMessage,
			resultMsg("call-a", "quiz"),
		];
		assert.equal(needsContinuation(messages), false);
		const both = [...messages, resultMsg("call-b", "quiz")];
		assert.equal(needsContinuation(both), true, "once the dock answers B, the agent owes the reaction");
	});

	it("an orphan result (no asking assistant) never continues", () => {
		assert.equal(needsContinuation([userText("u1", "topic"), resultMsg("call-x")]), false);
	});
});

// ─── the dismissal pause (owner design 2026-10-03, "A2") ────────────────────

describe("the dismissal pause (needsContinuation + endsInDismissal)", () => {
	/** The record's silent dismiss write: the toolResult the dismiss route
	 *  appends (full answer in details — the folds read it there). */
	function dismissedMsg(callId: string): LhMessage {
		return {
			...newAnswerResult(callId, "quiz", dismissedAnswer("quiz", "Pick a planet")),
			id: `d_${callId}`,
		} as unknown as LhMessage;
	}

	it("an all-dismissed tail demands NO continuation — the session waits for the user", () => {
		const messages = [userText("u1", "topic"), assistantWithCall("a1", "call-q1", "quiz"), dismissedMsg("call-q1")];
		assert.equal(needsContinuation(messages), false);
		assert.equal(endsInDismissal(messages), true, "the pause predicate reads the same tail");
	});

	it("parallel dismissals: each silent write its own call — still paused", () => {
		const assistant = {
			...assistantWithCall("a1", "call-a"),
			content: [
				{ type: "toolCall", id: "call-a", name: "quiz", arguments: {} },
				{ type: "toolCall", id: "call-b", name: "ask_user_question", arguments: {} },
			],
		} as unknown as LhMessage;
		const messages = [
			userText("u1", "topic"),
			assistant,
			dismissedMsg("call-a"),
			{ ...newAnswerResult("call-b", "ask_user_question", dismissedAnswer("ask", "Why?")), id: "d_call-b" } as unknown as LhMessage,
		];
		assert.equal(endsInDismissal(messages), true);
		assert.equal(needsContinuation(messages), false, "dismissed by id, not by position — the batch rule holds");
	});

	it("mixed tail answered-then-dismissed: the LAST resolution decides — no wake (round-1 incident)", () => {
		const assistant = {
			...assistantWithCall("a1", "call-a"),
			content: [
				{ type: "toolCall", id: "call-a", name: "quiz", arguments: {} },
			{ type: "toolCall", id: "call-b", name: "quiz", arguments: {} },
			],
		} as unknown as LhMessage;
		const messages = [userText("u1", "topic"), assistant, resultMsg("call-a", "quiz"), dismissedMsg("call-b")];
		assert.equal(endsInDismissal(messages), true, "tail ends in the dismissal");
		assert.equal(needsContinuation(messages), false, "ending on a dismissal = the user signaled stop — the reaction rides the next message");
	});

	it("mixed tail dismissed-then-answered: the answer IS owed its reaction (round-2 wake)", () => {
		const assistant = {
			...assistantWithCall("a1", "call-a"),
			content: [
				{ type: "toolCall", id: "call-a", name: "quiz", arguments: {} },
				{ type: "toolCall", id: "call-b", name: "quiz", arguments: {} },
			],
		} as unknown as LhMessage;
		const messages = [userText("u1", "topic"), assistant, dismissedMsg("call-a"), resultMsg("call-b", "quiz")];
		assert.equal(endsInDismissal(messages), false);
		assert.equal(needsContinuation(messages), true, "ending on a real answer = the reaction is owed");
	});

	it("any user message un-pauses (the derived tail flips)", () => {
		const messages = [
			userText("u1", "topic"),
			assistantWithCall("a1", "call-q1", "quiz"),
			dismissedMsg("call-q1"),
			userText("u2", "moving on"),
		];
		assert.equal(endsInDismissal(messages), false);
	});

	it("a normal answer is not a dismissal (the predicate stays honest)", () => {
		const messages = [userText("u1", "topic"), assistantWithCall("a1", "call-q1", "quiz"), resultMsg("call-q1", "quiz")];
		assert.equal(endsInDismissal(messages), false);
	});
});

// ─── the pending-call tool scan ─────────────────────────────────────────────

describe("pendingCallTool", () => {
	it("finds the dangling call's tool name (the optimistic answer's stamp)", () => {
		const messages = [assistantWithCall("a1", "call-q1", "ask_user_question")];
		assert.equal(pendingCallTool(messages, "call-q1"), "ask_user_question");
		assert.equal(pendingCallTool(messages, "call-zz"), null);
	});
});

// ─── newAnswerResult: the two-audience split (owner, 2026-10-02) ────────────

describe("newAnswerResult two audiences", () => {
	it("MODEL sees the compact learner-only record; details keeps the FULL graded answer", () => {
		const qd: QuestionData = {
			id: "call-1",
			kind: "quiz",
			question: "Which planet is closest to the Sun?",
			mode: "single-select",
			options: [
				{ label: "Mercury", value: "mercury" },
				{ label: "Venus", value: "venus" },
			],
			correctIndices: [1],
			explanation: "Mercury orbits closest.",
			createdAt: "2026-01-01T00:00:00Z",
		};
		const full = buildAnswer(qd, { values: ["mercury"], confidence: 70, thinking: "guessed" });
		const msg = newAnswerResult("call-1", "quiz", full);
		const modelSees = JSON.parse((msg.content as { type: "text"; text: string }[])[0]!.text);
		assert.deepEqual(modelSees, {
			kind: "quiz",
			answers: [{ index: 1, label: "Mercury" }],
			correct: true,
			confidence: 70,
			thinking: "guessed",
		});
		assert.equal(msg.details, full, "details is the full QuestionAnswerData verbatim");
		assert.equal((msg.details as { questionText?: string }).questionText, "Which planet is closest to the Sun?");
	});
});

// ─── the practice live-view law (owner, 2026-10-05) ─────────────────────────
//
// The two-spinners + doubled-card incident: submitting thinking flipped the
// POSE turn's problem call back to a live spinner mid-transcript (session
// busyness leaked into per-call state), and the optimistic thinking marker
// was never absorbed (role "custom" was missing from absorbed()), so the
// adoption window rendered the submission twice for the whole turn.

/** The post-settle pose-turn record of a practice session. */
function poseRecord(): LhMessage[] {
	return [
		{ id: "m1", role: "user", content: "db practice" },
		{
			id: "m3",
			role: "assistant",
			content: [{ type: "toolCall", id: "call-p1", name: "problem", arguments: { statement: "Q?" } }],
		} as unknown as LhMessage,
		{
			id: "m4",
			role: "toolResult",
			toolCallId: "call-p1",
			toolName: "problem",
			content: [{ type: "text", text: "Problem posed — the turn ends here." }],
			details: null,
		} as unknown as LhMessage,
	] as LhMessage[];
}

describe("the live-view law — live is positive evidence, not session busyness", () => {
	it("a settled problem call NEVER renders live during another turn (the two-spinner bug)", () => {
		// The thinking turn's live state: inFlight, but NOTHING streams that
		// touches the pose call, and the executions map (per-turn) is empty.
		const live = { executions: new Map(), inFlight: true, streamingIds: new Set<string>() };
		const view = projectView(poseRecord(), live);
		const problem = view.flatMap((m) => m.parts).find((p) => p.type === "tool-problem");
		assert.ok(problem, "the problem part projects");
		assert.equal(problem!.state, "input-available", "settled = the ProblemCard, never a shimmer");
	});

	it("a call in THIS turn's streaming message stays input-streaming (the shimmer's true home)", () => {
		const live = { executions: new Map(), inFlight: true, streamingIds: new Set(["c_as1"]) };
		const messages = [
			...poseRecord(),
			{
				id: "c_as1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-c1", name: "conclude", arguments: { outcome: "solved" } }],
			} as unknown as LhMessage,
		];
		const view = projectView(messages, live);
		const conclude = view.flatMap((m) => m.parts).find((p) => p.type === "tool-conclude");
		assert.ok(conclude, "the conclude part projects");
		assert.equal(conclude!.state, "input-streaming", "the live card renders at the bottom, by construction");
	});

	it("a DANGLING call in a settled message is the dock's pending — not a mid-turn shimmer", () => {
		const live = { executions: new Map(), inFlight: true, streamingIds: new Set<string>() };
		const messages = [
			{ id: "m1", role: "user", content: "go" },
			{
				id: "m2",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-p9", name: "problem", arguments: { statement: "Q?" } }],
			} as unknown as LhMessage,
		] as LhMessage[];
		const view = projectView(messages, live);
		const part = view.flatMap((m) => m.parts).find((p) => p.type === "tool-problem");
		assert.equal(part!.state, "input-available", "no evidence, no shimmer — even mid-turn");
	});
});

describe("absorbed — the custom role (the doubled thinking card)", () => {
	it("absorbs the optimistic thinking marker by customType + details", () => {
		const optimistic = { ...newThinkingMessage("call-p1", "my trace"), id: "c_opt1" } as LhMessage;
		const serverCopy = { ...newThinkingMessage("call-p1", "my trace"), id: "srv_1" } as LhMessage;
		assert.ok(absorbed(optimistic, [...poseRecord(), serverCopy]), "same submission → the local copy drops");
		// A DIFFERENT submission (different text) is its own marker.
		const other = { ...newThinkingMessage("call-p1", "a later, different trace"), id: "srv_2" } as LhMessage;
		assert.ok(!absorbed(optimistic, [...poseRecord(), other]), "different details → not the same submission");
		// The c_ gate: server stamps are never absorbed, whatever the role.
		assert.ok(!absorbed(serverCopy, [optimistic]), "server ids never drop");
	});

	it("the adoption window cannot double the card (model-level end-to-end)", () => {
		// The exact client sequence of the incident: the optimistic marker in
		// the tail (client id), then the +400ms adoption fetch swaps in the
		// write-ahead record (server id). ONE card must remain.
		const m = model({ chatId: "chat_x", initialMessages: poseRecord() });
		const optimistic = { ...newThinkingMessage("call-p1", "my trace"), id: "c_opt1" } as LhMessage;
		m.applyWireEvent({ type: "message_start", message: optimistic });
		assert.equal(
			m.getState().nativeMessages.filter((x) => (x as { role?: string }).role === "custom").length,
			1,
			"the optimistic marker is in the tail",
		);
		const serverCopy = { ...newThinkingMessage("call-p1", "my trace"), id: "srv_1" } as LhMessage;
		m.adoptRecord([...poseRecord(), serverCopy]);
		const customs = m.getState().nativeMessages.filter((x) => (x as { role?: string }).role === "custom");
		assert.equal(customs.length, 1, "the server copy replaced the optimistic one — no doubling");
		assert.equal((customs[0] as { id?: string }).id, "srv_1");
	});
});
