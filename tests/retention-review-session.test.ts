/**
 * Review-session creation + conclude capture (issue #33, retention) — the
 * vertical slice under an isolated temp LH_DATA_DIR, mirroring
 * practice-flow.test.ts's scripted harness:
 *
 *   GET /api/graph/reviews → due propositions → POST /api/chats with the
 *   due set as the practice session's explicit graph selection (the SAME
 *   picked-practice path — no new session kind) → a scripted practice turn
 *   pair (pose → conclude) whose conclude outcome lands in the review
 *   ledger (solved → Good; solvedWithHints → Hard), scoped to the
 *   session's picks. Pickless sessions capture nothing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ReviewEntry } from "../src/core/retention.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-retention-session-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
// The BYOK key-presence gate reads env-first (chat-flow.test.ts's idiom).
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { POST: postChat } = await import("../app/api/chats/route.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { stores } = await import("../src/server/stores.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { reviewStore } = await import("../src/store/reviews.ts");
const { createPracticeAgent } = await import("../src/agent/teacher-agent.ts");
const { reviewCapture } = await import("../src/server/retention.ts");
const { activeProblemOf } = await import("../src/core/native-messages.ts");
import type { PiEngine } from "../src/agent/models.ts";
const { ratingFromOutcome } = await import("../src/core/retention.ts");
const { GOOD, HARD, AGAIN } = await import("../src/core/fsrs.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.now();

function proposition(id: string, name: string) {
	graphStore.appendNode({
		id,
		name,
		statement: `${name} — the statement.`,
		aliases: [],
		createdAt: new Date(NOW - 30 * DAY).toISOString(),
		provenance: [],
	});
}

/** A seeded Review-state entry, `daysAgo` since last rating. */
function seededEntry(stabilityDays: number, lastReviewDaysAgo: number, reps = 3): ReviewEntry {
	const last = new Date(NOW - lastReviewDaysAgo * DAY);
	return {
		state: "Review",
		difficulty: 5,
		stability: stabilityDays,
		reps,
		lapses: 0,
		lastReviewAt: last.toISOString(),
		dueAt: new Date(last.getTime() + stabilityDays * DAY).toISOString(),
		updatedInSession: "chat_seed",
	};
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

/** POST acks and closes; drain the reattach stream (practice-flow's drainTurn). */
async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle) return;
	await new Response(handle.subscribe()).text();
}

function scripted(steps: FauxResponseStep[]) {
	const faux = createFauxCore({});
	const wrap = (step: FauxResponseStep) =>
		async (context: TranscriptContext): Promise<AssistantMessage> =>
			typeof step === "function"
				? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never)
				: step;
	faux.setResponses(steps.map(wrap));
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** The practice agent factory — the handler's practice branch's ctx,
 *  including the retention capture hook (reviewCapture over the real stores). */
function captureFactory(chatId: string, engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) =>
		createPracticeAgent(
			{
				chatId,
				chatStore,
				graphNodes: () => graphStore.readNodes(),
				onConclude: reviewCapture(stores, chatId),
			},
			{ ...opts, engine },
		);
}

