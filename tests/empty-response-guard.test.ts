import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	normalizeContext,
} from "@earendil-works/pi-ai";
import {
	buildEmptyResponseRetryContext,
	EMPTY_RESPONSE_ERROR_MESSAGE,
	EMPTY_RESPONSE_RETRY_PROMPT,
	hasDeliverableAssistantOutput,
	isEmptyThinkingOnlyStop,
	wrapEmptyResponseGuard,
} from "../src/agent/empty-response-guard.ts";
import { endsInFailedTurn, failedResponseAtEnd } from "../src/core/input-events.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-empty-guard-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { createPracticeAgent, createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { SubscriptionRequestCycle } = await import("../src/agent/subscription-request-cycle.ts");
const { runPiTurn } = await import("../src/server/pi/ui-stream.ts");

after(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

async function runAgentTurn(agent: ReturnType<typeof createTeacherAgent>) {
	let settled: LhMessage[] = [];
	let doneResolve!: () => void;
	const done = new Promise<void>((resolve) => {
		doneResolve = resolve;
	});
	const handle = runPiTurn({
		agent,
		onFinish: (messages) => {
			settled = messages as LhMessage[];
			doneResolve();
		},
	});
	const sse = await new Response(handle.subscribe()).text();
	await done;
	return { settled, sse };
}

describe("empty-response-guard helpers", () => {
	it("treats non-whitespace text or toolCall as deliverable, and thinking/whitespace-only as non-deliverable", () => {
		assert.equal(hasDeliverableAssistantOutput({ content: [] }), false);
		assert.equal(hasDeliverableAssistantOutput({ content: [{ type: "thinking", thinking: "pondering" }] }), false);
		assert.equal(
			hasDeliverableAssistantOutput({
				content: [{ type: "thinking", thinking: "pondering" }, { type: "text", text: "   \n\t " }],
			}),
			false,
		);
		assert.equal(hasDeliverableAssistantOutput({ content: [{ type: "text", text: "Hello" }] }), true);
		assert.equal(
			hasDeliverableAssistantOutput({
				content: [{ type: "toolCall", id: "c1", name: "ask_user_question", arguments: {} }],
			}),
			true,
		);

		assert.equal(isEmptyThinkingOnlyStop("stop", { content: [{ type: "thinking", thinking: "only" }] }), true);
		assert.equal(isEmptyThinkingOnlyStop("length", { content: [{ type: "thinking", thinking: "cut" }] }), true);
		assert.equal(isEmptyThinkingOnlyStop("error", { content: [{ type: "thinking", thinking: "err" }] }), false);
		assert.equal(isEmptyThinkingOnlyStop("aborted", { content: [] }), false);
		assert.equal(isEmptyThinkingOnlyStop("stop", { content: [{ type: "text", text: "ok" }] }), false);
	});

	it("builds transient retry context without mutating caller messages", () => {
		const ctx = normalizeContext({
			systemPrompt: "Sys",
			messages: [{ role: "user", content: "Explain integrals", timestamp: 1 }],
			tools: [],
		});
		const retry = buildEmptyResponseRetryContext(ctx);
		assert.equal(ctx.messages.length, 2);
		assert.equal(retry.messages.length, 2);
		assert.equal(ctx.messages[1]?.role, "user");
		assert.equal((ctx.messages[1] as { content: unknown }).content, "Explain integrals");
		assert.deepEqual((retry.messages[1] as { content: unknown }).content, [
			{ type: "text", text: "Explain integrals" },
			{ type: "text", text: EMPTY_RESPONSE_RETRY_PROMPT },
		]);

		const toolCtx = normalizeContext({
			systemPrompt: "Sys",
			messages: [
				{ role: "user", content: "Start", timestamp: 1 },
				fauxAssistantMessage([fauxToolCall("read", { path: "a" }, { id: "c1" })], { stopReason: "toolUse" }),
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: [{ type: "text", text: "file data" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [],
		});
		const toolRetry = buildEmptyResponseRetryContext(toolCtx);
		assert.equal(toolCtx.messages.length, 4);
		assert.equal(toolRetry.messages.length, 5);
		assert.equal(toolRetry.messages[4]?.role, "user");
	});
});

describe("teaching agents empty/thinking-only turn guard", () => {
	it("prober auto-retries once cleanly without adding synthetic user messages to persisted history", async () => {
		const { askUserQuestionTool } = await import("../src/agent/tools.ts");
		const faux = createFauxCore({});
		let attempts = 0;
		faux.setResponses([
			() => {
				attempts++;
				return fauxAssistantMessage([fauxThinking("Internal reasoning only...")], { stopReason: "stop" });
			},
			() => {
				attempts++;
				return fauxAssistantMessage([
					fauxThinking("Now emit the probing question."),
					fauxToolCall(
						"ask_user_question",
						{ question: "What happens if we take d/dx of x^2?" },
						{ id: "q-probe-1" },
					),
				], { stopReason: "toolUse" });
			},
		]);

		const user = newUserMessage("Teach me derivatives");
		let usageCalls = 0;
		const agent = createProberAgent(
			{ chatId: "probe-recover", searchAvailable: () => false } as never,
			{
				engine: { model: faux.getModel(), streamFn: faux.streamSimple },
				messages: [user],
				tools: { ask_user_question: askUserQuestionTool },
				onUsage: () => {
					usageCalls++;
				},
			},
		);

		const { settled, sse } = await runAgentTurn(agent);
		assert.equal(attempts, 2);
		assert.equal(usageCalls, 1);
		assert.deepEqual(settled.map((m) => m.role), ["user", "assistant", "toolResult"]);
		const assistant = settled[1]!;
		assert.equal(assistant.role, "assistant");
		if (assistant.role !== "assistant") throw new Error("expected assistant");
		assert.equal(assistant.stopReason, "toolUse");
		assert.ok(assistant.content.some((b) => b.type === "toolCall" && b.name === "ask_user_question"));
		assert.equal(settled[2]?.role === "toolResult" && settled[2].isError, false);
		assert.equal(failedResponseAtEnd(settled), undefined);
		assert.equal(sse.includes(EMPTY_RESPONSE_RETRY_PROMPT), false);
		assert.equal(JSON.stringify(settled).includes(EMPTY_RESPONSE_RETRY_PROMPT), false);
	});

	it("teacher text recovery preserves clean [user, assistant] transcript", async () => {
		const faux = createFauxCore({});
		let attempts = 0;
		faux.setResponses([
			() => {
				attempts++;
				return fauxAssistantMessage([fauxThinking("Thinking only...")], { stopReason: "stop" });
			},
			() => {
				attempts++;
				return fauxAssistantMessage([fauxText("Here is the clear explanation.")]);
			},
		]);

		const user = newUserMessage("Explain derivatives");
		const agent = createTeacherAgent(undefined, {
			engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			messages: [user],
			tools: {},
		});

		const { settled, sse } = await runAgentTurn(agent);
		assert.equal(attempts, 2);
		assert.deepEqual(settled.map((m) => m.role), ["user", "assistant"]);
		const assistant = settled[1]!;
		assert.equal(assistant.role, "assistant");
		if (assistant.role !== "assistant") throw new Error("expected assistant");
		assert.equal(assistant.stopReason, "stop");
		const textBlock = assistant.content.find((b) => b.type === "text");
		assert.equal(textBlock?.type === "text" ? textBlock.text : "", "Here is the clear explanation.");
		assert.equal(sse.includes(EMPTY_RESPONSE_RETRY_PROMPT), false);
	});

	it("teacher and practice fail with stopReason=error after one retry if output remains thinking-only", async () => {
		for (const kind of ["teacher", "practice"] as const) {
			const faux = createFauxCore({});
			let attempts = 0;
			faux.setResponses([
				() => {
					attempts++;
					return fauxAssistantMessage([fauxThinking("Silent thought 1")], { stopReason: "stop" });
				},
				() => {
					attempts++;
					return fauxAssistantMessage([fauxThinking("Silent thought 2")], { stopReason: "length" });
				},
				() => {
					attempts++;
					return fauxAssistantMessage([fauxText("Should never reach attempt 3")]);
				},
			]);

			const user = newUserMessage("Explain eigenvectors");
			const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
			const agent =
				kind === "teacher"
					? createTeacherAgent(undefined, { engine, messages: [user], tools: {} })
					: createPracticeAgent({ chatId: "practice-fail", chatStore: { getChat: () => null } } as never, {
							engine,
							messages: [user],
							tools: {},
						});

			const { settled } = await runAgentTurn(agent);
			assert.equal(attempts, 2, `${kind} must stop after 1 retry`);
			assert.equal(settled.length, 2);
			const last = settled[1]!;
			assert.equal(last.role, "assistant");
			assert.equal(last.stopReason, "error");
			assert.equal(last.errorMessage, EMPTY_RESPONSE_ERROR_MESSAGE);
			assert.ok(failedResponseAtEnd(settled), `${kind} failure must trigger error banner`);
			assert.equal(endsInFailedTurn(settled), true, `${kind} failure must be retryable by user`);
		}
	});

	it("does not double-retry when inner stream already failed with stopReason=error (e.g. Antigravity)", async () => {
		const faux = createFauxCore({});
		let attempts = 0;
		faux.setResponses([
			() => {
				attempts++;
				return fauxAssistantMessage([fauxThinking("Thinking...")], {
					stopReason: "error",
					errorMessage: "Antigravity failed after retry",
				});
			},
			() => {
				attempts++;
				return fauxAssistantMessage([fauxText("Unexpected second attempt")]);
			},
		]);

		const user = newUserMessage("Hello");
		const agent = createProberAgent(
			{ chatId: "no-double-retry", searchAvailable: () => false } as never,
			{
				engine: { model: faux.getModel(), streamFn: faux.streamSimple },
				messages: [user],
				tools: {},
			},
		);

		const { settled } = await runAgentTurn(agent);
		assert.equal(attempts, 1);
		assert.equal(settled[1]?.role, "assistant");
		assert.equal(settled[1]?.stopReason, "error");
		assert.equal(settled[1]?.errorMessage, "Antigravity failed after retry");
	});

	it("respects subscription single-dispatch requestCycle and still converts thinking-only stop into error", async () => {
		const faux = createFauxCore({});
		let dispatches = 0;
		const user = { ...newUserMessage("Explain PCA"), id: "u-sub-1" };
		const cycle = new SubscriptionRequestCycle({
			initialMessages: [user],
			foregroundOwed: true,
			purpose: { background: false },
			scopeCurrent: () => true,
			restoreAutomatic() {},
		});

		faux.setResponses([
			() => {
				dispatches++;
				return fauxAssistantMessage([fauxThinking("Thinking only")], { stopReason: "stop" });
			},
			() => {
				dispatches++;
				return fauxAssistantMessage([fauxText("Must not dispatch twice in one subscription cycle")]);
			},
		]);

		const wrappedStreamFn: typeof faux.streamSimple = (model, context, options) => {
			const scope = { accountId: "acc", epoch: 1, authorityRevision: 1, selectedModelId: model.id };
			cycle.captured(scope);
			cycle.beforeDispatch(scope);
			return faux.streamSimple(model, context, options);
		};

		const agent = createTeacherAgent(undefined, {
			chatId: "sub-guard",
			messages: [user],
			tools: {},
			requestCycle: cycle,
			engine: { model: faux.getModel(), streamFn: wrappedStreamFn },
		});

		let settled: LhMessage[] = [];
		let doneResolve!: () => void;
		const done = new Promise<void>((resolve) => {
			doneResolve = resolve;
		});
		const handle = runPiTurn({
			agent,
			requestCycle: cycle,
			onFinish: (messages) => {
				settled = messages as LhMessage[];
				doneResolve();
			},
		});
		await new Response(handle.subscribe()).text();
		await done;

		assert.equal(dispatches, 1);
		assert.equal(settled.length, 2);
		assert.equal(settled[1]?.role, "assistant");
		assert.equal(settled[1]?.stopReason, "error");
		assert.equal(settled[1]?.errorMessage, EMPTY_RESPONSE_ERROR_MESSAGE);
	});

	it("wrapEmptyResponseGuard propagates upstream stream errors cleanly", async () => {
		const failing = wrapEmptyResponseGuard(() => {
			throw new Error("transport exploded");
		});
		const faux = createFauxCore({});
		const stream = failing(
			faux.getModel(),
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }),
			{},
		);
		const final = await stream.result();
		assert.equal(final.stopReason, "error");
		assert.equal(final.errorMessage, "transport exploded");
	});
});
