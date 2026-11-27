/**
 * THE COMPACTION SERVICE (owner round 14, 2026-10-05): the trigger
 * plumbing — settle kick + turn-start gate, the registry mutex, the
 * summary call, usage, events. Pinned here with an injected summarizer
 * (the sub-agent one-shot needs a live engine; the SERVICE laws don't).
 *
 * The laws:
 * - the registry is a mutex: concurrent ensureCompacted → ONE summary;
 * - over-threshold → marker appended + usage logged + events emitted;
 * - under-threshold (or the projection post-marker) → no-op;
 * - chained compaction: the span carries the prior summary forward;
 * - the effective threshold: min(setting, window − reserve).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, type TestContext } from "node:test";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-compaction-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const {
	ensureCompacted,
	kickCompaction,
	awaitCompaction,
	compactionInFlight,
	effectiveThresholdTokens,
	projectedContextTokens,
} = await import("../src/server/compaction.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";
import { createFauxCore, fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
const { subscribe } = await import("../src/core/events.ts");
const { activeCompactionOf, newCompactionMarker, newUserMessage, measuredContextTokens, toLlmMessages, COMPACTED_HISTORY_HEADER, activeProblemOf, buildSubagentSteer, danglingQuestionOf, dismissedAnswer, endsInDismissal, newMessageId } = await import("../src/core/index.ts");
const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");
const artifactUiRoute = await import("../app/api/chats/[id]/artifact-ui/route.ts");
import type { LhMessage } from "../src/core/index.ts";
const { claimPreparingTurn } = await import("../src/server/turn-preparation.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

const big = (text: string, kb = 100): LhMessage => newUserMessage(`${text}: ${"x".repeat(kb * 1024)}`);

/** A chat whose record projects far over any test threshold. */
function overThresholdChat(label: string): string {
	const chat = chatStore.createChat(label);
	const messages = [big("m1"), big("m2"), big("m3"), newUserMessage("recent")];
	chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

let summarizeCalls = 0;
const depsOf = (chatId: string, thresholdTokens: number): CompactionDeps => ({
	chatStore,
	// The engine is never touched when summarize is injected (only its
	// identity rides the marker's provenance) — a minimal stand-in.
	engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
	modelId: "faux:test",
	kind: "teach",
	thresholdTokens,
	systemPromptTokens: 100,
	summarize: async (prompt) => {
		summarizeCalls++;
		assert.ok(prompt.includes("TRANSCRIPT") || prompt.length > 0);
		return {
			summary: `SUMMARY #${summarizeCalls}: the learner knows X.`,
			usage: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
	},
});

// ── the laws ────────────────────────────────────────────────────────────────

describe("the compaction service", () => {
	it("compares identical pre-compaction snapshots with reasoning accounting off and on", async (t) => {
		// A controlled comparison, not a claim about actual provider input tokens.
		// Both modes compact; the snapshot, model, threshold and summary are fixed.
		for (const provider of ["chatgpt", "openai"]) {
			const model = { provider, api: "openai-responses", id: "reasoning-comparison" };
			const snapshot = [{
				id: "initial", role: "user", content: "u".repeat(80_000), timestamp: 1,
			}, ...Array.from({ length: 30 }, (_, i) => ({
				id: `response-${i}`, role: "assistant", provider, api: model.api, model: model.id,
				content: [
					{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({
						type: "reasoning", id: `rs_${i}`, summary: [], encrypted_content: "synthetic-opaque-content",
					}) },
					{ type: "text", text: "a".repeat(4_000) },
				],
				stopReason: "stop", timestamp: i + 2,
				usage: { input: 20_100 + i * 5_000, output: 5_000, reasoning: 4_000,
					cacheRead: 0, cacheWrite: 0, totalTokens: 25_100 + i * 5_000 },
			}))] as LhMessage[];
			const frozenSnapshot = JSON.stringify(snapshot);
			for (const entrypoint of ["gate", "kick"]) {
				const outcomes = [];
				for (const includeReasoning of [undefined, false, true]) {
					const chat = chatStore.createChat("identical snapshot comparison");
					chatStore.saveMessages(chat.id, JSON.parse(frozenSnapshot));
					assert.deepEqual(chatStore.getChat(chat.id)!.messages, snapshot);
					let calls = 0;
					const summary = "The learner knows the earlier material.";
					const deps: CompactionDeps = {
						...depsOf(chat.id, 150_000), engine: { model } as CompactionDeps["engine"],
						modelId: `${provider}:${model.id}`, includeReasoning,
						summarize: async () => {
							calls++;
							return { summary, usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1_100,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
						},
					};
					const requestModel = deps.engine.model;
					assert.equal(projectedContextTokens(snapshot, 100, includeReasoning ? requestModel : undefined), 170_100,
						"the same provider usage triggers both modes; reasoning is already in output");
					if (entrypoint === "gate") await ensureCompacted(deps, chat.id);
					else { kickCompaction(() => deps, chat.id); await awaitCompaction(chat.id); }
					const after = chatStore.getChat(chat.id)!.messages;
					const marker = activeCompactionOf(after)!;
					assert.equal(calls, 1);
					assert.equal(marker.details.tokensBefore, 170_100);
					assert.equal(marker.details.firstKeptMessageId, includeReasoning ? "response-26" : "response-10");
					assert.equal(marker.content, `${COMPACTED_HISTORY_HEADER}\n\n${summary}`);
					assert.deepEqual(after.slice(0, -1), snapshot, "all original history and reasoning stay stored");
					const retained = toLlmMessages(after).filter((message) => message.role === "assistant");
					assert.equal(retained.length, includeReasoning ? 4 : 20);
					const retainedOutput = retained.reduce((sum, message) => sum + message.usage.output, 0);
					assert.equal(retainedOutput, includeReasoning ? 20_000 : 100_000);
					const projectionProxy = projectedContextTokens(after, 100, requestModel);
					assert.equal(projectionProxy, projectedContextTokens(after, 100) + retainedOutput - retained.length * 1_000,
						"a common output-usage proxy compares the retained tails without claiming provider measurement");
					assert.equal(measuredContextTokens(after), null, "compaction does not fabricate a new conversation measurement");
					outcomes.push({ retained: retained.length, retainedOutput, projectionProxy });
				}
				assert.deepEqual(outcomes[0], outcomes[1], "absent setting preserves off behavior");
				assert.equal(outcomes[1]!.projectionProxy - outcomes[2]!.projectionProxy, 80_000);
				t.diagnostic(`${provider}/${entrypoint}: off=${JSON.stringify(outcomes[1])}; on=${JSON.stringify(outcomes[2])}`);
			}
			assert.equal(JSON.stringify(snapshot), frozenSnapshot, "the common source snapshot stays unchanged");
		}
	});
	it("both entrypoints use reasoning-aware cuts and post-marker estimates only when enabled", async () => {
		const model = { provider: "chatgpt", api: "openai-responses", id: "reasoning-fixture" };
		for (const entrypoint of ["gate", "kick"]) {
			for (const postMarker of [false, true]) {
				for (const includeReasoning of [undefined, false, true]) {
					const label = `${entrypoint}, post-marker=${postMarker}, includeReasoning=${includeReasoning}`;
					const chat = chatStore.createChat(label);
					const messages = Array.from({ length: 6 }, (_, i) => ({
						id: `signed-${i}`, role: "assistant", provider: model.provider, api: model.api, model: model.id,
						content: [
							{ type: "thinking", thinking: "", thinkingSignature: "opaque-fixture" },
							{ type: "text", text: "answer" },
						],
						stopReason: "stop",
						usage: { input: 50_000, output: 10_000, cacheRead: 0, cacheWrite: 0, totalTokens: 60_000 },
						timestamp: i,
					}) as LhMessage);
					const prior = postMarker ? newCompactionMarker("Prior summary", {
						firstKeptMessageId: messages[0]!.id, tokensBefore: 100_000, at: "fixture",
					}) : null;
					if (prior) messages.push(prior);
					chatStore.saveMessages(chat.id, messages);
					const deps = {
						...depsOf(chat.id, 32_000), engine: { model } as CompactionDeps["engine"], includeReasoning,
					};
					if (entrypoint === "gate") await ensureCompacted(deps, chat.id);
					else {
						kickCompaction(() => deps, chat.id);
						await awaitCompaction(chat.id);
					}
					const after = chatStore.getChat(chat.id)!.messages;
					const marker = activeCompactionOf(after);
					if (includeReasoning) {
						assert.ok(marker, label);
						assert.notEqual(marker.id, prior?.id, label);
						assert.equal(marker.details.firstKeptMessageId, "signed-4", label);
						assert.ok(marker.details.tokensBefore >= 60_000, label);
						assert.deepEqual(after.slice(0, -1), messages, "stored reasoning and history stay intact");
					} else {
						assert.deepEqual(after, messages, `${label}: original estimator cannot advance this cut`);
					}
				}
			}
		}
	});

	it("all compaction entrypoints refuse to start while a preparation or teacher owns the session", async () => {
		for (const ownerKind of ["preparation", "teacher"] as const) {
			const chatId = overThresholdChat(`compact: live ${ownerKind}`);
			const prep = ownerKind === "preparation" ? claimPreparingTurn(chatId)! : null;
			if (!prep) assert.equal(beginTurn(chatId), true);
			const before = summarizeCalls;
			const original = chatStore.getChat(chatId)!.messages;
			try {
				await ensureCompacted(depsOf(chatId, 40_000), chatId);
				kickCompaction(() => depsOf(chatId, 40_000), chatId);
				await awaitCompaction(chatId);
				assert.equal(summarizeCalls, before);
				assert.deepEqual(chatStore.getChat(chatId)!.messages, original);
				assert.equal(compactionInFlight(chatId), false);
			} finally { if (prep) prep.finish(); else endTurn(chatId); }
		}
	});

	it("a stalled competing preflight rechecks ownership at actual compaction start after its await", async () => {
		const chatId = overThresholdChat("compact: late competing preflight");
		const deps = depsOf(chatId, 40_000);
		const before = summarizeCalls;
		// Both requests passed their earlier request-level checks. The losing
		// preflight is parked at ensureCompacted's structural await, while the
		// accepted answer claims ownership and saves durable grading output.
		const competingPreflight = ensureCompacted(deps, chatId);
		const prep = claimPreparingTurn(chatId)!;
		assert.ok(prep);
		const accepted = [...chatStore.getChat(chatId)!.messages, newUserMessage("accepted grade/teacher output")];
		chatStore.saveMessages(chatId, accepted);
		try {
			await competingPreflight;
			assert.equal(summarizeCalls, before, "stale preflight cannot launch a summary behind the accepted answer");
			assert.deepEqual(chatStore.getChat(chatId)!.messages, accepted);
			assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
		} finally { prep.finish(); }
		await ensureCompacted(deps, chatId);
		assert.equal(summarizeCalls, before + 1, "compaction remains eligible after the owner settles");
	});

	it("a competing preflight waiting for an existing compaction cannot restart it behind the winning owner", async () => {
		const chatId = overThresholdChat("compact: competing structural wait");
		const deps = depsOf(chatId, 40_000);
		const before = summarizeCalls;
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const initial = ensureCompacted({ ...deps, summarize: async (prompt, engine) => {
			entered();
			await gate;
			return { ...await deps.summarize!(prompt, engine), summary: "" };
		} }, chatId);
		await started;
		const owner: { prep: ReturnType<typeof claimPreparingTurn> } = { prep: null };
		let accepted: LhMessage[] = [];
		// The winning preflight finishes its structural wait first, claims the
		// existing turn gate, and saves its grade before the loser resumes.
		const winner = (async () => {
			await awaitCompaction(chatId);
			owner.prep = claimPreparingTurn(chatId);
			assert.ok(owner.prep);
			accepted = [...chatStore.getChat(chatId)!.messages, newUserMessage("accepted answer grading")];
			chatStore.saveMessages(chatId, accepted);
		})();
		let competingDone = false;
		const competitor = ensureCompacted(deps, chatId).then(() => { competingDone = true; });
		try {
			await Promise.resolve();
			assert.equal(competingDone, false, "existing in-flight compaction is still structurally awaited");
			release();
			await winner;
			await competitor;
			await initial;
			assert.equal(summarizeCalls, before + 1, "only the already-running summary was admitted");
			assert.deepEqual(chatStore.getChat(chatId)!.messages, accepted);
			assert.equal(activeCompactionOf(accepted), null);
		} finally { release(); await initial; owner.prep?.finish(); }
	});

	it("ownership is rechecked after synchronous start hooks as well as awaits", async () => {
		for (const entrypoint of ["preflight", "background"] as const) {
			const chatId = overThresholdChat(`compact: start seam ${entrypoint}`);
			const owner: { prep: ReturnType<typeof claimPreparingTurn> } = { prep: null };
			const deps = { ...depsOf(chatId, 40_000), canStart: () => { owner.prep ??= claimPreparingTurn(chatId); return true; } };
			const before = summarizeCalls;
			try {
				if (entrypoint === "preflight") await ensureCompacted(deps, chatId);
				else kickCompaction(() => deps, chatId);
				await awaitCompaction(chatId);
				assert.equal(summarizeCalls, before);
				assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
			} finally { owner.prep?.finish(); }
		}
	});

	it("background eligibility skips both entrypoints without writes, but still awaits an existing structural run", async () => {
		const chatId = overThresholdChat("compact: consent off");
		const before = summarizeCalls;
		const denied = { ...depsOf(chatId, 40_000), canStart: () => false };
		await ensureCompacted(denied, chatId); kickCompaction(() => denied, chatId);
		assert.equal(summarizeCalls, before);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((done) => { release = done; });
		const started = new Promise<void>((done) => { entered = done; });
		const allowed = { ...depsOf(chatId, 40_000), summarize: async (prompt: string) => { entered(); await gate; return depsOf(chatId, 40_000).summarize!(prompt, denied.engine); } };
		kickCompaction(() => allowed, chatId); await started;
		let finished = false;
		const waiter = ensureCompacted(denied, chatId).then(() => { finished = true; });
		await Promise.resolve(); assert.equal(finished, false);
		release(); await waiter; assert.equal(finished, true);
	});
	it("over-threshold record → marker appended, usage logged, both events emitted", async () => {
		const chatId = overThresholdChat("compact: basic");
		const events: string[] = [];
		const off = subscribe((e) => {
			const { chatId: c, running } = e as { chatId?: string; running?: boolean };
			if (e.type === "compaction-changed" && c === chatId) events.push(`${running}`);
			if (e.type === "record-changed" && c === chatId) events.push("record");
		});
		await ensureCompacted(depsOf(chatId, 40_000), chatId);
		off();

		const record = chatStore.getChat(chatId)!;
		const marker = activeCompactionOf(record.messages);
		assert.ok(marker, "the marker landed");
		assert.ok(marker!.content.includes("SUMMARY #"));
		assert.ok(marker!.details.tokensBefore > 40_000, "provenance carries the trigger reading");
		assert.equal(marker!.details.model, "faux:test");
		// the projection now fits: the dropped span is gone from the wire view
		assert.ok(projectedContextTokens(record.messages, 100) < 40_000, "the cut brought the projection under threshold+summary");
		// usage landed on the money channel, keyed by the marker
		assert.ok((record.turns ?? []).some((t) => t.messageId === marker!.id && t.model === "faux:test"), "usage keyed by the marker");
		// events: running true → record-changed → running false
		assert.deepEqual(events, ["true", "record", "false"]);
	});

	it("under-threshold record → a no-op (no marker, no summary call)", async () => {
		const chatId = overThresholdChat("compact: under");
		const before = summarizeCalls;
		await ensureCompacted(depsOf(chatId, 10_000_000), chatId);
		assert.equal(summarizeCalls, before);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
	});

	it("includes prospective side cargo in the trigger but never records or summarizes that undelivered cargo", async () => {
		const chat = chatStore.createChat("compact: prospective side exchanges");
		chatStore.saveMessages(chat.id, [big("old lesson 1", 40), big("old lesson 2", 40), big("old lesson 3", 40), newUserMessage("recent lesson")]);
		const original = chatStore.getChat(chat.id)!.messages;
		const cargo = newUserMessage(`UNDELIVERED SIDE EXCHANGES ${"s".repeat(90 * 1024)}`);
		const deps = depsOf(chat.id, 45_000);
		assert.ok(projectedContextTokens(original, deps.systemPromptTokens) < deps.thresholdTokens);
		let summarized = "";
		await ensureCompacted({ ...deps,
			projectMessages: (record) => [...record.messages, cargo],
			summarize: async (prompt, engine) => { summarized = prompt; return deps.summarize!(prompt, engine); },
		}, chat.id);
		const saved = chatStore.getChat(chat.id)!.messages;
		assert.deepEqual(saved.slice(0, original.length), original);
		assert.ok(activeCompactionOf(saved)); assert.doesNotMatch(summarized, /UNDELIVERED SIDE EXCHANGES/);
		assert.ok(!saved.some((message) => message.id === cargo.id));
		assert.ok(projectedContextTokens([...saved, cargo], deps.systemPromptTokens) < deps.thresholdTokens);
	});

	it("composes reasoning options with prospective side cargo without cutting or summarizing the undelivered exchanges", async () => {
		const responses = { provider: "openai", api: "openai-responses", id: "side-reasoning-fixture" };
		for (const identity of ["matching", "wrong-provider", "wrong-model", "wrong-api", "openrouter"] as const) {
			const target = identity === "wrong-provider" ? { ...responses, provider: "another-provider" }
				: identity === "wrong-model" ? { ...responses, id: "another-model" }
				: identity === "wrong-api" ? { ...responses, api: "openai-completions" }
				: identity === "openrouter" ? { ...responses, provider: "openrouter", api: "openai-completions" } : responses;
			const stored = identity === "openrouter" ? target : responses;
			for (const includeReasoning of [undefined, false, true]) {
				const label = `${identity}, includeReasoning=${includeReasoning}`;
				const chat = chatStore.createChat(label);
				const history = Array.from({ length: 6 }, (_, index) => ({
					...fauxAssistantMessage("a".repeat(400)), id: `signed-${index}`, provider: stored.provider, api: stored.api, model: stored.id,
					content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque-only-not-a-token-count" }, { type: "text", text: "a".repeat(400) }],
					usage: { input: 50_000, output: 10_000, reasoning: 9_000, cacheRead: 0, cacheWrite: 0, totalTokens: 60_000 },
				}) as LhMessage);
				const prior = newCompactionMarker("Prior summary", { firstKeptMessageId: history[0]!.id, tokensBefore: 100_000, at: "fixture" });
				const original = [...history, prior]; chatStore.saveMessages(chat.id, original);
				const cargo = newUserMessage(`UNDELIVERED SIDE EXCHANGES ${"s".repeat(40_000)}`);
				const deps: CompactionDeps = { ...depsOf(chat.id, 65_000), engine: { model: target } as CompactionDeps["engine"], includeReasoning };
				const estimateModel = includeReasoning ? deps.engine.model : undefined;
				assert.ok(projectedContextTokens(original, 100, estimateModel) < deps.thresholdTokens, label);
				const projected = projectedContextTokens([...original, cargo], 100, estimateModel);
				const shouldCompact = includeReasoning === true && identity === "matching";
				assert.equal(projected > deps.thresholdTokens, shouldCompact, "the post-marker reasoning floor plus new cargo—not a usage anchor—triggers this gate");
				let summaries = 0, summaryInput = "";
				await ensureCompacted({ ...deps, projectMessages: (record) => [...record.messages, cargo], summarize: async (prompt, engine) => {
					summaries++; summaryInput = prompt; return deps.summarize!(prompt, engine);
				} }, chat.id);
				const after = chatStore.getChat(chat.id)!.messages;
				assert.deepEqual(after.slice(0, original.length), original, label);
				assert.equal(summaries, shouldCompact ? 1 : 0, label);
				assert.ok(!after.some((message) => message.id === cargo.id));
				assert.doesNotMatch(summaryInput, /UNDELIVERED SIDE EXCHANGES/);
				if (shouldCompact) {
					const marker = activeCompactionOf(after)!;
					assert.equal(marker.details.tokensBefore, projected);
					assert.equal(marker.details.firstKeptMessageId, "signed-4", "cut uses saved history and its selected-model floor, never cargo");
					assert.ok(projectedContextTokens([...after, cargo], 100, estimateModel) < deps.thresholdTokens);
				} else assert.deepEqual(after, original, label);
			}
		}
	});

	it("adds prospective side cargo once to a valid usage anchor regardless of reasoning opt-in", () => {
		const model = { provider: "openai", api: "openai-responses", id: "anchored-side" } as CompactionDeps["engine"]["model"];
		const assistant = { ...fauxAssistantMessage("answer"), id: "anchor", provider: model.provider, api: model.api, model: model.id,
			content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque" }, { type: "text", text: "answer" }],
			usage: { input: 50_000, output: 10_000, reasoning: 9_000, cacheRead: 0, cacheWrite: 0, totalTokens: 60_000 },
		} as LhMessage;
		const cargo = newUserMessage("s".repeat(40_000));
		for (const estimateModel of [undefined, model]) {
			assert.equal(projectedContextTokens([assistant], 100, estimateModel), 60_000);
			assert.equal(projectedContextTokens([assistant, cargo], 100, estimateModel), 70_000, "do not add output/reasoning/ciphertext again to already-counted usage");
		}
	});

	for (const eligibility of ["eligible", "background disabled", "under threshold"] as const) {
	it(`a concurrent fresh preflight (${eligibility}) waits for the summary started after its initial structural check`, async () => {
		const chatId = overThresholdChat(`compact: fresh preflight wait race ${eligibility}`);
		const deps = depsOf(chatId, 40_000);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const first = ensureCompacted({ ...deps, summarize: async (prompt, engine) => {
			entered();
			await gate;
			return deps.summarize!(prompt, engine);
		} }, chatId);
		// Both calls see no running compaction at the first structural check.
		// Their await continuations resume in order: first starts the stalled
		// summary; second must join it, not return to grading admission.
		let secondReturned = false;
		const secondDeps = {
			...deps,
			canStart: () => eligibility !== "background disabled",
			thresholdTokens: eligibility === "under threshold" ? 10_000_000 : deps.thresholdTokens,
		};
		const second = ensureCompacted(secondDeps, chatId).then(() => { secondReturned = true; });
		try {
			await started;
			await Promise.resolve();
			assert.equal(compactionInFlight(chatId), true);
			assert.equal(secondReturned, false, "competing ensureCompacted returned during the newly started summary");
		} finally {
			release();
			await Promise.all([first, second]);
		}
		assert.equal(secondReturned, true);
		assert.equal(compactionInFlight(chatId), false);
	});
	}

	it("the registry is a mutex: concurrent ensureCompacted → ONE summary", async () => {
		const chatId = overThresholdChat("compact: mutex");
		const before = summarizeCalls;
		const deps = depsOf(chatId, 40_000);
		await Promise.all([ensureCompacted(deps, chatId), ensureCompacted(deps, chatId), ensureCompacted(deps, chatId)]);
		assert.equal(summarizeCalls, before + 1, "exactly one summary however many gates race");
	});

	it("concurrent prospective gates both await the same summary rather than releasing a teacher early", async () => {
		const chatId = overThresholdChat("compact: concurrent gate wait");
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((done) => { release = done; });
		const started = new Promise<void>((done) => { entered = done; });
		const base = depsOf(chatId, 40_000);
		const deps = { ...base, summarize: async (prompt: string) => { entered(); await gate; return base.summarize!(prompt, base.engine); } };
		let firstDone = false, secondDone = false;
		const first = ensureCompacted(deps, chatId).then(() => { firstDone = true; });
		const second = ensureCompacted(deps, chatId).then(() => { secondDone = true; });
		await started; await Promise.resolve(); await Promise.resolve();
		assert.equal(firstDone, false); assert.equal(secondDone, false);
		release(); await Promise.all([first, second]);
	});

	it("awaitCompaction: a later call rides the in-flight one (the structural gate)", async () => {
		const chatId = overThresholdChat("compact: gate");
		const events: string[] = [];
		const off = subscribe((e) => {
			const { chatId: c, running } = e as { chatId?: string; running?: boolean };
			if (e.type === "compaction-changed" && c === chatId) events.push(`${running}`);
		});
		const p = ensureCompacted(depsOf(chatId, 40_000), chatId);
		await awaitCompaction(chatId); // rides the same promise
		await p;
		off();
		assert.deepEqual(events, ["true", "false"], "no second compaction started");
	});

	it("chained compaction: the span carries the PRIOR summary forward", async () => {
		const chatId = overThresholdChat("compact: chained");
		let seenPrompt = "";
		const deps: CompactionDeps = {
			...depsOf(chatId, 40_000),
			summarize: async (prompt) => {
				seenPrompt = prompt;
				return {
					summary: "SECOND SUMMARY.",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
			},
		};
		// first compaction
		await ensureCompacted({ ...depsOf(chatId, 40_000) }, chatId);
		// grow the record past the threshold again (post-markers + new tail)
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, big("m9"), big("m10"), big("m11")]);
		// second compaction — the span must open with the FIRST summary
		await ensureCompacted(deps, chatId);
		assert.ok(seenPrompt.includes("prior compaction summary"), "the prior summary rides the span");
		assert.ok(seenPrompt.includes(COMPACTED_HISTORY_HEADER), "as the marker's canonical text");
		assert.equal(seenPrompt.split(COMPACTED_HISTORY_HEADER).length - 1, 1, "the prior summary is supplied exactly once");
		const record = chatStore.getChat(chatId)!;
		const markers = record.messages.filter((m) => (m as { customType?: string }).customType === "compaction");
		assert.equal(markers.length, 2, "both markers persist (history is never rewritten)");
		assert.ok(activeCompactionOf(record.messages)!.content.includes("SECOND SUMMARY"), "the newest rules");
	});

	it("ten successive compactions keep one summary on the wire and preserve the complete record", async () => {
		const chat = chatStore.createChat("repeated-cycle fixture");
		chatStore.saveMessages(chat.id, Array.from({ length: 20 }, (_, i) => big(`exchange-${i}`, 8)));
		let calls = 0;
		const deps: CompactionDeps = {
			...depsOf(chat.id, 150_000),
			summarize: async (prompt) => {
				assert.equal(prompt.split(COMPACTED_HISTORY_HEADER).length - 1, calls === 0 ? 0 : 1);
				if (calls > 0) assert.ok(prompt.includes(`SUMMARY-${calls}.`), "only the immediately prior summary rides forward");
				return {
					summary: `SUMMARY-${++calls}.`,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
			},
		};
		for (let cycle = 1; cycle <= 10; cycle++) {
			const messages = [...chatStore.getChat(chat.id)!.messages];
			if (cycle > 1) messages.push(big(`growth-${cycle}`, 8));
			// Controlled provider readings trigger compaction while the visible
			// retained tail advances slowly enough to contain older markers.
			messages.push({ id: `usage-${cycle}`, role: "assistant", content: [{ type: "text", text: "measured response" }], stopReason: "stop", usage: { input: 150_001, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 150_002 }, timestamp: cycle } as LhMessage);
			chatStore.saveMessages(chat.id, messages);
			await ensureCompacted(deps, chat.id);
			assert.equal(calls, cycle);
			const record = chatStore.getChat(chat.id)!;
			assert.deepEqual(record.messages.slice(0, -1), messages, "every original message and marker remains stored");
			assert.equal(record.messages.filter((m) => m.role === "custom" && m.customType === "compaction").length, cycle);
			const wire = JSON.stringify(toLlmMessages(record.messages));
			assert.equal(wire.split(COMPACTED_HISTORY_HEADER).length - 1, 1, `cycle ${cycle}: one summary on the wire`);
			assert.ok(wire.includes(`SUMMARY-${cycle}.`));
			assert.equal(measuredContextTokens(record.messages), null, "committing a marker invalidates pre-compaction readings");
		}
	});

	it("a resolved prior summary replaces all summary markers in the newly superseded span", async () => {
		const chat = chatStore.createChat("summary span fixture");
		const kept = big("previously retained");
		const details = { firstKeptMessageId: kept.id, tokensBefore: 150_000, at: "fixture" };
		const steer: LhMessage = { id: "steer", role: "custom", customType: "subagent-steer", content: "RESEARCH DELIVERY", display: true, details: {}, timestamp: 1 };
		const messages = [big("discarded"), kept, newCompactionMarker("SUPERSEDED SUMMARY", details), steer, newCompactionMarker("LATEST SUMMARY", details), big("growth"), big("recent")];
		chatStore.saveMessages(chat.id, messages);
		let seenPrompt = "";
		await ensureCompacted({ ...depsOf(chat.id, 40_000), summarize: async (prompt, engine) => {
			seenPrompt = prompt;
			return depsOf(chat.id, 40_000).summarize!(prompt, engine);
		} }, chat.id);
		assert.ok(seenPrompt.includes("previously retained"));
		assert.ok(seenPrompt.includes("RESEARCH DELIVERY"), "non-compaction context markers still ride the span");
		assert.ok(!seenPrompt.includes("SUPERSEDED SUMMARY"));
		assert.equal(seenPrompt.split("LATEST SUMMARY").length - 1, 1);
		assert.equal(seenPrompt.split(COMPACTED_HISTORY_HEADER).length - 1, 1);
		assert.deepEqual(chatStore.getChat(chat.id)!.messages.slice(0, -1), messages);
	});

	it("an unresolved cutoff preserves legacy summary text in the next compaction input", async () => {
		const chat = chatStore.createChat("legacy summary fixture");
		const legacy = newCompactionMarker("LEGACY-ONLY INFORMATION", { firstKeptMessageId: "missing", tokensBefore: 150_000, at: "fixture" });
		const messages = [big("old"), legacy, big("recent"), newUserMessage("latest")];
		chatStore.saveMessages(chat.id, messages);
		let seenPrompt = "";
		await ensureCompacted({ ...depsOf(chat.id, 40_000), summarize: async (prompt, engine) => {
			seenPrompt = prompt;
			return depsOf(chat.id, 40_000).summarize!(prompt, engine);
		} }, chat.id);
		assert.equal(seenPrompt.split("LEGACY-ONLY INFORMATION").length - 1, 1);
		assert.ok(!seenPrompt.includes("prior compaction summary"), "no separate prior summary exists for an unresolved cutoff");
		assert.deepEqual(chatStore.getChat(chat.id)!.messages.slice(0, -1), messages);
	});

	it("the production summarizer rejects a length-stopped checkpoint and a complete retry can commit", async () => {
		const chatId = overThresholdChat("incomplete summary fixture");
		await ensureCompacted(depsOf(chatId, 40_000), chatId);
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, big("growth 1"), big("growth 2")]);
		const faux = createFauxCore({});
		const { summarize: _injected, ...base } = depsOf(chatId, 40_000);
		const deps: CompactionDeps = { ...base, engine: { model: faux.getModel(), streamFn: faux.streamSimple } };
		const before = chatStore.getChat(chatId)!;
		assert.ok(activeCompactionOf(before.messages), "the failed replacement must preserve an existing checkpoint too");
		const events: string[] = [];
		const off = subscribe((event) => {
			const { chatId: id, running } = event as { chatId?: string; running?: boolean };
			if (event.type === "compaction-changed" && id === chatId) events.push(`${running}`);
		});
		// Exercise the actual zero-tool summarizer with an offline provider;
		// NODE_ENV=test otherwise deliberately skips non-injected summaries.
		const env: Record<string, string | undefined> = process.env;
		const originalNodeEnv = env.NODE_ENV;
		env.NODE_ENV = "development";
		try {
			faux.setResponses([fauxAssistantMessage("INCOMPLETE SUMMARY", { stopReason: "length" })]);
			await ensureCompacted(deps, chatId);
			assert.deepEqual(chatStore.getChat(chatId), before, "an explicitly unfinished summary must not become a checkpoint");
			assert.equal(compactionInFlight(chatId), false, "the failed run releases its gate");
			assert.deepEqual(events, ["true", "false"]);
			faux.setResponses([fauxAssistantMessage("COMPLETE SUMMARY")]);
			await ensureCompacted(deps, chatId);
			const record = chatStore.getChat(chatId)!;
			assert.ok(activeCompactionOf(record.messages)!.content.includes("COMPLETE SUMMARY"));
			assert.deepEqual(record.messages.slice(0, -1), before.messages);
			assert.ok(!JSON.stringify(record.messages).includes("INCOMPLETE SUMMARY"));
		} finally {
			if (originalNodeEnv === undefined) delete env.NODE_ENV;
			else env.NODE_ENV = originalNodeEnv;
			off();
		}
	});

	it("effectiveThresholdTokens: the setting rules big windows; the window rule binds small ones", () => {
		assert.equal(effectiveThresholdTokens(150_000, 200_000), 150_000);
		assert.equal(effectiveThresholdTokens(150_000, 100_000), 100_000 - 16_384);
		assert.equal(effectiveThresholdTokens(undefined, 200_000), 150_000);
		assert.equal(effectiveThresholdTokens(undefined, undefined), 150_000);
	});

	it("kickCompaction: fire-and-forget, registry-set, over-threshold only", async () => {
		const chatId = overThresholdChat("compact: kick");
		const before = summarizeCalls;
		let built = 0;
		kickCompaction(() => {
			built++;
			return depsOf(chatId, 40_000);
		}, chatId);
		assert.equal(built, 1, "deps built once");
		await awaitCompaction(chatId);
		assert.equal(summarizeCalls, before + 1);
		// beneath threshold now → a second kick builds its deps, the
		// pre-check refuses, and NO summary runs (building deps is the
		// kick's discovery step — the run is what costs)
		const afterFirst = summarizeCalls;
		kickCompaction(() => {
			built++;
			return depsOf(chatId, 40_000);
		}, chatId);
		assert.equal(summarizeCalls, afterFirst, "post-compaction record is under threshold — no run");
		// a null deps build (engineless) is a silent no-op
		kickCompaction(() => null, chatId);
	});

	it("a usage-heavy zero cut does not spend or append a marker", async () => {
		const chat = chatStore.createChat("no-progress fixture");
		const assistant = { id: "measured", role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 120_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 120_001 }, timestamp: 1 } as LhMessage;
		chatStore.saveMessages(chat.id, [newUserMessage("tiny visible history"), assistant]);
		const before = summarizeCalls;
		await ensureCompacted(depsOf(chat.id, 40_000), chat.id);
		assert.equal(summarizeCalls, before);
		assert.equal(activeCompactionOf(chatStore.getChat(chat.id)!.messages), null);
		assert.equal(measuredContextTokens(chatStore.getChat(chat.id)!.messages), 120_001);
	});

	it("starting/failing compaction preserves the meter; committing its marker clears it, regardless of summary usage", async () => {
		const id = overThresholdChat("meter validity fixture");
		const assistant = { id: "measured", role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 120_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 120_001 }, timestamp: 1 } as LhMessage;
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, assistant]);
		let release!: () => void;
		const gate = new Promise<void>((done) => { release = done; });
		const deps = depsOf(id, 40_000);
		const running = ensureCompacted({ ...deps, summarize: async () => {
			await gate;
			throw new Error("fixture failure");
		} }, id);
		assert.equal(measuredContextTokens(chatStore.getChat(id)!.messages), 120_001);
		release(); await running;
		assert.equal(measuredContextTokens(chatStore.getChat(id)!.messages), 120_001);
		await ensureCompacted(deps, id);
		const record = chatStore.getChat(id)!;
		assert.ok(record.turns!.at(-1)!.steps[0]!.inputTokens! > 0);
		assert.equal(measuredContextTokens(record.messages), null);
	});

	it("a summarizer failure leaves the record untouched and the gate re-arms", async () => {
		const chatId = overThresholdChat("compact: fail");
		const before = summarizeCalls;
		const failing: CompactionDeps = {
			...depsOf(chatId, 40_000),
			summarize: async () => {
				throw new Error("boom");
			},
		};
		await ensureCompacted(failing, chatId);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null, "no marker on failure");
		// the next gate retries cleanly
		await ensureCompacted(depsOf(chatId, 40_000), chatId);
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages));
		assert.equal(summarizeCalls, before + 1);
	});
});

