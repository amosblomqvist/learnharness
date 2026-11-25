/**
 * The abort-cascade fix (2026-09-19), pinned against the pi-native seams
 * (Wave A, 2026-09-26): serverExecute (tool-execute.ts) races every tool
 * body against the run's AbortSignal and the system-level per-call timeout
 * — aborting the run kills a running tool, the timeout is the net so no
 * tool can hold a turn hostage (the 2.7-minute grep lesson). Question
 * tools bypass the guard entirely (questionResult is instant and carries
 * terminate). The fs tools honor the signal with partial results
 * (fs-tools.test.ts covers their side).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Type } from "typebox";
import {
	questionResult,
	serverExecute,
	toolTimeoutMs,
	toToolResult,
	type ToolExecuteContext,
} from "../src/agent/tool-execute.ts";
import { askUserQuestionTool } from "../src/agent/tools.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

afterEach(() => {
	toolTimeoutMs.current = DEFAULT_TIMEOUT_MS;
});

const probeSchema = Type.Object({});

/** A native tool whose execute captures ctx.signal, then hangs or resolves. */
function probeTool(captured: { signal?: AbortSignal }, opts: { hang?: boolean; value?: string } = {}) {
	return {
		name: "probe",
		label: "probe",
		description: "test probe",
		parameters: probeSchema,
		execute: serverExecute("probe", probeSchema, (_input: unknown, ctx: ToolExecuteContext) => {
			captured.signal = ctx.signal;
			if (opts.hang) return new Promise<string>(() => {}); // never settles, no timer
			return opts.value ?? "ok";
		}),
	};
}

describe("serverExecute abort + timeout guard", () => {
	it("forwards a live abort signal to the tool's ctx", async () => {
		// Even with no parent signal, the tool still gets the guard's combined
		// signal (parent+timeout) — a stable reference tools can poll.
		const captured: { signal?: AbortSignal } = {};
		const pi = probeTool(captured);
		await pi.execute("c1", {});
		assert.ok(captured.signal, "the tool received a signal");
		assert.equal(captured.signal!.aborted, false);
		// The forwarded signal is the guard's COMBINED one — aborting the
		// parent flips it, which is what long-running tools poll.
		const ac = new AbortController();
		const captured2: { signal?: AbortSignal } = {};
		const pi2 = probeTool(captured2, { value: "done" });
		const pending = pi2.execute("c1b", {}, ac.signal);
		ac.abort();
		await pending;
		assert.equal(captured2.signal!.aborted, true);
	});

	it("a signal-wired tool observes the run's abort", async () => {
		const ac = new AbortController();
		const captured: { signal?: AbortSignal } = {};
		const pi = probeTool(captured, { hang: true });
		const pending = pi.execute("c2", {}, ac.signal).catch((e: Error) => e.message);
		ac.abort();
		assert.match((await pending) as string, /Operation aborted/);
		assert.equal(captured.signal!.aborted, true);
	});

	it("rejects a hanging tool at the system-level timeout", async () => {
		toolTimeoutMs.current = 50;
		const pi = probeTool({}, { hang: true });
		await assert.rejects(pi.execute("c3", {}), /timed out/);
	});

	it("a pre-aborted run rejects immediately with pi's wording", async () => {
		const ac = new AbortController();
		ac.abort();
		const pi = probeTool({}, { hang: true });
		await assert.rejects(pi.execute("c4", {}, ac.signal), /Operation aborted/);
	});
});
describe("serverExecute: cooperative settle, mapping parity, question bypass", () => {
	it("a cooperative tool settles partial results before the grace", async () => {
		toolTimeoutMs.current = 2_000;
		const schema = Type.Object({});
		const pi = {
			name: "partial",
			label: "partial",
			description: "test",
			parameters: schema,
			execute: serverExecute("partial", schema, (_input: unknown, ctx: ToolExecuteContext) =>
				new Promise((resolve) => {
					// The fs-tools contract: poll upfront (a listener on an
					// already-aborted signal never fires), else listen.
					const signal = ctx.signal!;
					if (signal.aborted) return resolve("partial results");
					signal.addEventListener("abort", () => resolve("partial results"), { once: true });
				})),
		};
		const ac = new AbortController();
		const pending = pi.execute("c5", {}, ac.signal);
		ac.abort();
		const result = await pending;
		assert.equal((result.content[0] as { text?: string }).text, "partial results");
	});

	it("questionResult is instant, terminates, and carries no details", async () => {
		const ac = new AbortController();
		ac.abort(); // a pre-aborted run signal — the placeholder must not care
		const result = await askUserQuestionTool.execute("c6", { question: "q" }, ac.signal);
		assert.match((result.content[0] as { text?: string }).text!, /Question posed/);
		assert.equal(result.details, null);
		assert.equal(result.terminate, true, "owner Option A: question results end the batch natively");
	});

	it("authoring failures return an isError result with the retryable problem list", async () => {
		const result = (await askUserQuestionTool.execute("c7", {
			question: "q",
			options: [
				{ label: "A", value: "same" },
			{ label: "B", value: "same" },
			],
		})) as { isError?: boolean; content: Array<{ text?: string }>; details?: { tool: string; problems: string[] } };
		assert.equal(result.isError, true, "pi 1.0 convention: returned, not thrown");
		assert.equal(result.details?.tool, "ask_user_question");
		assert.match(result.content[0]!.text!, /Invalid tool input for tool "ask_user_question":/);
		assert.match(result.details!.problems.map((p) => `- ${p}`).join("\n"), /- .*same value/s);
	});

	it("toToolResult parity: string verbatim, object as JSON, details rides the raw value", () => {
		const str = toToolResult("plain");
		assert.equal((str.content[0] as { text: string }).text, "plain");
		assert.equal(str.details, "plain");
		const obj = toToolResult({ a: 1 });
		assert.equal((obj.content[0] as { text: string }).text, '{"a":1}');
		assert.deepEqual(obj.details, { a: 1 });
		const img = toToolResult({
			text: "the picture",
			images: [{ data: "AAAA", mimeType: "image/png" }],
			details: { page: 2 },
		});
		assert.equal(img.content.length, 2);
		assert.equal(img.content[0]!.type, "text");
		assert.equal(img.content[1]!.type, "image");
		assert.deepEqual(img.details, { page: 2 });
		const imgNoDetails = toToolResult({ text: "t", images: [{ data: "AAAA", mimeType: "image/png" }] });
		assert.equal(imgNoDetails.details, null, "image reads keep the record part output-less (null details)");
	});
});
