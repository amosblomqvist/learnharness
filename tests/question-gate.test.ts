/**
 * The pre-delivery question gate (#417, owner-approved increment 1):
 *
 *  - orchestrator: one cheap verifier call per card, fail-open on every
 *    failure except a parent abort; identical re-poses are deduped;
 *  - tool boundary: the TEACH quiz/explain tools gate AFTER their structural
 *    contract and BEFORE questionResult — a rejection is the ordinary
 *    invalid-input error result (the tutor re-authors in this same turn), a
 *    verifier failure delivers the card, and the per-turn bounce budget keeps
 *    a false positive from wedging the lesson;
 *  - scope: probe/recall and ask_user_question are NOT gated in v1;
 *  - projection: a rejected attempt is hidden from the learner transcript
 *    while the record keeps it;
 *  - settings: the hidden `questionVerifier` role rides the cheap slot and
 *    the switch is absent = enabled.
 *
 * The verifier engine is a scripted faux pi engine (no network, no tokens).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import {
	QUESTION_GATE_MAX_BOUNCES,
	QUESTION_GATE_REJECTION_HEAD,
	buildGatePrompt,
	createQuestionGate,
	questionGateEnabled,
	questionGateEngineOverride,
	verifyQuestion,
	type QuestionGateFn,
	type QuestionGateOutcome,
} from "../src/agent/question-gate.ts";
import { createProberTools, teachExplainToolFor, teachQuizToolFor } from "../src/agent/tools.ts";
import { projectView } from "../src/core/view.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { PATHS } from "../config.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const QUIZ = {
	question: "Which planet is closest to the sun?",
	options: [
		{ label: "Venus", value: "venus" },
		{ label: "Mercury", value: "mercury" },
		{ label: "Mars", value: "mars" },
	],
	correctAnswer: "mercury",
	explanation: "Mercury orbits nearest the sun.",
	type: "check" as const,
	nodeId: "planet-order",
};

const EXPLAIN = {
	question: "Why is Mercury hotter than Venus despite being smaller?",
	correctAnswer: "Not hotter — Venus is hotter; Mercury is closest but has no greenhouse atmosphere.",
	type: "check" as const,
	nodeId: "planet-order",
};

/** A scripted verifier engine that records how many model calls it served. */
function fauxEngine(steps: FauxResponseStep[]): { engine: PiEngine; modelCalls: () => number } {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	let calls = 0;
	const engine: PiEngine = {
		model: faux.getModel(),
		streamFn: (model, context, options) => {
			calls += 1;
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, modelCalls: () => calls };
}

/** One verifier turn: the single submit_verification tool call. */
function verdictStep(verdict: "accept" | "reject", problems: string[] = [], id = "submit-1"): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall("submit_verification", { verdict, problems }, { id })], {
		stopReason: "toolUse",
	});
}

const createdChats: string[] = [];
after(() => {
	questionGateEngineOverride.current = undefined;
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* scratch cleanup, best effort */
		}
	}
});

function newChatWithTree(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveTree(chat.id, {
		nodes: [{ id: "planet-order", title: "Planet order" }],
		edges: [],
		version: 1,
	});
	return chat.id;
}

type ToolResultShape = {
	isError?: boolean;
	terminate?: boolean;
	details?: { problems?: string[]; questionGate?: boolean };
};

async function callTool(tool: { execute: (...args: any[]) => Promise<unknown> }, input: unknown): Promise<ToolResultShape> {
	return (await tool.execute("gate-test-call", input as never, undefined)) as unknown as ToolResultShape;
}

/** A fake gate that yields the scripted outcomes in order (last one repeats). */
function fakeGate(outcomes: QuestionGateOutcome[]): { gate: QuestionGateFn; calls: Array<{ tool: string; input: unknown }> } {
	const calls: Array<{ tool: string; input: unknown }> = [];
	const gate: QuestionGateFn = async (request) => {
		calls.push({ tool: request.tool, input: request.input });
		return outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
	};
	return { gate, calls };
}

// ─── the orchestrator ────────────────────────────────────────────────────────