// Issue #518: the learner can skip or toggle while the summary call runs.
describe("learner writes while compaction runs", () => {
	/** Over-threshold chat ending in `tail`, with a kicked compaction held
	 *  inside its summary call until `finish()`. */
	async function compactingChat(t: TestContext, label: string, ...tail: LhMessage[]) {
		const id = overThresholdChat(label);
		const original = [...chatStore.getChat(id)!.messages, ...tail];
		chatStore.saveMessages(id, original);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((done) => { release = done; });
		const started = new Promise<void>((done) => { entered = done; });
		const deps = depsOf(id, 40_000);
		// A failed route/assertion must not strand this chat's compaction.
		t.after(async () => { release(); await awaitCompaction(id); });
		kickCompaction(() => ({
			...deps,
			summarize: async (prompt, engine) => { entered(); await gate; return deps.summarize!(prompt, engine); },
		}), id);
		await started;
		return { id, finish: async () => {
			const savedDuringSummary = chatStore.getChat(id)!.messages;
			assert.equal(compactionInFlight(id), true, "the learner's save preceded summary completion");
			release();
			await awaitCompaction(id);
			const record = chatStore.getChat(id)!;
			const marker = activeCompactionOf(record.messages);
			assert.ok(marker, "compaction landed");
			assert.equal(record.messages[original.length]!.id, marker.id, "the marker stays at the original transcript boundary");
			assert.deepEqual(record.messages.slice(0, original.length), savedDuringSummary.slice(0, original.length), "in-place edits and the original transcript survive");
			assert.deepEqual(record.messages.slice(original.length + 1), savedDuringSummary.slice(original.length), "all concurrent appends survive after the marker, in order");
			assert.ok(record.turns?.some((turn) => turn.messageId === marker.id), "summary usage still keys to the committed marker");
		} };
	}
	const post = (route: typeof dismissRoute, id: string, input: unknown) =>
		route.POST(new Request(`http://test/api/chats/${id}`, { method: "POST", body: JSON.stringify({ input }) }), { params: Promise.resolve({ id }) });
	const toolCallMessage = (callId: string, name: string, args: ToolCall["arguments"]): LhMessage =>
		({ ...fauxAssistantMessage({ type: "toolCall", id: callId, name, arguments: args }), id: newMessageId() });
	const quiz = (callId: string) =>
		toolCallMessage(callId, "quiz", { question: "Q?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A is right." });

	it("a skipped question stays skipped", async (t) => {
		const { id, finish } = await compactingChat(t, "518: question skip", quiz("q-518"));
		const res = await post(dismissRoute, id, { type: "dismiss", toolCallId: "q-518", answer: dismissedAnswer("quiz", "Q?") });
		assert.equal(res.status, 200);
		await finish();
		const messages = chatStore.getChat(id)!.messages;
		assert.ok(activeCompactionOf(messages), "compaction landed");
		assert.equal(danglingQuestionOf(messages), null, "the skip survived compaction");
	});

	it("a skip during compaction leaves the chat paused, same as a skip after it", async (t) => {
		const { id, finish } = await compactingChat(t, "518: skip pause", quiz("q-518-pause"));
		const res = await post(dismissRoute, id, { type: "dismiss", toolCallId: "q-518-pause", answer: dismissedAnswer("quiz", "Q?") });
		assert.equal(res.status, 200);
		assert.equal(endsInDismissal(chatStore.getChat(id)!.messages), true, "the saved skip pauses the chat before compaction commits");
		await finish();
		assert.equal(endsInDismissal(chatStore.getChat(id)!.messages), true, "job deliveries still hold until the learner speaks");
	});

	it("a discarded practice problem stays discarded", async (t) => {
		const problem = toolCallMessage("p-518", "problem", { statement: "Prove |G|=p ⇒ cyclic", mode: "recall" });
		const posed: LhMessage = { id: newMessageId(), role: "toolResult", toolCallId: "p-518", toolName: "problem", content: [{ type: "text", text: "Problem posed." }], details: null, isError: false, timestamp: Date.now() };
		const { id, finish } = await compactingChat(t, "518: problem skip", problem, posed);
		const res = await post(dismissRoute, id, { type: "dismiss-problem", problemCallId: "p-518" });
		assert.equal(res.status, 200);
		await finish();
		const messages = chatStore.getChat(id)!.messages;
		assert.ok(activeCompactionOf(messages), "compaction landed");
		assert.equal(activeProblemOf(messages), null, "the discard survived compaction");
	});

	it("the invert switch stays on", async (t) => {
		const steer = buildSubagentSteer({ id: "j-518", kind: "demo", toolCallId: "c-518" }, { title: "T", html: "<p>x</p>", tested: true });
		const { id, finish } = await compactingChat(t, "518: invert", steer);
		const res = await post(artifactUiRoute, id, { messageId: steer.id, inverted: true });
		assert.equal(res.status, 200);
		await finish();
		const messages = chatStore.getChat(id)!.messages;
		const saved = messages.find((m) => m.id === steer.id) as { details: { ui?: { inverted?: boolean } } };
		assert.ok(activeCompactionOf(messages), "compaction landed");
		assert.equal(saved.details.ui?.inverted, true, "the switch survived compaction");
	});
});
