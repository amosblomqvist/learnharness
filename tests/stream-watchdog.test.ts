import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach, beforeEach, type TestContext } from "node:test";

import { Agent } from "@earendil-works/pi-agent-core";
import {
	normalizeContext,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type JsonObject,
	type Message,
	type Model,
	type StreamFunction,
	type Tool,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

import {
	DEFAULT_FIRST_EVENT_TIMEOUT_MS,
	DEFAULT_IDLE_EVENT_TIMEOUT_MS,
	reportStreamActivity,
	streamWatchdog,
	type WatchdogTimer,
} from "../src/agent/stream-watchdog.ts";
import {
	configureWorkerRequestAdmission,
	createWorkerRequestScope,
} from "../src/agent/worker-request-admission.ts";
import { usageWasAdmitted } from "../src/agent/subscription-request-cycle.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";
import { retryDrops } from "../src/core/input-events.ts";
import { newMessageId, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

const POOL_KEY = Symbol.for("lh.worker-request-admission.pool.v1");
const poolGlobals = globalThis as typeof globalThis & { [POOL_KEY]?: { active: number; limit: number; queue: unknown[] } };
let previousPool: typeof poolGlobals[typeof POOL_KEY];

beforeEach(() => {
	previousPool = poolGlobals[POOL_KEY];
	delete poolGlobals[POOL_KEY];
});

afterEach(() => {
	const state = poolGlobals[POOL_KEY];
	poolGlobals[POOL_KEY] = previousPool;
	assert.equal(state?.active ?? 0, 0, "no worker admission permits leaked");
	assert.equal(state?.queue.length ?? 0, 0, "no worker admission queue entries leaked");
});

const MODEL = { api: "fixture", provider: "fixture", id: "synthetic" } as unknown as Model<Api>;
const CONTEXT = normalizeContext({ messages: [] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface FakeTimerEntry extends WatchdogTimer {
	id: number;
	dueAt: number;
	callback: () => void;
	cleared: boolean;
	unreffed: boolean;
}

class FakeClock {
	now = 0;
	scheduleCount = 0;
	private nextId = 1;
	private readonly timers = new Map<number, FakeTimerEntry>();
	private readonly scheduleWaiters: Array<() => void> = [];

	readonly setTimeoutFn = (callback: () => void, ms: number): WatchdogTimer => {
		const id = this.nextId++;
		this.scheduleCount++;
		const entry: FakeTimerEntry = {
			id,
			dueAt: this.now + ms,
			callback,
			cleared: false,
			unreffed: false,
			unref() { entry.unreffed = true; },
		};
		this.timers.set(id, entry);
		for (const notify of this.scheduleWaiters.splice(0)) notify();
		return entry;
	};

	waitForScheduleCount(target: number): Promise<void> {
		if (this.scheduleCount >= target) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const check = () => {
				if (this.scheduleCount >= target) resolve();
				else this.scheduleWaiters.push(check);
			};
			this.scheduleWaiters.push(check);
		});
	}

	readonly clearTimeoutFn = (handle: WatchdogTimer): void => {
		const entry = handle as FakeTimerEntry;
		entry.cleared = true;
		this.timers.delete(entry.id);
	};

	get activeCount(): number {
		return this.timers.size;
	}

	get allTimers(): FakeTimerEntry[] {
		return [...this.timers.values()];
	}

	advance(ms: number): void {
		const target = this.now + ms;
		while (true) {
			let earliest: FakeTimerEntry | undefined;
			for (const entry of this.timers.values()) {
				if (entry.dueAt <= target && (!earliest || entry.dueAt < earliest.dueAt)) {
					earliest = entry;
				}
			}
			if (!earliest) break;
			this.now = earliest.dueAt;
			this.timers.delete(earliest.id);
			if (!earliest.cleared) earliest.callback();
		}
		this.now = target;
	}
}

function makeMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		timestamp: 1,
		content: [],
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
		...overrides,
	};
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const HOLD = JSON.stringify({ fake: "hold" });
const REPLY = JSON.stringify({ fake: "reply" });
const CHECKPOINT = JSON.stringify({ fake: "checkpoint" });
const WAIT_FOR_MESSAGE = JSON.stringify({ fake: "wait-for-message" });
const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };
const SESSION_ID = "watchdog-claude-test";

function streamEvent(event: object): string {
	return JSON.stringify({ type: "stream_event", event });
}

function callTool(call: { id: string; name: string; arguments: JsonObject }): string {
	return JSON.stringify({ fake: "call", ...call });
}