describe("verifyQuestion — one cheap verdict, fail-open by default", () => {
	it("accepts a clean card with exactly one model call and one usage report", async () => {
		const { engine, modelCalls } = fauxEngine([verdictStep("accept")]);
		const usages: Usage[] = [];
		const outcome = await verifyQuestion({
			tool: "quiz",
			input: QUIZ,
			engine,
			timeoutMs: 2_000,
			onUsage: (usage) => usages.push(usage),
		});
		assert.deepEqual(outcome, { accepted: true });
		assert.equal(modelCalls(), 1, "one verifier call per card");
		assert.equal(usages.length, 1, "the verifier call folds into the money channel");
	});

	it("returns the concrete problems on a reject", async () => {
		const { engine } = fauxEngine([
			verdictStep("reject", ["The stem asks for the closest planet but correctAnswer names Mars."]),
		]);
		const outcome = await verifyQuestion({ tool: "quiz", input: QUIZ, engine, timeoutMs: 2_000 });
		assert.deepEqual(outcome, {
			accepted: false,
			problems: ["The stem asks for the closest planet but correctAnswer names Mars."],
		});
	});

	it("a reject with no problems is schema-invalid: the verifier retries within its turn budget", async () => {
		const { engine, modelCalls } = fauxEngine([
			verdictStep("reject", [], "submit-1"),
			verdictStep("reject", ["Explanation contradicts the key."], "submit-2"),
		]);
		const outcome = await verifyQuestion({ tool: "quiz", input: QUIZ, engine, timeoutMs: 2_000 });
		assert.deepEqual(outcome, { accepted: false, problems: ["Explanation contradicts the key."] });
		assert.equal(modelCalls(), 2, "the semantic validate seam bounced the empty reject");
	});

	it("fail-open: a verifier that never submits a verdict", async () => {
		const { engine } = fauxEngine([
			fauxAssistantMessage([fauxText("Looks fine to me.")]),
			fauxAssistantMessage([fauxText("Still fine.")]),
		]);
		const outcome = await verifyQuestion({ tool: "quiz", input: QUIZ, engine, timeoutMs: 2_000 });
		assert.equal(outcome.accepted, true);
		assert.equal((outcome as { skipped?: string }).skipped, "verifier-error");
	});

	it("fail-open: a provider error inside the verifier", async () => {
		const { engine } = fauxEngine([
			fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "verifier provider down" }),
		]);
		const outcome = await verifyQuestion({ tool: "quiz", input: QUIZ, engine, timeoutMs: 2_000 });
		assert.equal(outcome.accepted, true);
		assert.equal((outcome as { skipped?: string }).skipped, "verifier-error");
	});

	it("fail-open: the 8s budget expires (no hanging the turn)", async () => {
		const faux = createFauxCore({});
		const pending = ((_ctx: unknown, options: { signal?: AbortSignal } | undefined) =>
			new Promise((resolve) => {
				const finish = () => resolve(fauxAssistantMessage([fauxText("late")]));
				if (options?.signal?.aborted) return finish();
				options?.signal?.addEventListener("abort", finish, { once: true });
			})) as unknown as FauxResponseStep;
		faux.setResponses([pending]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const started = Date.now();
		const outcome = await verifyQuestion({ tool: "quiz", input: QUIZ, engine, timeoutMs: 25 });
		assert.equal(outcome.accepted, true);
		assert.equal((outcome as { skipped?: string }).skipped, "timeout");
		assert.ok(Date.now() - started < 2_000, "the timeout is ours, not the provider's");
	});

	it("fail-open: no verifier engine = no call", async () => {
		const outcome = await verifyQuestion({ tool: "quiz", input: QUIZ });
		assert.deepEqual(outcome, { accepted: true, skipped: "no-engine" });
	});

	it("parent abort wins: a pre-aborted turn never delivers a card", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			verifyQuestion({ tool: "quiz", input: QUIZ, engine: fauxEngine([verdictStep("accept")]).engine, signal: controller.signal }),
			/Operation aborted/,
		);
	});

	it("parent abort during the verifier rethrows instead of accepting", async () => {
		const faux = createFauxCore({});
		const pending = ((_ctx: unknown, options: { signal?: AbortSignal } | undefined) =>
			new Promise((resolve) => {
				const finish = () => resolve(fauxAssistantMessage([fauxText("late")]));
				if (options?.signal?.aborted) return finish();
				options?.signal?.addEventListener("abort", finish, { once: true });
			})) as unknown as FauxResponseStep;
		faux.setResponses([pending]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const controller = new AbortController();
		const pendingVerdict = verifyQuestion({ tool: "quiz", input: QUIZ, engine, signal: controller.signal, timeoutMs: 5_000 });
		setTimeout(() => controller.abort(), 20);
		await assert.rejects(pendingVerdict, /Operation aborted/);
	});
});