describe("review-session creation and conclude capture", () => {
	it("the outcome → rating table is the brief's rule", () => {
		assert.equal(ratingFromOutcome("solved"), GOOD);
		assert.equal(ratingFromOutcome("solvedWithHints"), HARD);
		assert.equal(ratingFromOutcome("movedOn"), AGAIN);
		assert.equal(ratingFromOutcome("surrendered"), AGAIN);
		assert.equal(ratingFromOutcome("dismissed"), null);
	});

	it("due propositions become a picked practice session; concludes reschedule them", async () => {
		proposition("n_lagrange", "Lagrange's theorem");
		proposition("n_cauchy", "Cauchy's theorem");
		reviewStore.writeReviews({
			n_lagrange: seededEntry(2, 6), // overdue — due
			n_cauchy: seededEntry(30, 1), // fresh — not due
		});

		// The due surface (what the home affordance polls).
		const reviewsRoute = await import("../app/api/graph/reviews/route.ts");
		const status = (await (await reviewsRoute.GET()).json()) as {
			count: number;
			due: Array<{ id: string; name: string; statement: string }>;
		};
		assert.equal(status.count, 1);
		assert.equal(status.due[0]!.id, "n_lagrange");

		// The home affordance's creation: a practice session whose explicit
		// graph selection IS the due set (no new session kind).
		const created = await postChat(
			new Request("http://test/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Review my due material",
					kind: "practice",
					graphContext: { propositions: status.due.map((d) => ({ id: d.id, name: d.name, statement: d.statement })) },
				}),
			}),
		);
		assert.equal(created.status, 200);
		const { id: chatId } = (await created.json()) as { id: string };
		const record = chatStore.getChat(chatId)!;
		assert.equal(record.kind, "practice");
		const marker = record.messages[0] as { customType?: string; content?: string };
		assert.equal(marker.customType, "graph-context");
		assert.ok(marker.content!.includes("[n_lagrange]"), "the marker introduces the due proposition by id");
		chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });

		// A scripted practice pair: pose (targets the due proposition) …
		const engine = scripted([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(
							"problem",
							{
								statement: "State the constraint |G| puts on subgroup orders.",
								mode: "recall",
								target: ["n_lagrange"],
								modelSolution: "Subgroup orders divide |G|.",
							},
							{ id: "call-p1" },
						),
					],
					{ stopReason: "toolUse" },
				),
			// … the learner thinks, then conclude solved (→ Good) + wrap.
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(
							"conclude",
							{ outcome: "solved", verdict: "Credited.", rung: null, missClass: null, retest: false },
							{ id: "call-c1" },
						),
					],
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage([fauxText("Clean. Next when you're ready.")]),
		]);
		const factory = captureFactory(chatId, engine);

		await drainTurn(post(chatId, { type: "text", text: "ready" }), factory);
		assert.ok(activeProblemOf(chatStore.getChat(chatId)!.messages), "the pose landed");
		await drainTurn(post(chatId, { type: "thinking", problemCallId: "call-p1", text: "orders divide |G|" }), factory);

		// The capture: the due proposition was rescheduled (Good), the
		// untouched one keeps its seeded entry verbatim.
		const ledger = reviewStore.readReviews();
		const updated = ledger.n_lagrange!;
		assert.ok(updated, "the concluded target gained/kept an entry");
		assert.equal(updated.updatedInSession, chatId);
		assert.equal(updated.reps, 4, "solved counts as one Good review");
		assert.ok(updated.stability >= 2, "a Good review never shrinks stability");
		assert.notEqual(updated.dueAt, new Date(NOW - 4 * DAY).toISOString(), "dueAt moved off the past");
		assert.deepEqual(ledger.n_cauchy, seededEntry(30, 1), "an unpicked/untargeted proposition is untouched");
	});

	it("a hinted solve captures Hard; a pickless session captures nothing", async () => {
		proposition("n_orbit", "Orbit-stabilizer");
		reviewStore.writeReviews({ n_orbit: seededEntry(2, 6, 2) });

		// Picked session, hinted solve → Hard.
		const created = await postChat(
			new Request("http://test/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Review my due material",
					kind: "practice",
					graphContext: { propositions: [{ id: "n_orbit", name: "Orbit-stabilizer", statement: "The statement." }] },
				}),
			}),
		);
		const { id: chatId } = (await created.json()) as { id: string };
		chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const engine = scripted([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(
							"problem",
							{ statement: "Relate |orbit| and |stabilizer|.", mode: "recall", target: ["n_orbit"], modelSolution: "|orbit|·|stab| = |G|." },
							{ id: "call-p2" },
						),
					],
					{ stopReason: "toolUse" },
				),
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(
							"conclude",
							{ outcome: "solvedWithHints", verdict: "Credited after R1.", rung: "R1", missClass: null, retest: false },
							{ id: "call-c2" },
						),
					],
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage([fauxText("There.")]),
		]);
		await drainTurn(post(chatId, { type: "text", text: "go" }), captureFactory(chatId, engine));
		await drainTurn(post(chatId, { type: "thinking", problemCallId: "call-p2", text: "|orbit| times stabilizer…" }), captureFactory(chatId, engine));
		const hinted = reviewStore.readReviews().n_orbit!;
		assert.equal(hinted.updatedInSession, chatId);
		assert.equal(hinted.reps, 3, "solvedWithHints counts as one Hard review");

		// Pickless session: same pose/conclude, no graph-context picks —
		// the capture is scoped to the session's selection, so nothing lands.
		const before = reviewStore.readReviews();
		const bare = chatStore.createChat("topic practice", "practice");
		chatStore.saveSettings(bare.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const bareEngine = scripted([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(
							"problem",
							{ statement: "Why is the sky blue?", mode: "recall", target: ["n_orbit"], modelSolution: "Rayleigh scattering." },
							{ id: "call-p3" },
						),
					],
					{ stopReason: "toolUse" },
				),
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(
							"conclude",
							{ outcome: "solved", verdict: "Credited.", rung: null, missClass: null, retest: false },
							{ id: "call-c3" },
						),
					],
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage([fauxText("Done.")]),
		]);
		await drainTurn(post(bare.id, { type: "text", text: "go" }), captureFactory(bare.id, bareEngine));
		await drainTurn(post(bare.id, { type: "thinking", problemCallId: "call-p3", text: "scattering" }), captureFactory(bare.id, bareEngine));
		assert.deepEqual(reviewStore.readReviews(), before, "a pickless session schedules nothing");
	});
});