function toToolResult(call: { id: string; name: string }, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: false, timestamp: 1 };
}

function claudeModel(): Model<Api> {
	const first = CLAUDE_CODE_MODELS[0];
	assert.ok(first);
	return first;
}

function createFakeClaudeRun(t: TestContext, scenario: string[]): { runClaude: RunClaude; children: ChildProcessWithoutNullStreams[] } {
	const dir = mkdtempSync(join(tmpdir(), "watchdog-claude-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

	const children: ChildProcessWithoutNullStreams[] = [];
	const runClaude: RunClaude = (args, options) => {
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: scenarioFile },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		children.push(child);
		return child;
	};
	return { runClaude, children };
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit");
}

// ---------------------------------------------------------------------------
// E1: Two-phase timing, `start` trap, progress vs content, validation & idempotency
// ---------------------------------------------------------------------------

test("E1: start event does not narrow first-event timeout to idle timeout; content transitions to idle phase", async () => {
	assert.equal(DEFAULT_FIRST_EVENT_TIMEOUT_MS, 120_000);
	assert.equal(DEFAULT_IDLE_EVENT_TIMEOUT_MS, 60_000);

	const clock = new FakeClock();
	let source!: AssistantMessageEventStream;
	let innerSignal!: AbortSignal;

	const wrapped = streamWatchdog((_model, _context, options) => {
		source = new AssistantMessageEventStream();
		innerSignal = options!.signal!;
		return source;
	}, {
		firstEventTimeoutMs: 120_000,
		idleEventTimeoutMs: 60_000,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const stream = wrapped(MODEL, CONTEXT);
	const eventsPromise = collect(stream);
	await tick();

	assert.equal(clock.activeCount, 1);
	assert.equal(clock.allTimers[0]?.unreffed, true, "watchdog timer should be unreffed");

	// Emit `start` at t=0 — MUST NOT narrow 120s phase to 60s
	const partial = makeMessage({ stopReason: "pending", content: [] });
	source.push({ type: "start", partial });
	await tick();

	// Advance past idleEventTimeoutMs (60s) to 95s — MUST NOT stall
	clock.advance(95_000);
	await tick();
	assert.equal(innerSignal.aborted, false, "must survive past idle timeout when only `start` was emitted");

	// Report `progress` at 95s — resets first-event timer WITHOUT narrowing to 60s
	reportStreamActivity(innerSignal, "progress");
	clock.advance(95_000);
	await tick();
	assert.equal(innerSignal.aborted, false, "progress activity keeps first-event 120s budget");

	// Emit first thinking_delta — transitions to 60s idle phase
	partial.content.push({ type: "thinking", thinking: "deep thought" });
	source.push({ type: "thinking_start", contentIndex: 0, partial });
	source.push({ type: "thinking_delta", contentIndex: 0, delta: "deep thought", partial });
	await tick();

	// Advance 50s (< 60s) then emit text_delta — resets 60s idle timer
	clock.advance(50_000);
	await tick();
	assert.equal(innerSignal.aborted, false);
	partial.content.push({ type: "text", text: "hello" });
	source.push({ type: "text_delta", contentIndex: 1, delta: "hello", partial });
	await tick();

	// Advance 50s again (< 60s since last delta) — still alive
	clock.advance(50_000);
	await tick();
	assert.equal(innerSignal.aborted, false);

	// Now go silent past 60s (another 15s -> 65s total since last delta) -> MUST stall!
	clock.advance(15_000);
	await tick();

	assert.equal(innerSignal.aborted, true, "inner signal aborted on idle stall");
	assert.equal(clock.activeCount, 0, "timer cleared after stall");

	const [events, result] = await Promise.all([eventsPromise, stream.result()]);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Stream stalled: timed out after 60s with no stream activity/);
	const terminal = events.at(-1);
	assert.equal(terminal?.type, "error");
	if (terminal?.type === "error") {
		assert.equal(terminal.reason, "error");
		assert.equal(terminal.error.errorMessage, result.errorMessage);
	}
});

test("E1: streamWatchdog is idempotent for default options, allows explicit re-wrap, and validates timeouts", () => {
	const base: StreamFunction = () => new AssistantMessageEventStream();
	const onceWrapped = streamWatchdog(base);
	assert.equal(streamWatchdog(onceWrapped), onceWrapped, "default options wrap is idempotent");
	const customWrapped = streamWatchdog(onceWrapped, { firstEventTimeoutMs: 5000, idleEventTimeoutMs: 2000 });
	assert.notEqual(customWrapped, onceWrapped, "explicit options allow custom re-wrapping");

	for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		assert.throws(() => streamWatchdog(base, { firstEventTimeoutMs: bad }), RangeError);
		assert.throws(() => streamWatchdog(base, { idleEventTimeoutMs: bad }), RangeError);
	}
});

// ---------------------------------------------------------------------------
// E2: 0s dead stream, unclosed toolCall filtering, uncooperative iterator, empty end()
// ---------------------------------------------------------------------------

test("E2: 0s dead stream stalls after firstEventTimeoutMs and aborts inner signal", async () => {
	const clock = new FakeClock();
	let innerSignal!: AbortSignal;

	const wrapped = streamWatchdog((_model, _context, options) => {
		innerSignal = options!.signal!;
		return new AssistantMessageEventStream();
	}, {
		firstEventTimeoutMs: 120_000,
		idleEventTimeoutMs: 60_000,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const stream = wrapped(MODEL, CONTEXT);
	const eventsPromise = collect(stream);
	await tick();

	clock.advance(120_000);
	const [events, result] = await Promise.all([eventsPromise, stream.result()]);

	assert.equal(innerSignal.aborted, true);
	assert.equal(clock.activeCount, 0);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Stream stalled: timed out waiting for initial response after 120s/);
	const terminal = events.at(-1);
	assert.equal(terminal?.type, "error");
	if (terminal?.type === "error") assert.equal(terminal.reason, "error");
});

test("E2: mid-toolCall stall with uncooperative iterator filters unclosed toolCall, preserves usage & completed blocks, 0 unhandled rejections", async () => {
	const clock = new FakeClock();
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);

	try {
		let innerSignal!: AbortSignal;
		let rejectStuckNext!: (err: Error) => void;
		const usage = {
			input: 42,
			output: 17,
			cacheRead: 3,
			cacheWrite: 1,
			totalTokens: 63,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		};
		const partial = makeMessage({
			stopReason: "pending",
			usage,
			content: [
				{ type: "text", text: "Checking..." },
				{ type: "toolCall", id: "call_done", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "call_partial", name: "write", arguments: { path: "b.ts" } },
			],
		});

		const scriptedEvents: AssistantMessageEvent[] = [
			{ type: "start", partial },
			{ type: "text_end", contentIndex: 0, content: "Checking...", partial },
			{ type: "toolcall_start", contentIndex: 1, partial },
			{ type: "toolcall_end", contentIndex: 1, toolCall: partial.content[1] as Extract<AssistantMessage["content"][number], { type: "toolCall" }>, partial },
			{ type: "toolcall_start", contentIndex: 2, partial },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"path":"b', partial },
		];

		// Uncooperative stream: iterator.next() hangs forever even after abort/end, then rejects late
		const wrapped = streamWatchdog((_model, _context, options) => {
			innerSignal = options!.signal!;
			const fake = new AssistantMessageEventStream();
			let idx = 0;
			fake[Symbol.asyncIterator] = () => ({
				next() {
					if (idx < scriptedEvents.length) {
						return Promise.resolve({ value: scriptedEvents[idx++]!, done: false });
					}
					return new Promise<IteratorResult<AssistantMessageEvent>>((_resolve, reject) => {
						rejectStuckNext = reject;
					});
				},
				return() {
					return Promise.resolve({ value: undefined, done: true });
				},
			}) as unknown as AsyncGenerator<AssistantMessageEvent>;
			return fake;
		}, {
			firstEventTimeoutMs: 120_000,
			idleEventTimeoutMs: 60_000,
			setTimeoutFn: clock.setTimeoutFn,
			clearTimeoutFn: clock.clearTimeoutFn,
		});

		const stream = wrapped(MODEL, CONTEXT);
		const eventsPromise = collect(stream);
		await tick();
		await tick();

		clock.advance(60_000);
		const [events, result] = await Promise.all([eventsPromise, stream.result()]);

		// Trigger late rejection on stuck next() after stall settled — must NOT cause unhandledRejection
		rejectStuckNext(new Error("late socket reset"));
		await tick();
		await tick();

		assert.equal(unhandled.length, 0, "no unhandled promise rejections from uncooperative iterator");
		assert.equal(innerSignal.aborted, true);
		assert.equal(result.stopReason, "error");
		assert.deepEqual(result.usage, usage, "preserves prior partial usage");
		assert.equal(result.content.length, 2, "unclosed toolCall at index 2 omitted while completed blocks preserved");
		assert.equal(result.content[0]?.type, "text");
		assert.equal(result.content[1]?.type, "toolCall");
		if (result.content[1]?.type === "toolCall") {
			assert.equal(result.content[1].id, "call_done");
		}
		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("E2: empty source.end() without terminal event produces synthetic error instead of hanging", async () => {
	const clock = new FakeClock();
	let source!: AssistantMessageEventStream;

	const wrapped = streamWatchdog(() => {
		source = new AssistantMessageEventStream();
		return source;
	}, {
		firstEventTimeoutMs: 120_000,
		idleEventTimeoutMs: 60_000,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const stream = wrapped(MODEL, CONTEXT);
	const eventsPromise = collect(stream);
	await tick();

	source.end(); // No terminal done/error event and no result passed!
	const [events, result] = await Promise.all([eventsPromise, stream.result()]);

	assert.equal(clock.activeCount, 0);
	assert.equal(result.stopReason, "error");
	const terminal = events.at(-1);
	assert.equal(terminal?.type, "error");
});

// ---------------------------------------------------------------------------
// E3: Pre-aborted fast path, sync throw, sync caller abort during innerFn,
//     caller abort vs stall, 0 retry storm & retryDrops compatibility
// ---------------------------------------------------------------------------

test("E3: pre-aborted signal never invokes innerFn, starts 0 timers, and marks usage unadmitted", async () => {
	const clock = new FakeClock();
	let invoked = 0;
	const wrapped = streamWatchdog(() => {
		invoked++;
		return new AssistantMessageEventStream();
	}, {
		firstEventTimeoutMs: 120_000,
		idleEventTimeoutMs: 60_000,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const caller = new AbortController();
	caller.abort();

	const stream = wrapped(MODEL, CONTEXT, { signal: caller.signal });
	assert.equal(invoked, 0);
	assert.equal(clock.activeCount, 0);

	const [events, result] = await Promise.all([collect(stream), stream.result()]);
	assert.equal(result.stopReason, "aborted");
	assert.equal(usageWasAdmitted(result.usage), false);
	const terminal = events.at(-1);
	assert.equal(terminal?.type, "error");
	if (terminal?.type === "error") assert.equal(terminal.reason, "aborted");
});

test("E3: synchronous innerFn throw cleans up timers and resolves both for-await and result() with error", async () => {
	const clock = new FakeClock();
	const wrapped = streamWatchdog(() => {
		throw new Error("missing credentials");
	}, {
		firstEventTimeoutMs: 120_000,
		idleEventTimeoutMs: 60_000,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const stream = wrapped(MODEL, CONTEXT);
	assert.equal(clock.activeCount, 0, "timer cleaned up immediately on sync throw");

	const [events, result] = await Promise.all([collect(stream), stream.result()]);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /missing credentials/);
	const terminal = events.at(-1);
	assert.equal(terminal?.type, "error");
});

test("E3: synchronous caller abort during innerFn cleans up timers, stops source, and returns aborted", async () => {
	const clock = new FakeClock();
	const caller = new AbortController();
	let innerSignal!: AbortSignal;
	let ended = false;

	const wrapped = streamWatchdog((_model, _context, options) => {
		innerSignal = options!.signal!;
		const source = new AssistantMessageEventStream();
		const origEnd = source.end.bind(source);
		source.end = (msg) => { ended = true; origEnd(msg); };
		caller.abort();
		return source;
	}, {
		firstEventTimeoutMs: 120_000,
		idleEventTimeoutMs: 60_000,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const stream = wrapped(MODEL, CONTEXT, { signal: caller.signal });
	const [events, result] = await Promise.all([collect(stream), stream.result()]);

	assert.equal(clock.activeCount, 0);
	assert.equal(innerSignal.aborted, true);
	assert.equal(ended, true);
	assert.equal(result.stopReason, "aborted");
	assert.equal(events.at(-1)?.type, "error");
});

test("E3: caller abort before timeout preserves native abort usage; stall stays error even if inner pushes aborted", async () => {
	// Part A: caller abort with native usage first-refusal
	{
		const clock = new FakeClock();
		const caller = new AbortController();
		const nativeAbortUsage = {
			input: 99,
			output: 12,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 111,
			cost: { input: 0.5, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.7 },
		};
		const wrapped = streamWatchdog((_model, _context, options) => {
			const source = new AssistantMessageEventStream();
			options?.signal?.addEventListener("abort", () => {
				const nativeAbort = makeMessage({ stopReason: "aborted", errorMessage: "Cancelled by provider", usage: nativeAbortUsage });
				source.push({ type: "error", reason: "aborted", error: nativeAbort });
				source.end();
			}, { once: true });
			return source;
		}, {
			firstEventTimeoutMs: 120_000,
			idleEventTimeoutMs: 60_000,
			setTimeoutFn: clock.setTimeoutFn,
			clearTimeoutFn: clock.clearTimeoutFn,
		});

		const stream = wrapped(MODEL, CONTEXT, { signal: caller.signal });
		const eventsPromise = collect(stream);
		await tick();

		caller.abort();
		const [events, result] = await Promise.all([eventsPromise, stream.result()]);
		assert.equal(clock.activeCount, 0);
		assert.equal(result.stopReason, "aborted");
		assert.deepEqual(result.usage, nativeAbortUsage, "native abort usage preserved");
		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") assert.equal(terminal.reason, "aborted");
	}

	// Part B: stall wins with stopReason: "error" even if inner abort handler pushes "aborted"
	{
		const clock = new FakeClock();
		const wrapped = streamWatchdog((_model, _context, options) => {
			const source = new AssistantMessageEventStream();
			options?.signal?.addEventListener("abort", () => {
				const innerAbort = makeMessage({ stopReason: "aborted", errorMessage: "Inner saw abort" });
				source.push({ type: "error", reason: "aborted", error: innerAbort });
				source.end();
			}, { once: true });
			return source;
		}, {
			firstEventTimeoutMs: 120_000,
			idleEventTimeoutMs: 60_000,
			setTimeoutFn: clock.setTimeoutFn,
			clearTimeoutFn: clock.clearTimeoutFn,
		});

		const stream = wrapped(MODEL, CONTEXT);
		const eventsPromise = collect(stream);
		await tick();

		clock.advance(120_000);
		const [events, result] = await Promise.all([eventsPromise, stream.result()]);
		assert.equal(result.stopReason, "error", "inner aborted event MUST NOT overwrite stall error");
		assert.match(result.errorMessage ?? "", /Stream stalled: timed out/);
		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") assert.equal(terminal.reason, "error");
	}
});

test("E3: Agent loop stops on stall with 0 auto-retries and retryDrops accepts the failed message", async () => {
	const clock = new FakeClock();
	let calls = 0;

	const wrapped = streamWatchdog(() => {
		calls++;
		return new AssistantMessageEventStream();
	}, {
		firstEventTimeoutMs: 1000,
		idleEventTimeoutMs: 500,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const agent = new Agent({
		initialState: { systemPrompt: "test", model: MODEL, tools: [] },
		streamFn: wrapped,
	});

	const promptPromise = agent.prompt("hello");
	await tick();
	clock.advance(1000);
	await promptPromise;

	assert.equal(calls, 1, "Agent loop must not auto-retry on stall");
	const assistant = agent.state.messages.find((m): m is AssistantMessage => m.role === "assistant");
	assert.ok(assistant);
	assert.equal(assistant.stopReason, "error");
	assert.match(assistant.errorMessage ?? "", /Stream stalled: timed out/);

	// Verify manual Retry flow (retryDrops) accepts the stalled assistant message
	const failedId = newMessageId();
	const transcript: LhMessage[] = [
		newUserMessage("hello"),
		{ ...assistant, id: failedId },
	];
	const dropped = retryDrops(transcript);
	assert.equal(dropped.has(failedId), true);
});

// ---------------------------------------------------------------------------
// E4: 0 timer leaks, paused-iterator .result(), result-only delta reset,
//     early return()/end(), WorkerRequestStream queue & multi-turn handoff
// ---------------------------------------------------------------------------

test("E4: normal completion clears timers without aborting inner signal; post-done end()/return() are no-ops", async () => {
	const clock = new FakeClock();
	let source!: AssistantMessageEventStream;
	let innerSignal!: AbortSignal;

	const wrapped = streamWatchdog((_model, _context, options) => {
		source = new AssistantMessageEventStream();
		innerSignal = options!.signal!;
		return source;
	}, {
		firstEventTimeoutMs: 120_000,
		idleEventTimeoutMs: 60_000,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const stream = wrapped(MODEL, CONTEXT);
	const eventsPromise = collect(stream);
	await tick();

	const finalMsg = makeMessage({ content: [{ type: "text", text: "ok" }] });
	source.push({ type: "done", reason: "stop", message: finalMsg });
	source.end();

	const [, result] = await Promise.all([eventsPromise, stream.result()]);
	assert.equal(result, finalMsg);
	assert.equal(clock.activeCount, 0);
	assert.equal(innerSignal.aborted, false, "normal completion must NOT abort inner signal");

	// Calling end() after normal completion must NOT abort inner signal either
	stream.end();
	assert.equal(innerSignal.aborted, false);
});

test("E4b: result-only consumer (no explicit for-await) resets timer on active deltas and completes", async () => {
	const clock = new FakeClock();
	let source!: AssistantMessageEventStream;

	const wrapped = streamWatchdog(() => {
		source = new AssistantMessageEventStream();
		return source;
	}, {
		firstEventTimeoutMs: 120_000,
		idleEventTimeoutMs: 60_000,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const stream = wrapped(MODEL, CONTEXT);
	const resultPromise = stream.result();
	await tick();

	const partial = makeMessage({ stopReason: "pending", content: [{ type: "text", text: "" }] });
	source.push({ type: "start", partial });
	await tick();

	// 4 deltas spaced 40s apart = 160s total (> 60s idle timeout)
	for (let i = 0; i < 4; i++) {
		clock.advance(40_000);
		source.push({ type: "text_delta", contentIndex: 0, delta: `chunk-${i}`, partial });
		await tick();
	}

	const finalMsg = makeMessage({ content: [{ type: "text", text: "done" }] });
	source.push({ type: "done", reason: "stop", message: finalMsg });
	source.end();

	const result = await resultPromise;
	assert.equal(result.stopReason, "stop");
	assert.equal(clock.activeCount, 0);
});

test("E4c: early iterator.return() and early stream.end() clear timers and abort inner signal immediately", async () => {
	// Early unstarted iterator.return()
	{
		const clock = new FakeClock();
		let innerSignal!: AbortSignal;
		const wrapped = streamWatchdog((_m, _c, options) => {
			innerSignal = options!.signal!;
			return new AssistantMessageEventStream();
		}, {
			firstEventTimeoutMs: 120_000,
			idleEventTimeoutMs: 60_000,
			setTimeoutFn: clock.setTimeoutFn,
			clearTimeoutFn: clock.clearTimeoutFn,
		});
		const stream = wrapped(MODEL, CONTEXT);
		const iterator = stream[Symbol.asyncIterator]();
		assert.equal(clock.activeCount, 1);
		await iterator.return?.();
		assert.equal(clock.activeCount, 0, "early unstarted return() clears timer");
		assert.equal(innerSignal.aborted, true, "early unstarted return() aborts inner");
	}

	// Early mid-stream break from for-await
	{
		const clock = new FakeClock();
		let source!: AssistantMessageEventStream;
		let innerSignal!: AbortSignal;
		const wrapped = streamWatchdog((_m, _c, options) => {
			source = new AssistantMessageEventStream();
			innerSignal = options!.signal!;
			return source;
		}, {
			firstEventTimeoutMs: 120_000,
			idleEventTimeoutMs: 60_000,
			setTimeoutFn: clock.setTimeoutFn,
			clearTimeoutFn: clock.clearTimeoutFn,
		});
		const stream = wrapped(MODEL, CONTEXT);
		const partial = makeMessage({ stopReason: "pending" });
		source.push({ type: "start", partial });
		for await (const event of stream) {
			assert.equal(event.type, "start");
			break;
		}
		assert.equal(clock.activeCount, 0, "mid-stream break clears timer");
		assert.equal(innerSignal.aborted, true, "mid-stream break aborts inner");
	}

	// Early stream.end()
	{
		const clock = new FakeClock();
		let innerSignal!: AbortSignal;
		const wrapped = streamWatchdog((_m, _c, options) => {
			innerSignal = options!.signal!;
			return new AssistantMessageEventStream();
		}, {
			firstEventTimeoutMs: 120_000,
			idleEventTimeoutMs: 60_000,
			setTimeoutFn: clock.setTimeoutFn,
			clearTimeoutFn: clock.clearTimeoutFn,
		});
		const stream = wrapped(MODEL, CONTEXT);
		assert.equal(clock.activeCount, 1);
		stream.end();
		assert.equal(clock.activeCount, 0, "early end() clears timer");
		assert.equal(innerSignal.aborted, true, "early end() aborts inner");
		assert.equal((await stream.result()).stopReason, "aborted");
	}
});

test("E4: queued WorkerRequestStream requests do not start watchdog timer until admitted", async () => {
	configureWorkerRequestAdmission(() => 1);
	const clock = new FakeClock();
	const sources: AssistantMessageEventStream[] = [];

	const watched = streamWatchdog(() => {
		const source = new AssistantMessageEventStream();
		sources.push(source);
		return source;
	}, {
		firstEventTimeoutMs: 1000,
		idleEventTimeoutMs: 500,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const scope = createWorkerRequestScope(watched);
	try {
		const first = scope.streamFn(MODEL, CONTEXT);
		const second = scope.streamFn(MODEL, CONTEXT);
		const firstResult = first.result();
		const secondResult = second.result();
		await tick();

		assert.equal(sources.length, 1, "only first request admitted");
		assert.equal(clock.activeCount, 1, "only admitted request has a watchdog timer");

		// Keep first alive with activity for 2500ms (> 1000ms firstEventTimeoutMs!)
		const partial = makeMessage({ stopReason: "pending", content: [{ type: "text", text: "" }] });
		for (let i = 0; i < 6; i++) {
			clock.advance(400);
			sources[0]!.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
			await tick();
		}

		// Finish first -> second now admitted with fresh full 1000ms budget
		sources[0]!.push({ type: "done", reason: "stop", message: makeMessage() });
		sources[0]!.end();
		assert.equal((await firstResult).stopReason, "stop");
		await tick();

		assert.equal(sources.length, 2, "second request admitted after first finishes");
		clock.advance(900); // < 1000ms fresh firstEventTimeoutMs
		sources[1]!.push({ type: "done", reason: "stop", message: makeMessage() });
		sources[1]!.end();
		assert.equal((await secondResult).stopReason, "stop");
		assert.equal(clock.activeCount, 0);
	} finally {
		scope.close();
	}
});

test("E4a + E4 multi-turn: paused-iterator .result() resolves toolUse and iterator.return() retires parked Claude child; multi-turn handoff survives tool wait > firstEventTimeoutMs", { timeout: 10_000 }, async (t) => {
	const heldRead = { id: "toolu_wd_read", name: "read", arguments: { path: "notes.md" } };
	const toolUseLines = [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: heldRead.id, name: "mcp__learnharness__read", input: {} } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(heldRead.arguments) } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
	];

	// Part A: paused-iterator .result() resolves toolUse without deadlock and iterator.return() retires child
	{
		const clock = new FakeClock();
		const { runClaude, children } = createFakeClaudeRun(t, [...toolUseLines, callTool(heldRead), HOLD]);
		const watchedClaude = streamWatchdog(createClaudeCodeStreamFunction(runClaude), {
			firstEventTimeoutMs: 1000,
			idleEventTimeoutMs: 500,
			setTimeoutFn: clock.setTimeoutFn,
			clearTimeoutFn: clock.clearTimeoutFn,
		});
		const scope = createWorkerRequestScope(watchedClaude);
		t.after(() => scope.close());

		const stream = scope.streamFn(claudeModel(), normalizeContext({ messages: [HI], tools: [READ_TOOL] }), { sessionId: SESSION_ID });
		const iterator = stream[Symbol.asyncIterator]();
		const msg = await stream.result();
		assert.equal(msg.stopReason, "toolUse");
		assert.equal(clock.activeCount, 0, "watchdog timer cleared on toolUse completion");
		assert.equal(children.length, 1);
		assert.equal(children[0]!.signalCode, null, "parked child stays alive after toolUse");

		await iterator.return?.();
		await waitForExit(children[0]!);
	}

	// Part B: multi-turn parked Claude child survives tool wait > firstEventTimeoutMs and reuses same child
	{
		const clock = new FakeClock();
		const { runClaude, children } = createFakeClaudeRun(t, [...toolUseLines, callTool(heldRead), REPLY]);
		const watchedClaude = streamWatchdog(createClaudeCodeStreamFunction(runClaude), {
			firstEventTimeoutMs: 1000,
			idleEventTimeoutMs: 500,
			setTimeoutFn: clock.setTimeoutFn,
			clearTimeoutFn: clock.clearTimeoutFn,
		});
		const scope = createWorkerRequestScope(watchedClaude);
		t.after(() => scope.close());

		const turn1 = scope.streamFn(claudeModel(), normalizeContext({ messages: [HI], tools: [READ_TOOL] }), { sessionId: SESSION_ID });
		const turn1Events = await collect(turn1);
		const turn1Msg = await turn1.result();
		assert.equal(turn1Msg.stopReason, "toolUse");
		assert.equal(turn1Events.at(-1)?.type, "done");
		assert.equal(children.length, 1);
		assert.equal(children[0]!.signalCode, null, "child parked for worker continuation");

		// Simulate slow tool execution lasting longer than firstEventTimeoutMs (5000ms > 1000ms)
		clock.advance(5000);
		assert.equal(children[0]!.signalCode, null, "parked child not killed by watchdog during tool execution");

		const turn2 = scope.streamFn(
			claudeModel(),
			normalizeContext({ messages: [HI, turn1Msg, toToolResult(heldRead, "hello-from-tool")], tools: [READ_TOOL] }),
			{ sessionId: SESSION_ID },
		);
		const turn2Msg = await turn2.result();
		assert.equal(turn2Msg.stopReason, "stop");
		assert.equal(children.length, 1, "turn 2 reused the parked child via forwardWorkerContinuation");
		const textBlock = turn2Msg.content.find((b) => b.type === "text");
		assert.equal(textBlock?.type === "text" ? textBlock.text : "", "hello-from-tool");
		assert.equal(clock.activeCount, 0);
	}
});

// ---------------------------------------------------------------------------
// E5: Claude Code buffered toolInputDelta regression & hung CLI child kill
// ---------------------------------------------------------------------------

test("E5: Claude Code buffered toolInputDelta chunks keep watchdog alive past idleEventTimeoutMs", { timeout: 10_000 }, async (t) => {
	const clock = new FakeClock();
	const call = { id: "toolu_wd_big", name: "read", arguments: { path: "very/long/path.ts", extra: "123456" } };
	const jsonChunks = [
		'{"path":"very/',
		'long/',
		'path.ts",',
		'"extra":"123',
		'456"}',
	];

	const scenario: string[] = [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: call.id, name: "mcp__learnharness__read", input: {} } }),
		CHECKPOINT,
		WAIT_FOR_MESSAGE,
	];
	for (const chunk of jsonChunks) {
		scenario.push(
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: chunk } }),
			CHECKPOINT,
			WAIT_FOR_MESSAGE,
		);
	}
	scenario.push(
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
		callTool(call),
		HOLD,
	);

	const { runClaude, children } = createFakeClaudeRun(t, scenario);
	const watchedClaude = streamWatchdog(createClaudeCodeStreamFunction(runClaude), {
		firstEventTimeoutMs: 120_000,
		idleEventTimeoutMs: 60_000,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const stream = watchedClaude(claudeModel(), normalizeContext({ messages: [HI], tools: [READ_TOOL] }), { sessionId: SESSION_ID });
	const resultPromise = stream.result();

	// Wait for child to spawn
	while (children.length === 0) await tick();
	const child = children[0]!;

	// Advance 45s (< 60s idle timeout) between each chunk: 6 * 45s = 270s total (> 60s idle timeout!)
	// Wait for the watchdog timer to actually re-arm on each chunk so there is no stdout-vs-IPC race.
	let expectedSchedules = 2; // 1 initial arm + 1 for blockStart(toolUse)
	for (let i = 0; i <= jsonChunks.length; i++) {
		await Promise.all([once(child, "message"), clock.waitForScheduleCount(expectedSchedules)]);
		clock.advance(45_000);
		expectedSchedules++;
		child.send({ release: i });
	}

	const result = await resultPromise;
	assert.equal(result.stopReason, "toolUse", "buffered toolInputDelta kept watchdog alive without stalling");
	assert.equal(clock.activeCount, 0);
});

test("E5: hanging Claude CLI child triggers stall error and kills child process", { timeout: 10_000 }, async (t) => {
	const clock = new FakeClock();
	const { runClaude, children } = createFakeClaudeRun(t, [CHECKPOINT, HOLD]);
	const watchedClaude = streamWatchdog(createClaudeCodeStreamFunction(runClaude), {
		firstEventTimeoutMs: 120_000,
		idleEventTimeoutMs: 60_000,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	const stream = watchedClaude(claudeModel(), normalizeContext({ messages: [HI] }), { sessionId: SESSION_ID });
	const eventsPromise = collect(stream);

	while (children.length === 0) await tick();
	const child = children[0]!;
	await once(child, "message"); // child is running and silent

	clock.advance(120_000);
	const [events, result] = await Promise.all([eventsPromise, stream.result()]);

	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Stream stalled: timed out/);
	assert.equal(events.at(-1)?.type, "error");
	await waitForExit(child);
	assert.equal(clock.activeCount, 0);
});