describe("createQuestionGate — turn scope, dedup, and the settings switch", () => {
	it("dedupes an identical re-posed card (no second verdict purchase)", async () => {
		const { engine, modelCalls } = fauxEngine([verdictStep("reject", ["Key mismatch."])]);
		const gate = createQuestionGate({ engine, timeoutMs: 2_000 })!;
		const first = await gate({ tool: "quiz", input: QUIZ });
		const second = await gate({ tool: "quiz", input: QUIZ });
		assert.deepEqual(first, second);
		assert.equal(modelCalls(), 1, "the byte-identical retry is answered from the turn cache");
	});

	it("falls back to the test engine override and returns undefined without one", async () => {
		assert.equal(createQuestionGate(), undefined, "no engine and no override = no gate (fail-open)");
		const { engine } = fauxEngine([verdictStep("accept")]);
		questionGateEngineOverride.current = engine;
		try {
			const gate = createQuestionGate()!;
			assert.deepEqual(await gate({ tool: "quiz", input: QUIZ }), { accepted: true });
		} finally {
			questionGateEngineOverride.current = undefined;
		}
	});

	it("settings: absent = enabled, explicit false disables", () => {
		assert.equal(questionGateEnabled(undefined), true);
		assert.equal(questionGateEnabled({}), true);
		assert.equal(questionGateEnabled({ enabled: true }), true);
		assert.equal(questionGateEnabled({ enabled: false }), false);
	});

	it("settings sanitizer keeps a boolean gate switch only (lenient read side)", () => {
		const off = sanitizeUserSettings({ agent: { questionGate: { enabled: false } } })!;
		assert.deepEqual(off.agent!.questionGate, { enabled: false });
		const empty = sanitizeUserSettings({ agent: { questionGate: {} } })!;
		assert.deepEqual(empty.agent!.questionGate, {});
		const bad = sanitizeUserSettings({ agent: { questionGate: { enabled: "yes" } } })!;
		assert.equal(bad.agent!.questionGate, undefined, "a bad shape drops the key and the default (on) resumes");
	});

	it("buildGatePrompt carries the card only — never learner history", () => {
		const prompt = buildGatePrompt("quiz", QUIZ as unknown as Record<string, unknown>);
		assert.match(prompt, /closest to the sun/);
		assert.match(prompt, /mercury/);
		assert.match(prompt, /Mercury orbits nearest the sun/);
		assert.match(prompt, /planet-order/);
		assert.doesNotMatch(prompt, /transcript|history|chatId|messages/i, "no learner history or session identifiers leak into the verifier prompt");
	});
});

// ─── the tool boundary ───────────────────────────────────────────────────────

describe("teach quiz/explain — the gate runs after structure, before the pose", () => {
	it("accepts a clean card (the ordinary terminating question result)", async () => {
		const chatId = newChatWithTree("Gate: accept");
		const { gate, calls } = fakeGate([{ accepted: true }]);
		const result = await callTool(teachQuizToolFor({ chatId, chatStore, questionGate: gate }), QUIZ);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
		assert.deepEqual(calls.map((c) => c.tool), ["quiz"]);
	});

	it("rejects a bad card as the ordinary invalid-input retry result (no pose)", async () => {
		const chatId = newChatWithTree("Gate: reject");
		const { gate } = fakeGate([{ accepted: false, problems: ["Explanation contradicts the key."] }]);
		const result = await callTool(teachQuizToolFor({ chatId, chatStore, questionGate: gate }), QUIZ);
		assert.equal(result.isError, true);
		assert.notEqual(result.terminate, true, "a rejection keeps the turn alive so the tutor can retry");
		assert.equal(result.details?.questionGate, true);
		assert.deepEqual(result.details?.problems, ["Explanation contradicts the key."]);
	});

	it("structural failure never spends a verifier call", async () => {
		const chatId = newChatWithTree("Gate: structural first");
		const { gate, calls } = fakeGate([{ accepted: false, problems: ["should never run"] }]);
		const bad = { ...QUIZ, correctAnswer: "not-an-option" };
		const result = await callTool(teachQuizToolFor({ chatId, chatStore, questionGate: gate }), bad);
		assert.equal(result.isError, true);
		assert.equal(calls.length, 0, "a structurally invalid card never earns a verifier call");
	});

	it("a throwing gate fails open and poses the card", async () => {
		const chatId = newChatWithTree("Gate: throw");
		const gate: QuestionGateFn = async () => {
			throw new Error("verifier exploded");
		};
		const result = await callTool(teachQuizToolFor({ chatId, chatStore, questionGate: gate }), QUIZ);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
	});

	it(`max ${QUESTION_GATE_MAX_BOUNCES} bounces, then the next pose is delivered unverified`, async () => {
		const chatId = newChatWithTree("Gate: bounce budget");
		const { gate, calls } = fakeGate([{ accepted: false, problems: ["Key is wrong."] }]);
		const tool = teachQuizToolFor({ chatId, chatStore, questionGate: gate });
		for (let attempt = 1; attempt <= QUESTION_GATE_MAX_BOUNCES; attempt++) {
			const result = await callTool(tool, QUIZ);
			assert.equal(result.isError, true, `attempt ${attempt} bounces`);
		}
		const delivered = await callTool(tool, QUIZ);
		assert.equal(delivered.isError, undefined, "the budget expires and the card is delivered");
		assert.equal(delivered.terminate, true);
		assert.equal(calls.length, QUESTION_GATE_MAX_BOUNCES, "the gate is not consulted after the budget");
	});

	it("gates the teach explain variant too", async () => {
		const chatId = newChatWithTree("Gate: explain");
		const { gate, calls } = fakeGate([{ accepted: false, problems: ["The committed answer is wrong."] }]);
		const result = await callTool(teachExplainToolFor({ chatId, chatStore, questionGate: gate }), EXPLAIN);
		assert.equal(result.isError, true);
		assert.equal(calls[0]?.tool, "explain");
	});

	it("probe tools stay gate-free in v1 even with a gate in the prober context", async () => {
		const chatId = newChatWithTree("Gate: probe seam");
		const { gate, calls } = fakeGate([{ accepted: false, problems: ["never used"] }]);
		const tools = createProberTools({
			chatId,
			chatStore,
			deliver: () => {},
			jobStore,
			spawn: () => {},
			questionGate: gate,
		});
		const probeCalls: unknown[] = [];
		const probe = tools.probe as unknown as { execute: (id: string, input: unknown) => Promise<unknown> };
		const result = (await probe.execute("probe-1", {
			question: QUIZ.question,
			options: QUIZ.options,
			correctAnswer: QUIZ.correctAnswer,
			explanation: QUIZ.explanation,
		})) as ToolResultShape;
		probeCalls.push(result);
		assert.equal(result.isError, undefined);
		assert.equal(calls.length, 0, "the probed card is never sent to the verifier in v1");
		// ask_user_question is ungated by construction (no ctx carries a gate).
		const ask = tools.ask_user_question as unknown as { execute: (id: string, input: unknown) => Promise<unknown> };
		await ask.execute("ask-1", { question: "Which topic next?" });
		assert.equal(calls.length, 0);
	});
});

// ─── the projection hides rejected attempts ─────────────────────────────────

describe("view projection — rejected attempts are record-only", () => {
	const assistantWithCall = (messageId: string, callId: string, name = "quiz"): LhMessage => ({
		id: messageId,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: QUIZ }],
		stopReason: "toolUse",
		timestamp: 1,
	}) as unknown as LhMessage;

	const gateRejectResult = (callId: string): LhMessage => ({
		id: `result-${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		isError: true,
		content: [{ type: "text", text: `${QUESTION_GATE_REJECTION_HEAD} for tool "quiz":\n- Key mismatch.` }],
		details: { tool: "quiz", problems: ["Key mismatch."], questionGate: true },
		timestamp: 2,
	}) as unknown as LhMessage;

	it("a settled gate rejection leaves no learner-visible question part", () => {
		const view = projectView([
			assistantWithCall("a1", "bad-1"),
			gateRejectResult("bad-1"),
			assistantWithCall("a2", "good-1"),
		]);
		const parts = view.flatMap((message) => message.parts);
		assert.equal(parts.some((part) => part.toolCallId === "bad-1"), false, "the rejected attempt is hidden");
		const good = parts.find((part) => part.toolCallId === "good-1");
		assert.ok(good, "the clean card projects");
		assert.equal(good!.state, "input-available");
	});

	it("ordinary tool errors still render as failed cards", () => {
		const readCall = {
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "x" } }],
			stopReason: "toolUse",
			timestamp: 1,
		} as unknown as LhMessage;
		const readError = {
			id: "r1",
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "not found" }],
			details: { tool: "read", problems: [] },
			timestamp: 2,
		} as unknown as LhMessage;
		const view = projectView([readCall, readError]);
		const part = view.flatMap((message) => message.parts).find((p) => p.toolCallId === "read-1");
		assert.ok(part);
		assert.equal(part!.state, "output-error");
	});

	it("a live gate rejection (execution text only) is hidden too", () => {
		const view = projectView([assistantWithCall("a1", "bad-live")], {
			executions: new Map([["bad-live", { isError: true, errorText: `${QUESTION_GATE_REJECTION_HEAD} for tool "quiz":\n- x` }]]),
			inFlight: true,
			streamingIds: new Set(["a1"]),
		});
		const parts = view.flatMap((message) => message.parts);
		assert.equal(parts.some((part) => part.toolCallId === "bad-live"), false);
	});
});
