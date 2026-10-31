/**
 * The extraction pipeline tests (vision §1 construction, 2026-09-02 redesign;
 * relinked 2026-09-27): extractor → auditor → merger, the sole graph writer —
 * the extractor alone sees the source (whole-session markdown), the auditor
 * never does (identity linking through graph tools), the merger is
 * deterministic.
 *
 *   transcriptView  — the markdown rendering the extractor sees (pure):
 *                     id-anchored Teacher/Learner blocks + check blocks
 *   pipeline        — scripted faux engines drive both agents: findings out,
 *                     audit verdict (with linkTo identity) in, deterministic
 *                     merge applied; failure paths checkpoint nothing;
 *                     single-flight per chat
 *
 * The merger itself (identity verdicts, idempotency) is tested in
 * tests/graph.test.ts directly against mergeFindings — here it is the
 * integration: what one full pipeline run does to the ledgers.
 *
 * Ledger: in-memory (the GraphStore port) — this suite never touches
 * data/graph. Chats: real ChatRecords in the real chat store (created and
 * deleted by this suite).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall, type Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newPlanBlockMessage } from "../src/core/native-messages.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import type {
	AuditVerdicts,
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,

	NotesSource,
	SessionCheckpoint,
	SessionFindings,
} from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import {
	abortExtraction,
	createExtractionPipeline,
	NotesImportError,
	extractionStatuses,
	transcriptView,
	sourceDigest,
	EXTRACTION_CORE,
	SESSION_PREAMBLE,
	SESSION_MESSAGE_ID_RULE,
	NOTES_PREAMBLE,
	EXTRACTOR_INSTRUCTIONS,
	NOTES_EXTRACTOR_INSTRUCTIONS,
} from "../src/agent/subagents/extraction.ts";
import { getGraph, simplifyChains } from "../src/core/graph.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, providerKeyMissing, type ModelSlotName } from "../src/core/settings.ts";
import { coverageOf, coverageSlots, messageViewLines } from "../src/core/coverage.ts";
import { chatStore } from "../src/store/chats.ts";
import { subscribe } from "../src/core/events.ts";
import { PATHS } from "../config.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const createdChats: string[] = [];

/** A scripted pi engine (faux provider, docs/pi-engine-swap.md §7): the
 *  response queue replaces the old doGenerate turn counter. Usage is
 *  ESTIMATED by faux from the prompt/response text (deterministic, > 0) —
 *  the tests assert structure and positivity, not flat mock numbers. */
function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** An in-memory GraphStore (core/ports.ts) — this suite never touches data/graph. */
function memoryLedgers() {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const coverage: CoverageEntry[] = [];
	const sources = new Map<string, NotesSource>();
	const positions = new Map<string, { x: number; y: number }>();
		return {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendChain: (c: GraphChain) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		appendCheckpoint: (c: SessionCheckpoint) => void checkpoints.push(c),
		readCheckpoints: () => checkpoints.map((c) => ({ ...c })),
		// Extraction coverage (vision-extraction-coverage.md) — append-only;
		// the chat pipeline checkpoints one entry per covered message.
		appendCoverage: (e) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
		upsertSource: (s: NotesSource) => {
			// Mirrors the real store: an upsert KEEPS the existing usage log.
			const prev = sources.get(s.id);
			sources.set(s.id, { ...s, extractions: [...(prev?.extractions ?? [])] });
		},
		readSources: () => [...sources.values()].map((s) => ({ ...s, extractions: [...(s.extractions ?? [])] })),
		deleteSources: (ids: ReadonlySet<string>) => [...ids].reduce((count, id) => count + Number(sources.delete(id)), 0),
		appendSourceUsage: (id: string, entry: ExtractionRunUsage) => {
			const source = sources.get(id);
			if (!source) return;
			if (!source.extractions?.some((r) => r.startedAt === entry.startedAt)) {
				source.extractions = [...(source.extractions ?? []), entry];
			}
		},
		// Cluster labelings — mirrors the real store: append dedupes by id.
		// The layout ledger — settleGraphLayout writes it after each merge.
		readPositions: () => Object.fromEntries([...positions].map(([id, p]) => [id, { ...p }])),
		writePositions: (next) => {
			positions.clear();
			for (const [id, p] of Object.entries(next)) positions.set(id, { x: p.x, y: p.y });
		},
		// The destructive seam (wave 6 session deletion) — mirrors the real
		// store: replace the provided ledgers' full contents.
		rewriteLedgers: (next) => {
			if (next.nodes) nodes.splice(0, nodes.length, ...next.nodes.map((n) => ({ ...n, provenance: [...n.provenance], aliases: [...n.aliases] })));
			if (next.chains) chains.splice(0, chains.length, ...next.chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })));
			if (next.coverage) coverage.splice(0, coverage.length, ...next.coverage.map((c) => ({ ...c })));
			if (next.checkpoints) checkpoints.splice(0, checkpoints.length, ...next.checkpoints.map((c) => ({ ...c })));
		},
	} satisfies GraphStore;
}

// Native fixture builders (Wave B): the record holds pi-native history —
// an assistant message with its tool calls + one result message per call;
// the projection reproduces the part shapes these view tests pin.
interface NativeCallDesc {
	name: string;
	toolCallId: string;
	input: Record<string, unknown>;
	output: unknown;
}

function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: Date.now() } as never;
}

function assistant(id: string, items: unknown[]): LhMessage[] {
	const content: unknown[] = [];
	const calls: NativeCallDesc[] = [];
	for (const item of items) {
		const it = item as { type?: string; text?: string };
		if (it && it.type === "text") {
			content.push({ type: "text", text: it.text });
		} else {
			const call = item as NativeCallDesc;
			calls.push(call);
			content.push({ type: "toolCall", id: call.toolCallId, name: call.name, arguments: call.input as never });
		}
	}
	const out: LhMessage[] = [
		{
			id,
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: Date.now(),
		} as never,
	];
	for (const call of calls) {
		out.push({
			id: `r_${call.toolCallId}`,
			role: "toolResult",
			toolCallId: call.toolCallId,
			toolName: call.name,
			content: [{ type: "text", text: "ok" }],
			details: call.output,
			isError: false,
			timestamp: Date.now(),
		} as never);
	}
	return out;
}

function quizPart(toolCallId: string, input: Record<string, unknown>, output: Record<string, unknown>): NativeCallDesc {
	return { name: "quiz", toolCallId, input, output };
}

function planPart(toolCallId: string, name: string, input: Record<string, unknown>, tree: unknown): NativeCallDesc {
	return { name, toolCallId, input, output: { ok: true, tree } };
}

/** A session-shaped fixture chat: probe → teaching text → check. Tree-blind
 *  world: the plan tree is NOT part of extraction — it is noise. */
function fixtureChat() {
	const chat = chatStore.createChat("Extraction fixture");
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, [
		user("u1", "teach me the chain rule"),
		...assistant("a1", [
			{ type: "text", text: "The chain rule composes rates of change along a path." },
			quizPart("probe-1", { question: "What is a derivative, roughly?" }, {
				kind: "quiz", questionText: "What is a derivative, roughly?",
				correct: false, dontKnow: false, answeredAt: "2026-08-22T01:00:00.000Z",
			}),
		]),
		// Distinct TURNS: the native grouping canon merges consecutive
		// assistant messages into one view group, so the fixture separates
		// its turns with learner messages (the real record's shape).
		user("u2", "go on"),
		...assistant("a2", [
			{ type: "text", text: "The derivative measures how fast a function changes." },
			planPart("p1", "plan_init", { nodes: [], edges: [] }, { nodes: [], edges: [], currentNodeId: null, doneNodeIds: [], version: 1 }),
		]),
		user("u3", "check me"),
		...assistant("a3", [
			quizPart("check-1", { question: "Check" }, {
				kind: "quiz", questionText: "Check", correct: true, dontKnow: false,
				answeredAt: "2026-08-22T02:00:00.000Z",
			}),
		]),
	].flat());
	return { chatId: chat.id, record: chatStore.getChat(chat.id)! };
}

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(`${PATHS.chats}/${id}.json`);
		} catch {
			/* already gone */
		}
	}
});

/** What the extractor SUBMITS for the fixture session (owner redesign,
 *  2026-09-30): propositions + REASONING CHAINS on the wire — one chain
 *  (p1 ⟹ p2). Each proposition carries its passage anchor (2026-10-13):
 *  the fixture's teacher-prose messages are a1 (chain rule prose) and a2
 *  (derivative prose) — p1 anchors to a2, p2 to a1. */
const FINDINGS = {
	propositions: [
		{
			id: "p1",
			name: "Derivative",
			statement: "The derivative measures how fast a function changes",
			aliases: [],
			messageId: "a2",
		},
		{
			id: "p2",
			name: "Chain rule",
			statement: "The chain rule differentiates composed functions by multiplying local rates.",
			aliases: [],
			messageId: "a1",
		},
	],
	chains: [
		{
			premises: ["p1"],
			conclusion: "p2",
		},
	],
};

/** An engine whose ONE response is the `name` tool call with the given
 *  input — the whole deliverable; the pipeline stops after a clean submit
 *  (shouldStop), so no trailing text step exists anymore. `onCall` fires at
 *  the moment of the model call — the observation point for mid-run
 *  assertions. */
function submitModel(name: string, input: unknown, onCall?: () => void): PiEngine {
	return fauxEngine([
		(context) => {
			onCall?.();
			void context;
			return fauxAssistantMessage(
				[fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })],
				{ stopReason: "toolUse" },
			);
		},
	]);
}

/** A submit model whose single response WAITS on a gate before answering —
 *  the timing control for the serialized-audit tests (owner 2026-09-28):
 *  the model call has STARTED (onCall fired, the run holds the audit
 *  gate) but will not resolve until the test opens the gate. */
function gatedSubmitModel(name: string, input: unknown, gate: Promise<void>, onCall?: () => void): PiEngine {
	return fauxEngine([
		async () => {
			onCall?.();
			await gate;
			return fauxAssistantMessage(
				[fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })],
				{ stopReason: "toolUse" },
			);
		},
	]);
}

/** Poll until true — the queued-phase observations need real ticks. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
	for (const t0 = Date.now(); !cond(); ) {
		if (Date.now() - t0 > ms) throw new Error("condition never became true in time");
		await new Promise((r) => setTimeout(r, 2));
	}
}

/** An engine whose model call never resolves until its abort signal fires
 *  — mimicking a cancelled provider request (the abort path). Like a real
 *  provider, an ALREADY-aborted signal resolves immediately (the abort can
 *  win the race before the call attaches its listener); the faux stream
 *  then sees the aborted signal and ends the message as aborted. */
function hangingModel(): PiEngine {
	return fauxEngine([
		(_context, options) =>
			new Promise((resolve) => {
				const sig = options?.signal;
				if (sig?.aborted) {
					resolve(fauxAssistantMessage("late"));
					return;
				}
				sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
			}),
	]);
}

/** An engine that never calls a tool (the failure path). */
function silentModel(): PiEngine {
	return fauxEngine([fauxAssistantMessage("I refuse to use tools"), fauxAssistantMessage("…")]);
}

// ─── transcriptView (pure) ───────────────────────────────────────────────────

describe("transcriptView (pure — teacher prose only, owner 2026-09-28)", () => {
	it("renders ONLY the teacher's prose — no learner, no checks, no tool notes", () => {
		const { record } = fixtureChat();
		const view = transcriptView(record);

		// The document header is the session title; the body is the
		// teacher's text blocks as labeled passages.
		assert.match(view, /^# Extraction fixture$/m);
		assert.match(view, /^TEACHER \[a1\] The chain rule composes rates of change along a path\.$/m);
		assert.match(view, /^TEACHER \[a2\] The derivative measures how fast a function changes\.$/m);

		// MESSAGE-ID LABELS (owner, 2026-10-13): the passages carry their
		// ACTUAL message ids, in exactly messageViewLines' shape — the same
		// seam the coverage fingerprints hash. No label without prose: a3
		// (quiz only) and the learner messages are not passages.
		assert.doesNotMatch(view, /TEACHER \[a3\]/);
		assert.doesNotMatch(view, /TEACHER \[u1\]/);
		assert.equal(
			view.slice(view.indexOf("TEACHER")),
			record.messages.flatMap((m) => messageViewLines(m, m.id)).join("\n\n"),
			"the view body IS the messageViewLines of the transcript — one shared seam",
		);

		// EVERYTHING else is gone: learner text, quiz blocks, tool notes,
		// speaker headers — the ruling strips it all.
		assert.doesNotMatch(view, /teach me the chain rule/);
		assert.doesNotMatch(view, /go on/);
		assert.doesNotMatch(view, /check me/);
		assert.doesNotMatch(view, /### /);
		assert.doesNotMatch(view, /Quiz/);
		assert.doesNotMatch(view, /plan_init/);
	});

	it("job tool results and empty text vanish — only prose paragraphs remain", () => {
		const chat = chatStore.createChat("View noise fixture");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			user("u1", "go"),
			...assistant("a1", [
				{
					name: "research",
					toolCallId: "r1",
					input: { question: "q" },
					output: { brief: "long brief", sources: [] },
				},
				{ type: "text", text: "   " },
				{ type: "text", text: "Prose survives." },
			]),
		].flat());
		const view = transcriptView(chatStore.getChat(chat.id)!);
		assert.match(view, /^TEACHER \[a1\] Prose survives\.$/m, "the surviving passage is labeled with its real id");
		assert.doesNotMatch(view, /research/);
		assert.doesNotMatch(view, /long brief/);
		assert.doesNotMatch(view, /### /);
	});
});

// ─── the pipeline ───────────────────────────────────────────────────────────

describe("the extraction pipeline (extractor → auditor → merger)", () => {
	it("push S5: every registry mutation announces activity-changed; reads stay silent", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [] };
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
		});

		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "activity-changed") announces++;
		});
		// A read announces nothing (reads are silent — the bus hygiene law).
		extractionStatuses();
		assert.equal(announces, 0);

		await pipeline.runExtraction(chatId);
		// The run announced its lifecycle: setPhase at registration and every
		// phase transition, finishExtraction at the exit — several events,
		// and NONE after settle (the registry is empty; nothing left to say).
		assert.ok(announces >= 2, `phases + finish announced (got ${announces})`);
		const afterSettle = announces;
		extractionStatuses();
		assert.equal(announces, afterSettle, "reads stay silent");
		off();
	});

	it("stringified-payload heal (owner, 2026-09-28): propositions arriving as ONE JSON string still validate and merge", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [] };

		// The weak-model failure from the OpenRouter log: the whole array
		// emitted as a JSON-STRING ("propositions.0: must be object").
		// pi-agent-core's prepareArguments shim runs BEFORE TypeBox — the
		// heal parses it, validation passes, no retry burned.
		const extractor = submitModel("submit_findings", {
			propositions: JSON.stringify(FINDINGS.propositions),
			chains: FINDINGS.chains,
		});

		const pipeline = createExtractionPipeline({ chatStore, graphStore: ledgers, extractor, auditor: submitModel("submit_review", verdict) });
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(stats, { nodes: 2, chains: 1 });
	});

	it("stringified-payload heal: the CHAINS array arriving as ONE JSON string still validates (redesign, 2026-09-30)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = submitModel("submit_findings", {
			propositions: FINDINGS.propositions,
			chains: JSON.stringify(FINDINGS.chains),
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("runs end to end: findings → audit verdict (identity) → deterministic merge + checkpoint", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		// The auditor passes p1 through and LINKS it to a pre-existing node
		// (identity verdict); p2 stays a verdict-free create.
		const existingId = "n_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const verdict: AuditVerdicts = {
			links: [{ id: FINDINGS.propositions[0]!.id, linkTo: existingId }],
		};

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
		});
		const stats = await pipeline.runExtraction(chatId);

		// VERDICTS-ONLY (2026-09-28): findings merge in FULL — the linked
		// p1 creates no node, p2 creates one, and the extractor's edge
		// resolves through them. (The old echo form could silently drop
		// content by omitting it; that accidental drop channel is gone.)
		assert.deepEqual(stats, { nodes: 1, chains: 1 });

		// Link-append: the phrasing joined the existing node's aliases and
		// the provenance unioned; p2's create line is its own node.
		assert.equal(ledgers.readNodes().length, 3); // pre-seeded + link line + p2's create
		const linkedLines = ledgers.readNodes().filter((n) => n.id === existingId);
		assert.ok(
			linkedLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId)),
			"the link-append unions provenance",
		);
		// ANCHORS (2026-10-13): both lines carry their proposition's passage
		// id — p1's link-append anchors to a2 (its passage), p2's create to a1.
		assert.ok(
			linkedLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId && pt.messageId === "a2")),
			"the link-append line carries p1's passage id",
		);
		const created = ledgers.readNodes().find((n) => n.name === "Chain rule")!;
		assert.deepEqual(created.provenance, [{ chatId, messageId: "a1" }], "the created node anchors to p2's passage");

		// COVERAGE checkpointed per message (not a whole-chat checkpoint):
		// one entry per transcript message, fingerprinted content each —
		// the same turns are never extracted twice.
		const record = chatStore.getChat(chatId)!;
		const covered = ledgers.readCoverage();
		// Wave D: the coverage unit is the VISIBLE native message — bonded
		// riders with no view lines (a textless call message) are context,
		// never checkpointed.
		const visible = record.messages.filter(
			(m) => messageViewLines(m, m.id).length > 0,
		).length;
		assert.equal(covered.length, visible);
		assert.ok(covered.every((c) => c.chatId === chatId && c.fp.length === 64 && c.tokens > 0));
		assert.equal(ledgers.readCheckpoints().length, 0, "the chat path writes coverage, not the legacy checkpoint");

		assert.equal(
			coverageOf(record.messages, covered, chatId).uncoveredCount,
			0,
			"every message is now covered",
		);
	});

	it("BYOK refusal: no stage engines anywhere → the run throws honestly before any stage (owner, 2026-09-22)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		// No direct engines AND no engineFor — the chain came up empty.
		const pipeline = createExtractionPipeline({ chatStore, graphStore: ledgers });
		await assert.rejects(pipeline.runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ModelsNotConfiguredError);
			assert.deepEqual(err.envelope.missing, ["cheap"]); // extractor + auditor, both cheap-tier
			assert.equal(err.envelope.code, "models_not_configured");
			return true;
		});
		// nothing ran: no phase residue, no usage, no coverage writes
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("key-presence refusal: a stage engine whose provider key is gone throws before any batch (provider-key interlude, 2026-09-25)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = fauxEngine([]);
		const auditor = fauxEngine([]);
		const seen: Array<[string, ModelSlotName]> = [];
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor,
			providerKeyMissing: (provider, tier) => {
				seen.push([provider, tier]);
				return providerKeyMissing(provider, [tier]);
			},
		});
		await assert.rejects(pipeline.runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ProviderKeyMissingError);
			assert.equal(err.envelope.code, "provider_key_missing");
			assert.equal(err.envelope.provider, extractor.model.provider, "the provider of the keyless engine");
			assert.deepEqual(err.envelope.slots, ["cheap"], "extractor + auditor are the cheap tier");
			return true;
		});
		// FIRST offender surfaces (extractor before auditor) — and nothing
		// ran: the refusal lands before any batch, no coverage writes.
		assert.deepEqual(seen, [[extractor.model.provider, "cheap"]]);
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("key-presence pass-through: null from the check lets a stage through — the NEXT keyless stage surfaces (first-offender discipline)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([]),
			auditor: fauxEngine([]),
			providerKeyMissing: (provider, tier) => (calls++ < 1 ? null : providerKeyMissing(provider, [tier])),
		});
		await assert.rejects(pipeline.runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ProviderKeyMissingError, "the auditor's refusal surfaces after the extractor passed");
			return true;
		});
		assert.equal(calls, 2, "both stages were checked, in order");
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("the LLM cluster-namer is DEAD (wave 7): a merge mints no naming runs — labels are session names now", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		// Empty verdicts: everything creates (verdicts-only, 2026-09-28).
		const verdict: AuditVerdicts = { links: [] };
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(stats, { nodes: 2, chains: 1 }); // full findings merge (verdicts-only)
		// Wave 7 (950ddfd): birth-session clusters carry session-name labels,
		// so the post-merge naming garnish is gone — no model spend, no
		// naming-run records, no label writes.
	});



	it("engineFor fills the stages (model slots wave): the chain replaces config pins", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [] };
		const consulted: string[] = [];
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			// NO direct values — the stages resolve ENTIRELY through engineFor
			// (the role override → slot → factory-pin chain, read fresh per
			// stage call in production; here, the scripted chain).
			engineFor: (role) => {
				consulted.push(role);
				if (role === "extractor") return submitModel("submit_findings", FINDINGS);
				if (role === "auditor") return submitModel("submit_review", verdict);
				return submitModel("submit_labels", { labels: [] });
			},
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.equal(stats.nodes, 2, "the chain-fed pipeline ran end to end — both propositions merged");
		// The stages were resolved through the chain, in pipeline order
		// (extractor → auditor; the labeler is fire-and-forget
		// garnish for any other role).
		assert.deepEqual(consulted.slice(0, 2), ["extractor", "auditor"]);
	});

	it("direct test values still WIN over engineFor (the priority pin)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [] };
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
			// If the direct values did NOT win, this throw would surface.
			engineFor: (role) => {
				throw new Error(`engineFor should not be consulted for ${role} when a direct value is set`);
			},
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.equal(stats.nodes, 2, "the direct-value seams ran, untouched by engineFor");
	});

	it("a failing stage is ISOLATED (per-chunk jobs, owner 2026-09-28): the job fails, nothing merges — and a sibling batch still merges", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: silentModel(), // never submits the review
		});
		// The old run-level throw is gone: one failed job is absorbed at
		// the fan-out — the run resolves with what actually merged (zeros).
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0, "no checkpoint — the next trigger re-runs");
		assert.equal(ledgers.readCoverage().length, 0);

		const failingExtractor = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: silentModel(),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await failingExtractor.runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(ledgers.readCheckpoints().length, 0);

		// THE isolation pin: a two-batch chat whose SECOND extractor call
		// never submits — batch 1 still merges, batch 2 stays uncovered
		// (honestly re-runnable). Count at stream-INVOKE time: readiness
		// probes mint engines without ever calling them.
		const { chatId: chunkyId, record } = chunkyChat();
		let invocations = 0;
		const findings = findingsStep();
		const refuse = fauxAssistantMessage("I refuse to use tools");
		const countingStep: FauxResponseStep = (context, options, state, model) => {
			invocations++;
			const step = invocations === 1 ? findings : refuse;
			return typeof step === "function" ? step(context, options, state, model) : step;
		};
		const mixed = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			// 4096 budget: the fixture is sized to split in two (the factory
			// default again — halved back from the digest-era 8192, owner
			// 2026-10-13).
			getChunkTokens: () => 4096,
			engineFor: (role) =>
				role === "extractor"
					? fauxEngine([countingStep])
						: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await mixed.runExtraction(chunkyId), { nodes: 2, chains: 1 }, "batch 1's merge survives batch 2's failure");
		assert.equal(invocations, 2);
		assert.equal(ledgers.readCoverage().length, 3, "batch 1 checkpointed its three messages");
		assert.equal(
			coverageOf(record.messages, ledgers.readCoverage(), chunkyId).uncoveredCount,
			2,
			"batch 2's messages stay uncovered for the next run",
		);
	});

	it("reports its phase through the status registry while running, and clears it when done", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const existingId = "n_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const seen: (string | undefined)[] = [];
		const phaseOf = () => extractionStatuses().find((r) => r.chatId === chatId)?.phase;
		const verdict: AuditVerdicts = {
			links: [{ id: FINDINGS.propositions[0]!.id, linkTo: existingId }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			// Each stage's first generate is the observation point: the
			// registry must already carry this chat at the right phase.
			extractor: submitModel("submit_findings", FINDINGS, () => seen.push(phaseOf())),
			auditor: submitModel("submit_review", verdict, () => seen.push(phaseOf())),
		});
		await pipeline.runExtraction(chatId);
		assert.deepEqual(seen, ["extracting", "auditing"]);
		assert.equal(extractionStatuses().length, 0, "the registry clears when the run ends");
	});

	it("serialized audit (owner 2026-09-28): a second run QUEUES at the gate; its auditor explores the graph only AFTER the first run's merge", async () => {
		const a = fixtureChat();
		const b = fixtureChat();
		const ledgers = memoryLedgers();

		const single = (id: string, name: string, statement: string) => ({
			propositions: [{ id, name, statement, aliases: [], messageId: "a1" }],
			chains: [],
		});
		const findingsA = single("pa", "Alpha claim", "Alpha statement, full precision");
		const findingsB = single("pb", "Beta claim", "Beta statement, full precision");

		let gateOpen!: () => void;
		const gate = new Promise<void>((resolve) => (gateOpen = resolve));
		let aAuditing = false;
		const pipelineA = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", findingsA),
			auditor: gatedSubmitModel("submit_review", { links: [] }, gate, () => {
				aAuditing = true;
			}),
		});
		const runA = pipelineA.runExtraction(a.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === a.chatId && r.phase === "auditing"));
		assert.ok(aAuditing, "run A holds the gate — its audit model call is in flight");

		let bAuditorCalled = false;
		let bSawAlphasMerge = false;
		const pipelineB = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", findingsB),
			// THE pin: when B's auditor is finally invoked, A's merge must
			// already be in the ledgers — B explores the post-merge graph,
			// which is the entire point of the gate.
			auditor: submitModel("submit_review", { links: [] }, () => {
				bAuditorCalled = true;
				bSawAlphasMerge = ledgers.readNodes().some((n) => n.name === "Alpha claim");
			}),
		});
		const runB = pipelineB.runExtraction(b.chatId);

		await until(() => extractionStatuses().some((r) => r.chatId === b.chatId && r.phase === "waiting"));
		assert.ok(!bAuditorCalled, "B's auditor has not been invoked — it queues behind A");
		assert.equal(ledgers.readNodes().filter((n) => n.name === "Beta claim").length, 0, "nothing of B merged yet");
		assert.equal(extractionStatuses().find((r) => r.chatId === a.chatId)?.phase, "auditing", "A still audits while B waits");

		gateOpen();
		assert.deepEqual(await runA, { nodes: 1, chains: 0 });
		assert.deepEqual(await runB, { nodes: 1, chains: 0 });
		assert.ok(bAuditorCalled);
		assert.ok(bSawAlphasMerge, "B's auditor saw A's merged node — audit serialized after merge");
		assert.equal(extractionStatuses().length, 0, "both runs left the registry");
	});

	it("serialized audit: a run ABORTED while waiting never audits — and the queue chain stays healthy for successors", async () => {
		const a = fixtureChat();
		const b = fixtureChat();
		const c = fixtureChat();
		const ledgers = memoryLedgers();

		const single = (id: string, name: string, statement: string) => ({
			propositions: [{ id, name, statement, aliases: [], messageId: "a1" }],
			chains: [],
		});

		let gateOpen!: () => void;
		const gate = new Promise<void>((resolve) => (gateOpen = resolve));
		const pipelineA = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", single("pa", "Alpha claim", "Alpha statement")),
			auditor: gatedSubmitModel("submit_review", { links: [] }, gate),
		});
		const runA = pipelineA.runExtraction(a.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === a.chatId && r.phase === "auditing"));

		let bAuditorCalled = false;
		const pipelineB = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", single("pb", "Beta claim", "Beta statement")),
			auditor: submitModel("submit_review", { links: [] }, () => {
				bAuditorCalled = true;
			}),
		});
		const runB = pipelineB.runExtraction(b.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === b.chatId && r.phase === "waiting"));

		// The dock's abort button, pressed while B queues.
		assert.equal(abortExtraction(b.chatId), true);
		assert.deepEqual(await runB, { nodes: 0, chains: 0 }, "aborted before auditing — zero emissions");
		assert.ok(!bAuditorCalled, "B's auditor was never invoked");
		assert.ok(!extractionStatuses().some((r) => r.chatId === b.chatId), "B left the registry");
		assert.equal(ledgers.readCoverage().some((row) => row.chatId === b.chatId), false, "B checkpointed nothing");

		// The chain link B abandoned still resolved: A finishes, and a
		// THIRD run audits normally — no deadlock residue.
		gateOpen();
		assert.deepEqual(await runA, { nodes: 1, chains: 0 });
		const pipelineC = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", single("pc", "Gamma claim", "Gamma statement")),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipelineC.runExtraction(c.chatId), { nodes: 1, chains: 0 });
	});

	it("captures per-stage usage live, persists the run's usage into the chat record", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const existingId = "n_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const usageSeen: (number | undefined)[] = [];
		const verdict: AuditVerdicts = {
			links: [{ id: FINDINGS.propositions[0]!.id, linkTo: existingId }],
		};
		const nativeUsage: Record<"extractor" | "auditor", Usage[]> = { extractor: [], auditor: [] };
		const recordUsage = (stage: "extractor" | "auditor", engine: PiEngine): PiEngine => ({
			...engine,
			streamFn: (model, context, options) => {
				const stream = engine.streamFn(model, context, options);
				void stream.result().then((message) => nativeUsage[stage].push(message.usage));
				return stream;
			},
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			// During the auditor's generate, the registry must already carry
			// the extractor's fully accumulated live usage (2 steps × 10/5).
			extractor: recordUsage("extractor", submitModel("submit_findings", FINDINGS)),
			auditor: recordUsage("auditor", submitModel("submit_review", verdict, () =>
				usageSeen.push(extractionStatuses().find((r) => r.chatId === chatId)?.usage.extractor?.steps.at(-1)?.inputTokens),
			)),
		});
		await pipeline.runExtraction(chatId);

		// Live: mid-audit the extractor's usage was fully accumulated (faux
		// estimates tokens from the prompt/response text — deterministic,
		// positive, with native first-conversation cache writes in 1.4).
		assert.equal(usageSeen.length, 1);
		assert.ok(typeof usageSeen[0] === "number" && usageSeen[0]! > 0, "the extractor's step billed input tokens");

		// Persisted: the run appended ONE usage entry to the chat's
		// extractions log — per-stage model + steps, with merge stats.
		const record = chatStore.getChat(chatId)!;
		assert.equal(record.extractions?.length, 1);
		const run = record.extractions![0]!;
		assert.equal(run.stats?.nodes, 1); // p2 created; p1 linked, not created
		// the scripted engine's model, provider-qualified (model slots wave)
		assert.equal(run.stages.extractor.model, "faux:faux-1");
		assert.equal(run.stages.extractor.steps.length, 1); // the submit call — the run STOPS after a clean submit
		const step = run.stages.extractor.steps[0]!;
		assert.ok(step.inputTokens! > 0 && step.outputTokens! > 0, "estimated usage captured");
		assert.equal(step.cacheReadTokens, 0);
		assert.equal(nativeUsage.extractor.length, 1);
		assert.ok(nativeUsage.extractor[0]!.cacheWrite > 0, "fresh native conversation writes its cached prefix");
		assert.equal(step.cacheReadTokens, nativeUsage.extractor[0]!.cacheRead);
		assert.equal(step.cacheWriteTokens, nativeUsage.extractor[0]!.cacheWrite);
		assert.equal(step.reasoningTokens, 0);
		assert.equal(nativeUsage.auditor.length, 1);
		assert.equal(run.stages.auditor.steps[0]!.cacheReadTokens, 0, "auditor owns a fresh conversation too");
		assert.ok(nativeUsage.auditor[0]!.cacheWrite > 0);
		assert.equal(run.stages.auditor.steps[0]!.cacheReadTokens, nativeUsage.auditor[0]!.cacheRead);
		assert.equal(run.stages.auditor.steps[0]!.cacheWriteTokens, nativeUsage.auditor[0]!.cacheWrite);
		assert.equal(run.stages.auditor.steps.length, 1);
		assert.ok(!Number.isNaN(Date.parse(run.at)));
	});

	it("aborts mid-run: cancels the model call, persists partial usage, checkpoints nothing", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: hangingModel(), // hangs until aborted — no step finishes
			auditor: submitModel("submit_review", { links: [] }),
		});
		const runPromise = pipeline.runExtraction(chatId);

		// The registry entry exists synchronously after the call (setPhase
		// runs before the first await); abort is TRUE cancellation.
		assert.equal(abortExtraction(chatId), true);
		const stats = await runPromise;

		// A deliberate stop, not a failure: zero emissions, no throw.
		assert.deepEqual(stats, { nodes: 0, chains: 0 });
		assert.equal(extractionStatuses().length, 0, "the registry clears");
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		assert.equal(ledgers.readCheckpoints().length, 0, "nothing checkpointed — the next trigger re-runs");

		// Partial usage still persisted (money was spent): stats absent,
		// no completed steps in either stage.
		const record = chatStore.getChat(chatId)!;
		assert.equal(record.extractions?.length, 1);
		const run = record.extractions![0]!;
		assert.equal(run.stats, undefined);
		assert.equal(run.stages.extractor.steps.length, 0);
		assert.equal(run.stages.auditor.steps.length, 0);

		// Aborting a non-running chat is an idempotent no-op.
		assert.equal(abortExtraction(chatId), false);
	});

	it("is single-flight per chat — a concurrent second run is a no-op", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		// The extractor's first call hangs until we release it.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const gatedExtractor = fauxEngine([
			async () => {
				calls++;
				if (calls === 1) await gate;
				return fauxAssistantMessage("…");
			},
		]);

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: gatedExtractor,
			auditor: silentModel(),
		});

		const first = pipeline.runExtraction(chatId);
		const second = await pipeline.runExtraction(chatId); // in-flight → zeros
		assert.deepEqual(second, { nodes: 0, chains: 0 });

		release();
		// The gated extractor never submits — an ISOLATED job failure now
		// (per-chunk jobs, owner 2026-09-28): the run resolves with zeros
		// instead of throwing.
		assert.deepEqual(await first, { nodes: 0, chains: 0 });
	});

	it("registers runs on the process-wide registry (route-instance safety): a second pipeline instance sees the same single-flight state", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		// Gated extractor: the first call hangs until released, so the run
		// stays registered while we observe it.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const gatedExtractor = fauxEngine([
			async () => {
				calls++;
				if (calls === 1) await gate;
				return fauxAssistantMessage("…");
			},
		]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: gatedExtractor,
			auditor: silentModel(),
		});
		// A SECOND instance over DIFFERENT ledgers — the observer a separate
		// route entry's module instance is in dev (the turn-liveness lesson:
		// module instances split; globalThis does not).
		const observer = createExtractionPipeline({
			chatStore,
			graphStore: memoryLedgers(),
			extractor: silentModel(),
			auditor: silentModel(),
		});

		const first = pipeline.runExtraction(chatId);
		// The synchronous prefix (setPhase at batch start) registers BEFORE
		// the first await — the run is visible the moment it starts.
		assert.ok(
			extractionStatuses().some((run) => run.chatId === chatId && run.phase === "extracting"),
			"the run is registered at start",
		);
		const g = globalThis as { __lhExtractionRuns?: { running: Map<string, unknown> } };
		assert.ok(g.__lhExtractionRuns?.running.has(chatId), "the registry lives on globalThis — no module-instance split can hide runs");
		assert.deepEqual(await observer.runExtraction(chatId), { nodes: 0, chains: 0 }, "single-flight spans pipeline instances");

		release();
		assert.deepEqual(await first, { nodes: 0, chains: 0 }, "isolated job failure — the run resolves zeros");
		assert.ok(!extractionStatuses().some((run) => run.chatId === chatId), "the registry entry clears when the run ends (however it ends)");
		assert.ok(!g.__lhExtractionRuns?.running.has(chatId), "nothing leaks into the global registry");
	});

	it("throws for unknown chats", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: silentModel(),
			auditor: silentModel(),
		});
		await assert.rejects(pipeline.runExtraction("chat_does_not_exist"), /Chat not found/);
	});
});

// ─── message anchors (messageId — owner, 2026-10-13) ────────────────────────

describe("message anchors (session propositions carry their passage's id)", () => {
	/** A single-proposition submit with an explicit anchor. */
	const anchored = (messageId: string) => ({
		propositions: [
			{ id: "p1", name: "Anchor claim", statement: "Anchor claim, full precision.", aliases: [], messageId },
		],
		chains: [],
	});

	/** One scripted extractor turn: a submit_findings tool call. */
	const submitStep = (payload: unknown): FauxResponseStep => () =>
		fauxAssistantMessage(
			[fauxToolCall("submit_findings", payload as ToolCall["arguments"], { id: "anchor-call" })],
			{ stopReason: "toolUse" },
		);

	it("a submit MISSING messageId never passes: the schema rejects every turn — nothing merges, nothing checkpoints", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		// The degraded shape: propositions without anchors, chains present —
		// only the REQUIRED field is missing, and the schema refuses it on
		// every turn until the budget is gone (the required-field doctrine,
		// 2026-09-28, now covering the anchor too).
		const bare = () =>
			fauxEngine(
				Array.from({ length: 4 }, () =>
					submitStep({
						propositions: [{ id: "p1", name: "Anchor claim", statement: "Anchor claim, full precision.", aliases: [] }],
						chains: [],
					}),
				),
			);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) => (role === "extractor" ? bare() : submitModel("submit_review", { links: [] })),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		assert.equal(ledgers.readCoverage().length, 0, "nothing checkpointed — the batch stays re-runnable");
	});

	it("an EMPTY or UNKNOWN anchor rides the error-back channel: refused, the model re-anchors clean, then merges", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		// Three bad anchors, all schema-valid (messageId is a string) — only
		// the anchor law refuses them: empty, a LEARNER message of this very
		// chat (real id, not a teacher passage), and pure fiction.
		const extractor = fauxEngine([
			submitStep(anchored("")),
			submitStep(anchored("u1")),
			submitStep(anchored("made_up")),
			submitStep(anchored("a2")),
		]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 1, chains: 0 }, "the retry anchored and merged");
		const node = ledgers.readNodes()[0]!;
		assert.deepEqual(node.provenance, [{ chatId, messageId: "a2" }], "the node anchors to its passage");
	});

	it("the boundary is the CURRENT BATCH: a real teacher message id from another batch is refused, the in-batch retry merges", async () => {
		const { chatId } = chunkyChat(); // deterministic batches [a1,a2,a3] + [a4,a5] at the 4096 budget
		const ledgers = memoryLedgers();
		// Batch 1: "a5" is a REAL teacher-prose id of this very chat — but it
		// lives in batch 2, so this stretch refuses it; the re-anchor to "a2"
		// merges. Batch 2 anchors to its own "a4".
		const extractor = fauxEngine([
			submitStep(anchored("a5")),
			submitStep(anchored("a2")),
			submitStep(anchored("a4")),
		]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			getChunkTokens: () => 4096,
			extractor,
			// One review per batch job (the retry lives in the extractor's
			// own turn budget, not the auditor's).
			auditor: fauxEngine([passThroughAuditStep(), passThroughAuditStep()]),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 0 });
		const anchors = ledgers.readNodes().map((n) => n.provenance[0]!.messageId).sort();
		assert.deepEqual(anchors, ["a2", "a4"], "each job's node anchors INSIDE its own batch — never a5");
		assert.equal(ledgers.readCoverage().length, 5, "both batches checkpointed");
	});

	it("a LINK-APPEND carries its proposition's anchor into the existing node's provenance", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const existingId = "n_anchor_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", anchored("a2")),
			auditor: submitModel("submit_review", { links: [{ id: "p1", linkTo: existingId }] }),
		});
		await pipeline.runExtraction(chatId);
		// The link-append line — the re-encounter — carries the passage id.
		const appended = ledgers
			.readNodes()
			.filter((n) => n.id === existingId)
			.find((line) => line.provenance.some((pt) => pt.chatId === chatId))!;
		assert.deepEqual(appended.provenance, [{ chatId, messageId: "a2" }]);
		// And the derived graph unions it under the same point identity.
		const merged = getGraph(ledgers).nodes.find((n) => n.id === existingId)!;
		assert.ok(merged.provenance.some((pt) => pt.chatId === chatId && pt.messageId === "a2"));
	});

	it("the notes door stays anchor-free: no messageId required — and a stray one never reaches provenance", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			// NOTES_FINDINGS carries no messageId (the notes schema never
			// asks for one) — the submit validates exactly as before.
			extractor: submitModel("submit_findings", NOTES_FINDINGS),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.importNotes({ filePath: "/vault/anchor-free.md", text: NOTES_TEXT }), { nodes: 1, chains: 0 });
		assert.deepEqual(
			ledgers.readNodes()[0]!.provenance,
			[{ chatId: ledgers.readSources()[0]!.id, messageId: "" }],
			"notes provenance stays chat-level — the file is the anchor",
		);

		// The boundary: even a hallucinated messageId (extra properties pass
		// schema validation) is stripped at the notes fill seam.
		const stray = {
			propositions: [{ ...NOTES_FINDINGS.propositions[0], messageId: "made_up" }],
			chains: [],
		};
		const second = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", stray),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await second.importNotes({ filePath: "/vault/stray-anchor.md", text: NOTES_TEXT }), { nodes: 1, chains: 0 });
		const secondSource = ledgers.readSources()[1]!;
		const strayNode = ledgers.readNodes().find((n) => n.provenance.some((pt) => pt.chatId === secondSource.id))!;
		assert.deepEqual(strayNode.provenance, [{ chatId: secondSource.id, messageId: "" }], "the stray anchor was stripped before the merger");
	});

	it("coverage fingerprints are UNCHANGED by the anchors: the stored fps equal the plain coverage-slot hashes", async () => {
		const { chatId, record } = chunkyChat();
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			getChunkTokens: () => 4096,
			extractor: fauxEngine([findingsStep(), findingsStep()]),
			auditor: fauxEngine([passThroughAuditStep(), passThroughAuditStep()]),
		});
		await pipeline.runExtraction(chatId);
		// The labeled view reuses messageViewLines; the fingerprint seam is
		// the same lines it always was — same hashes, same coverage.
		assert.deepEqual(
			ledgers.readCoverage().map((c) => c.fp).sort(),
			coverageSlots(record.messages).map((slot) => slot.fp).sort(),
		);
		assert.equal(coverageOf(record.messages, ledgers.readCoverage(), chatId).uncoveredCount, 0);
	});
});

// ── the notes front door (format-agnostic import) ────────────────────────────

/** Raw personal notes — arbitrary format, no session, no message ids. */
const NOTES_TEXT = `> [!quote] YOU
> teach me vim

> [!abstract] PI
> Vim always starts in Normal mode — keys are commands, not text.`;

/** What the notes-mode extractor submits: same wire shape as session
 *  findings (propositions + chains), messages always empty (the file is
 *  the provenance). */
const NOTES_FINDINGS = {
	propositions: [
		{
			id: "p1",
			name: "Vim normal mode",
			statement: "Vim starts in Normal mode, where keys are commands.",
			aliases: [],
		},
	],
	chains: [],
} as const;

const NOTES_VERDICT = {
	links: [],
	edges: [],
} as const;

// ─── the extractor redesign (owner, 2026-09-30) ─────────────────────────────

describe("the extractor redesign (owner, 2026-09-30): chains are the deliverable", () => {
	/** A retry engine: step 1 submits the BAD payload (schema-valid, law-
	 *  violating — so the pin proves the VALIDATE channel fired, not the
	 *  schema), step 2 submits the clean one. */
	function retryEngine(bad: unknown, good: unknown): PiEngine {
		return fauxEngine([
			() =>
				fauxAssistantMessage([fauxToolCall("submit_findings", bad as ToolCall["arguments"], { id: "findings-bad" })], {
					stopReason: "toolUse",
				}),
			() =>
				fauxAssistantMessage([fauxToolCall("submit_findings", good as ToolCall["arguments"], { id: "findings-good" })], {
					stopReason: "toolUse",
				}),
		]);
	}

	it("co-premises ride as ONE stored argument — the fan-out to arrows is the derived view, not the store", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = submitModel("submit_findings", {
			propositions: [
				{ id: "p1", name: "A", statement: "A holds.", aliases: [], messageId: "a1" },
				{ id: "p2", name: "B", statement: "B holds.", aliases: [], messageId: "a2" },
				{ id: "p3", name: "C", statement: "A and B together entail C.", aliases: [], messageId: "a1" },
			],
			chains: [{ premises: ["p1", "p2"], conclusion: "p3" }],
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 3, chains: 1 });
		// The stored chain's premises are exactly the two premises; the
		// conclusion is C's resolved node (ids are random — assert
		// set-wise, never by ledger order).
		const byName = new Map(ledgers.readNodes().map((n) => [n.name, n.id]));
		const conclusion = byName.get("C")!;
		const chains = ledgers.readChains();
		assert.ok(chains.every((c) => c.conclusion === conclusion), "chains point INTO the conclusion");
		assert.deepEqual(
			chains.flatMap((c) => c.premises).sort(),
			[byName.get("A")!, byName.get("B")!].sort(),
		);
	});

	it("two chains sharing a conclusion union their premises; a bare proposition stays an edge-less node", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = submitModel("submit_findings", {
			propositions: [
				{ id: "p1", name: "A", statement: "A holds.", aliases: [], messageId: "a1" },
				{ id: "p2", name: "B", statement: "B holds.", aliases: [], messageId: "a2" },
				{ id: "p3", name: "C", statement: "C follows.", aliases: [], messageId: "a1" },
				{ id: "p4", name: "Lonely", statement: "A bare proposition no argument uses.", aliases: [], messageId: "a2" },
			],
			chains: [
				{ premises: ["p1"], conclusion: "p3" },
				{ premises: ["p2"], conclusion: "p3" },
			],
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		// Independent arguments for the same conclusion are separate chains;
		// the bare p4 rides the propositions list alone.
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 4, chains: 2 });
		const lonely = ledgers.readNodes().find((n) => n.name === "Lonely")!;
		assert.ok(ledgers.readChains().every((c) => !c.premises.includes(lonely.id) && c.conclusion !== lonely.id));
	});

	it("identical chains dedupe SILENTLY at the expansion — restating an argument is a no-op, not an error", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = submitModel("submit_findings", {
			...FINDINGS,
			chains: [FINDINGS.chains[0]!, FINDINGS.chains[0]!],
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("the OLD wire shape (an edges array, no chains) is dead: validation fails every turn — nothing merges", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const oldShape = () =>
			fauxEngine(
				Array.from({ length: 4 }, () => () =>
					fauxAssistantMessage(
						[
							fauxToolCall(
								"submit_findings",
								{
									propositions: FINDINGS.propositions,
									edges: [{ from: "p1", to: "p2", type: "follows" }],
								} as unknown as ToolCall["arguments"],
							),
						],
						{ stopReason: "toolUse" },
					),
				),
			);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) => (role === "extractor" ? oldShape() : submitModel("submit_review", { links: [] })),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 0, chains: 0 });
	});

	it("validate error-back: a chain referencing an UNKNOWN id is rejected, the model re-submits clean", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const bad = {
			...FINDINGS,
			chains: [{ premises: ["p1", "p9"], conclusion: "p2" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: retryEngine(bad, FINDINGS),
			auditor: submitModel("submit_review", { links: [] }),
		});
		// The first submit was schema-VALID — only the chain law caught it;
		// the retry merges in full.
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("validate error-back: a conclusion in its OWN premises is rejected, the model re-submits clean", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const bad = {
			...FINDINGS,
			chains: [{ premises: ["p1", "p2"], conclusion: "p2" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: retryEngine(bad, FINDINGS),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("empty premises never pass: the schema's minItems rejects, the model re-submits clean", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const bad = {
			...FINDINGS,
			chains: [{ premises: [], conclusion: "p2" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: retryEngine(bad, FINDINGS),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("separate source framing is assembled around shared graph and output contracts", () => {
		const sharedRules = Object.values(EXTRACTION_CORE).join("\n\n");
		assert.match(sharedRules, /JOINTLY entail a conclusion/);
		assert.match(sharedRules, /for the same conclusion are separate chains/);
		assert.match(sharedRules, /Entailment is the only link that earns a\s+chain/);
		assert.match(sharedRules, /stand\s+alone for a reader who never saw this source/);
		assert.match(sharedRules, /may not lean on the source's own\s+scaffolding/);
		assert.match(sharedRules, /SUBMIT with one submit_findings call/);
		assert.match(sharedRules, /"chains": \[\] when the source makes no\s+arguments/);
		assert.match(sharedRules, /build\s+on it\./);
		assert.doesNotMatch(sharedRules, /THE GOAL:|source teaches by arguing|Extract the load-bearing ideas/);

		// Both front doors still receive every shared contract, but own their
		// goal/selection wording independently of those contracts.
		assert.ok(EXTRACTOR_INSTRUCTIONS.startsWith(SESSION_PREAMBLE));
		assert.ok(NOTES_EXTRACTOR_INSTRUCTIONS.startsWith(NOTES_PREAMBLE));
		for (const prompt of [EXTRACTOR_INSTRUCTIONS, NOTES_EXTRACTOR_INSTRUCTIONS]) {
			for (const section of Object.values(EXTRACTION_CORE)) assert.ok(prompt.includes(section));
		}
		assert.match(EXTRACTOR_INSTRUCTIONS, /THE GOAL: uncover the source's CORE IDEAS/);
		assert.match(EXTRACTOR_INSTRUCTIONS, /everything derives from the foundations/);
		assert.match(EXTRACTOR_INSTRUCTIONS, /what a reference on it would teach/);

		// THE ANCHOR RULE (owner, 2026-10-13) is SESSION-ONLY: the exact
		// sentence rides the session instructions; the notes
		// contextualization never mentions message ids at all.
		assert.equal(
			SESSION_MESSAGE_ID_RULE,
			"For each new proposition, copy the message ID of the passage that most directly states or explains it into messageId.",
		);
		assert.ok(EXTRACTOR_INSTRUCTIONS.includes(SESSION_MESSAGE_ID_RULE), "the session instructions carry the rule");
		assert.ok(!NOTES_EXTRACTOR_INSTRUCTIONS.includes("messageId"), "the notes prompt never mentions message ids");

		// The preambles differ in exactly their source description.
		assert.notEqual(SESSION_PREAMBLE, NOTES_PREAMBLE);
		assert.match(SESSION_PREAMBLE, /a teaching\s+session, rendered as the teacher's prose in reading order/);
		assert.match(NOTES_PREAMBLE, /the\s+author's personal notes, rendered in reading order/);

		// NO RULE ARMOR (owner, 2026-09-30): the defensive lists are CUT
		// from both contextualizations.
		for (const prompt of [EXTRACTOR_INSTRUCTIONS, NOTES_EXTRACTOR_INSTRUCTIONS]) {
			assert.doesNotMatch(prompt, /DROP:/);
			assert.doesNotMatch(prompt, /MERGE YOUR OWN OUTPUT/);
			assert.doesNotMatch(prompt, /WHEN IN DOUBT, OMIT/);
			assert.doesNotMatch(prompt, /Faithfulness:/);
			assert.doesNotMatch(prompt, /follows\/supports/);
		}
	});

	it("preserves the complete teaching-session prompt byte-for-byte", () => {
		// Original UTF-8 snapshot, including every newline, preamble and the
		// session-only anchor rule. Notes-only changes must not alter it.
		assert.equal(
			createHash("sha256").update(EXTRACTOR_INSTRUCTIONS, "utf8").digest("hex"),
			"a8bddd7d47130ed5e39ffe7d8d0ed6efdd6b30407d52cd9838e7be2e465089a6",
		);
	});

	it("the notes framing records knowledge without requiring a foundational reconstruction", () => {
		const notes = NOTES_EXTRACTOR_INSTRUCTIONS.replace(/\s+/g, " ");
		assert.ok(notes.includes("THE GOAL: bring the knowledge in these notes into the learner’s knowledge graph. Notes may contain definitions, formulas, facts, arguments, or outlines without forming a complete lesson. Report the substantive ideas and the reasoning the notes support. A useful representation of this material is the deliverable, not a reconstruction of the subject from its foundations."));
		assert.ok(notes.includes("Keep the meaningful definitions, formulas, claims, and explanations, including ideas that have no derivation. Use chains for reasoning the notes give, including direct inferences from their stated relationships. A sketch need not spell out every intermediate step, but a topic outline or component dependency alone is not a derivation. Where the notes just state an idea, record it as a proposition rather than constructing an argument for it. Select enough detail to preserve the knowledge, without expanding the note into a full treatment of the subject."));
		assert.doesNotMatch(notes, /source teaches by arguing|everything derives from the foundations|An idea earns its place only|what a reference on it would teach/);
		assert.match(notes, /Each chain is premises that JOINTLY entail a conclusion/);
		assert.match(notes, /"chains": \[\] when the source makes no arguments/);
	});

	it("the session runner still receives the unchanged teaching-session instructions", async () => {
		const { chatId } = fixtureChat();
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: memoryLedgers(),
			extractor: fauxEngine([(context) => {
				calls++;
				const system = context.messages.find((message) => message.role === "system");
				assert.ok(system && system.role === "system");
				const instructions = typeof system.content === "string" ? system.content : system.content.map((part) => part.text).join("\n");
				assert.equal(instructions, EXTRACTOR_INSTRUCTIONS);
				return fauxAssistantMessage([fauxToolCall("submit_findings", FINDINGS, { id: "session-findings" })], { stopReason: "toolUse" });
			}]),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
		assert.equal(calls, 1);
	});
});

describe("the notes front door (importNotes — format-agnostic)", () => {
	// These faux responses verify prompt routing and the unchanged wire/merge
	// contracts, not whether a real model follows the new instructions.
	for (const example of [
		{
			label: "standalone definitions",
			text: "Vim starts in Normal mode, where keys are commands.",
			findings: NOTES_FINDINGS,
			expected: { nodes: 1, chains: 0 },
		},
		{
			label: "a supported derivation sketch",
			text: "Inner-product spaces ⊂ normed spaces ⊂ metric spaces.",
			findings: {
				propositions: [
					{ id: "p1", name: "Inner-product spaces are normed", statement: "Every inner-product space is a normed space.", aliases: [] },
					{ id: "p2", name: "Normed spaces are metric", statement: "Every normed space is a metric space.", aliases: [] },
					{ id: "p3", name: "Inner-product spaces are metric", statement: "Every inner-product space is a metric space.", aliases: [] },
				],
				chains: [{ premises: ["p1", "p2"], conclusion: "p3" }],
			},
			expected: { nodes: 3, chains: 1 },
		},
	]) {
		it(`the notes runner receives the notes-specific instructions and accepts ${example.label}`, async () => {
			let calls = 0;
			const pipeline = createExtractionPipeline({
				chatStore,
				graphStore: memoryLedgers(),
				extractor: fauxEngine([(context) => {
					calls++;
					const system = context.messages.find((message) => message.role === "system");
					assert.ok(system && system.role === "system");
					const instructions = typeof system.content === "string" ? system.content : system.content.map((part) => part.text).join("\n");
					assert.equal(instructions, NOTES_EXTRACTOR_INSTRUCTIONS);
					return fauxAssistantMessage([fauxToolCall("submit_findings", example.findings, { id: "notes-findings" })], { stopReason: "toolUse" });
				}]),
				auditor: submitModel("submit_review", { links: [] }),
			});
			assert.deepEqual(await pipeline.importNotes({ filePath: `synthetic-${example.label}.txt`, text: example.text }), example.expected);
			assert.equal(calls, 1);
		});
	}

	it("imports raw notes end to end: source record, file-scoped provenance", async () => {
		const ledgers = memoryLedgers();
		const seen: { kind?: string; label?: string }[] = [];
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", NOTES_FINDINGS),
			// During the auditor's call the registry must show the notes run.
			auditor: submitModel("submit_review", NOTES_VERDICT, () => {
				const run = extractionStatuses().find((r) => r.chatId.startsWith("src_"));
				seen.push({ kind: run?.kind, label: run?.label });
			}),
		});
		const stats = await pipeline.importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });

		assert.deepEqual(stats, { nodes: 1, chains: 0 });
		// The run surfaced as a NOTES run labeled with the file path.
		assert.deepEqual(seen, [{ kind: "notes", label: "/vault/learn vim.md" }]);
		assert.equal(extractionStatuses().length, 0, "the registry clears when the run ends");

		// The source record: deterministic src id, the file path, the usage log.
		const source = ledgers.readSources()[0]!;
		assert.match(source.id, /^src_/);
		assert.equal(source.filePath, "/vault/learn vim.md");
		assert.ok(Date.parse(source.importedAt));
		assert.equal(source.extractions?.length, 1, "the run's usage persisted into the source record");
		assert.equal(source.extractions![0]!.stats?.nodes, 1);
		assert.ok(source.extractions![0]!.stages.extractor.steps.length > 0, "faux usage captured");

		// File-scoped provenance (submit-schema slim, 2026-09-28): the
		// node carries ONE chat-level point — the source key itself, no
		// message anchors.
		const node = ledgers.readNodes()[0]!;
		assert.equal(node.statement, "Vim starts in Normal mode, where keys are commands.");
		assert.deepEqual(node.provenance, [{ chatId: source.id, messageId: "" }]);
		// The checkpoint stamps the import.
		assert.equal(ledgers.readCheckpoints()[0]!.chatId, source.id);
	});

	it("chunks a large file: one extract→audit→merge per chunk, part headers in each view (owner, 2026-09-28)", async () => {
		const ledgers = memoryLedgers();
		const views: string[] = [];
		let calls = 0;
		// Fresh engine PER CHUNK via the engineFor factory — same seam
		// production uses (one scripted response per model call).
		const extractorStep = () =>
			fauxEngine([
				(context) => {
					calls++;
					views.push(capturedView(context));
					return fauxAssistantMessage(
						[
							fauxToolCall("submit_findings", NOTES_FINDINGS as unknown as ToolCall["arguments"], {
								id: `findings-${calls}`,
							}),
						],
						{ stopReason: "toolUse" },
					);
				},
			]);
		const text = Array.from({ length: 8 }, (_, i) => `note line ${i}: ${"x".repeat(30)}`).join("\n");
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) =>
				role === "extractor"
					? extractorStep()
						: submitModel("submit_review", { links: [] }),
			getChunkTokens: () => 20, // 80 chars/line-groups → several chunks
		});
		const stats = await pipeline.importNotes({ filePath: "/vault/big.md", text });

		assert.ok(calls >= 2, `expected ≥2 extractor calls, got ${calls}`);
		assert.match(views[0]!, new RegExp(`part 1/${calls}`));
		assert.match(views.at(-1)!, new RegExp(`part ${calls}/${calls}`));
		// Same findings in every chunk → one node PER CHUNK: jobs merge
		// independently (owner, 2026-09-29 — the mappings ledger is gone);
		// cross-chunk identity is the auditor's linkTo verdict, and these
		// fixtures submit none.
		assert.deepEqual(stats, { nodes: calls, chains: 0 });
		assert.equal(ledgers.readNodes().length, calls);
	});

	it("required top-level fields (owner, 2026-09-28; chains since 2026-09-30): a findings submit MISSING chains fails validation — no silent structure-less merge", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		// The degraded-retry shape from the OpenRouter log: propositions
		// only, edges omitted. Required schema → validation fails on every
		// turn → the run rejects instead of merging a pile of structureless
		// nodes. Four queued attempts exhaust the extractor's turn budget.
		// Four queued attempts — one per turn of the extractor's budget.
		const noEdges = () =>
			fauxEngine(
				Array.from({ length: 4 }, () => (context) => {
					void context;
					return fauxAssistantMessage(
						[fauxToolCall("submit_findings", { propositions: FINDINGS.propositions } as unknown as ToolCall["arguments"])],
						{ stopReason: "toolUse" },
					);
				}),
			);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) => (role === "extractor" ? noEdges() : submitModel("submit_review", { links: [] })),
		});
		// Isolated job failure (per-chunk jobs, owner 2026-09-28): the run
		// resolves zeros — no throw — and still nothing merged.
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readCoverage().length, 0, "nothing checkpointed — the messages stay re-runnable");
	});

	it("every explicit import runs the whole file, even identical text and legacy fingerprints", async () => {
		const ledgers = memoryLedgers();
		const mk = () =>
			createExtractionPipeline({
				chatStore,
				graphStore: ledgers,
					extractor: submitModel("submit_findings", NOTES_FINDINGS),
				auditor: submitModel("submit_review", NOTES_VERDICT),
			});
		const first = await mk().importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });
		assert.deepEqual(first, { nodes: 1, chains: 0 });

		// A legacy stamp must never suppress an explicit import.
		ledgers.upsertSource({ ...ledgers.readSources()[0]!, contentFp: createHash("sha256").update(NOTES_TEXT).digest("hex").slice(0, 16) });
		const second = await mk().importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });
		assert.deepEqual(second, { nodes: 1, chains: 0 }, "identical content re-extracts");
		assert.equal(ledgers.readSources()[0]!.contentFp, undefined, "new imports write no fingerprint");

		assert.equal(ledgers.readSources().length, 1, "one source identity — the path hashes to the same id");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2, "both runs bill usage");
		assert.equal(ledgers.readNodes().length, 2, "the auditor, not a content skip, owns identity");

		// Changed text also re-runs the whole file.
		const third = await mk().importNotes({ filePath: "/vault/learn vim.md", text: `${NOTES_TEXT}\nA new closing line.` });
		assert.deepEqual(third, { nodes: 1, chains: 0 }, "changed content re-extracts");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 3, "the re-run bills its usage");
		assert.equal(ledgers.readNodes().length, 3);
	});

	it("aborts like a chat run: true cancellation, nothing merged, partial usage in the source record", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: hangingModel(),
			auditor: submitModel("submit_review", NOTES_VERDICT),
		});
		const runPromise = pipeline.importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });

		const srcId = extractionStatuses().find((r) => r.chatId.startsWith("src_"))!.chatId;
		assert.equal(abortExtraction(srcId), true);
		await assert.rejects(runPromise, (error) => error instanceof NotesImportError && error.outcome === "aborted" && error.partialStats.nodes === 0);
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		assert.equal(ledgers.readCheckpoints().length, 0, "nothing checkpointed");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1, "partial usage still persisted");
		assert.equal(ledgers.readSources()[0]!.extractions![0]!.stats, undefined, "never merged → no stats");
	});
});

// ── the chunked pipeline (extraction coverage — vision-extraction-coverage.md) ──

/** Pull the pipeline's prompt view out of a model call: the pipeline sends
 *  the session's markdown document itself as the user turn, so the LAST
 *  user message's text IS what the extractor saw. */
function capturedView(context: unknown): string {
	const messages = (context as { messages?: { role: string; content: string }[] }).messages ?? [];
	const last = [...messages].reverse().find((m) => m.role === "user");
	return typeof last?.content === "string" ? last.content : "";
}

/** An extractor step that submits FINDINGS, optionally capturing its view.
 *  The step plays by the anchor law it runs under (2026-10-13): every
 *  proposition's messageId is copied from a TEACHER [id] label of the
 *  CURRENT stretch, so multi-batch fixtures reuse this step across batches
 *  without ever naming a passage their batch does not hold. */
function findingsStep(capture?: (view: string) => void): FauxResponseStep {
	return (context) => {
		const view = capturedView(context);
		capture?.(view);
		const anchor = /TEACHER \[([^\]]+)\]/.exec(view)?.[1] ?? "a1";
		const submit = {
			...FINDINGS,
			propositions: FINDINGS.propositions.map((p) => ({ ...p, messageId: anchor })),
		};
		return fauxAssistantMessage(
			[fauxToolCall("submit_findings", submit as unknown as ToolCall["arguments"], { id: "findings-call" })],
			{ stopReason: "toolUse" },
		);
	};
}

/** An auditor step that passes p1 through (no linkTo — a fresh node), drops p2. */
function passThroughAuditStep(): FauxResponseStep {
	return () =>
		fauxAssistantMessage(
			[
				fauxToolCall(
					"submit_review",
					{
						links: [],
						edges: [],
					} as unknown as ToolCall["arguments"],
					{ id: "review-call" },
				),
			],
			{ stopReason: "toolUse" },
		);
}

/** A session with UNCOVERED-multiple-batch mass: five long distinct messages
 *  (~1200 tok each — 3600+1200 > the factory chunk budget 4096 → batches of
 *  [m1,m2,m3] and [m4,m5]). */
function chunkyChat() {
	const chat = chatStore.createChat("Chunky coverage fixture");
	createdChats.push(chat.id);
	// ~1230 tok per TEACHER message (chars/4): three fill the 4096 budget,
	// the fourth would overflow — deterministic batches [m1,m2,m3] + [m4,m5].
	// Teacher prose only (owner, 2026-09-28): learner messages are
	// invisible to coverage, so the fixture is all-teacher.
	chatStore.saveMessages(
		chat.id,
		[1, 2, 3, 4, 5].flatMap((n) => assistant(`a${n}`, [{ type: "text", text: `topic ${n}: ${"detail ".repeat(700)}${n}` }])),
	);
	return { chatId: chat.id, record: chatStore.getChat(chat.id)! };
}

describe("the chunked pipeline (extraction coverage)", () => {
	it("extracts uncovered messages in token-budgeted batches, checkpoints coverage per batch, and no-ops once covered", async () => {
		const { chatId, record } = chunkyChat();
		const ledgers = memoryLedgers();
		const views: string[] = [];

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			// 4096 budget: the fixture is sized to split in two (the factory
			// default again — halved back from the digest-era 8192, owner
			// 2026-10-13).
			getChunkTokens: () => 4096,
			extractor: fauxEngine([findingsStep((v) => views.push(v)), findingsStep((v) => views.push(v))]),
			auditor: fauxEngine([passThroughAuditStep(), passThroughAuditStep()]),
		});
		const stats = await pipeline.runExtraction(chatId);

		// Two batches: the first held messages 1-3, the second 4-5 — a
		// message is never split, batches are consecutive oldest-first.
		assert.equal(views.length, 2, "one extractor call per batch");
		assert.ok(views[0]!.includes("topic 1:") && views[0]!.includes("topic 3:"), "teacher prose only, first three");
		assert.ok(!views[0]!.includes("topic 4:"), "the batch stops at the token budget");
		assert.ok(views[1]!.includes("topic 4:") && views[1]!.includes("topic 5:"));
		assert.ok(!views[1]!.includes("topic 3:"));
		assert.doesNotMatch(views[0]!, /### /, "no speaker headers — passages are TEACHER [id] lines");
		// The document header is the session title.
		assert.ok(views[0]!.startsWith("# Chunky coverage fixture"));
		// MESSAGE-ID LABELS (2026-10-13): every passage carries its REAL
		// message id — batch 1 holds a1-a3, batch 2 a4-a5, and the labels
		// follow the split exactly.
		assert.match(views[0]!, /^TEACHER \[a1\] topic 1:/m);
		assert.match(views[0]!, /^TEACHER \[a3\] topic 3:/m);
		assert.doesNotMatch(views[0]!, /TEACHER \[a4\]/);
		assert.match(views[1]!, /^TEACHER \[a4\] topic 4:/m);
		assert.match(views[1]!, /^TEACHER \[a5\] topic 5:/m);

		// Batch 1 merged the full findings (verdicts-only: the extractor's
		// output always fully merges); batch 2's identical ids are a
		// SEPARATE job's namespace (owner, 2026-09-29 — no mapping table)
		// — its propositions merge again as fresh nodes. Cross-batch
		// identity is the auditor's linkTo verdict, never the merger's.
		assert.deepEqual(stats, { nodes: 4, chains: 2 });

		// Per-batch coverage: every message checkpointed, nothing legacy.
		const coverage = ledgers.readCoverage();
		assert.equal(coverage.length, record.messages.length);
		assert.equal(ledgers.readCheckpoints().length, 0);
		assert.equal(coverageOf(record.messages, coverage, chatId).uncoveredCount, 0);

		// A second run is a NO-OP: nothing uncovered → no model calls, no
		// new usage entry (no money spent on covered ground).
		const before = views.length;
		const again = await pipeline.runExtraction(chatId);
		assert.deepEqual(again, { nodes: 0, chains: 0 });
		assert.equal(views.length, before);
		// PER-CHUNK JOBS (owner 2026-09-28): one usage record per batch job
		// (two), and the no-op run adds none.
		assert.equal(chatStore.getChat(chatId)!.extractions?.length, 2, "one usage record per batch job; the no-op run persists none");
	});

	it("aborting after a merged batch keeps it covered; the re-run extracts only the remainder", async () => {
		const { chatId, record } = chunkyChat();
		const ledgers = memoryLedgers();
		const views: string[] = [];

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			// 4096 budget: the fixture is sized to split in two (the factory
			// default again — halved back from the digest-era 8192, owner
			// 2026-10-13).
			getChunkTokens: () => 4096,
			// Batch 1 submits and merges; batch 2's extractor call HANGS
			// until the abort fires — the dock's abort button, mid-run.
			extractor: fauxEngine([
				findingsStep((v) => views.push(v)),
				(_context, options) =>
					new Promise((resolve) => {
						const sig = options?.signal;
						if (sig?.aborted) {
							resolve(fauxAssistantMessage("late"));
							return;
						}
						sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
					}),
			]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		const runPromise = pipeline.runExtraction(chatId);
		// The abort must land while batch 2's extractor hangs. The faux
		// stream only resolves on abort, so wait for the batch-1 merge to
		// show in coverage, then abort.
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (ledgers.readCoverage().length > 0) {
					clearInterval(check);
					resolve();
				}
			}, 5);
		});
		assert.equal(abortExtraction(chatId), true);
		const stats = await runPromise;

		// Batch 1's emissions are kept and its messages stay covered.
		assert.deepEqual(stats, { nodes: 2, chains: 1 });
		assert.equal(ledgers.readCoverage().length, 3, "batch 1 checkpointed its three messages");
		const cov = coverageOf(record.messages, ledgers.readCoverage(), chatId);
		assert.equal(cov.uncoveredCount, 2, "the in-flight batch's messages stay uncovered");

		// The re-run — the manual extract button — picks up ONLY the
		// remainder: one batch, messages 4-5 alone in the prompt.
		const reRunViews: string[] = [];
		const finisher = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([findingsStep((v) => reRunViews.push(v))]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		await finisher.runExtraction(chatId);
		assert.equal(reRunViews.length, 1);
		assert.ok(reRunViews[0]!.includes("topic 4:") && reRunViews[0]!.includes("topic 5:"));
		assert.ok(!reRunViews[0]!.includes("topic 1:"), "the covered remainder never re-enters the prompt");
		assert.equal(ledgers.readCoverage().length, 5, "the re-run closed the gap");
	});

	it("a re-opened message re-extracts alone; a data-part attach never re-opens it", async () => {
		// A small session: one batch covers everything, so re-openings are
		// the ONLY thing later runs can see.
		const chat = chatStore.createChat("Re-open fixture");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			...assistant("s1", [{ type: "text", text: "short topic one" }]),
			...assistant("s2", [{ type: "text", text: "short topic two" }]),
		].flat());
		const chatId = chat.id;
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([findingsStep()]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		await pipeline.runExtraction(chatId);
		// Wave D: the record IS native history — coverage reads it directly.
		const record = () => chatStore.getChat(chatId)!.messages;
		const messages = () => record();
		assert.equal(coverageOf(messages(), ledgers.readCoverage(), chatId).uncoveredCount, 0);

		// Data parts are invisible to the extraction view — a plan-block
		// marker append (whose data part splices into the projected view)
		// does NOT re-open a covered message.
		chatStore.saveMessages(chatId, [
			...record(),
			newPlanBlockMessage("call_s2", { kind: "full", at: "2026-09-26T00:00:00.000Z", current: null, nodes: [], edges: [] }),
		]);
		const afterAttach = coverageOf(messages(), ledgers.readCoverage(), chatId);
		assert.equal(afterAttach.uncoveredCount, 0, "data parts don't change the fingerprint");

		// A teacher-prose edit changes the message's view → exactly that
		// message re-opens, and the next run extracts it alone. (Under the
		// 2026-09-28 ruling only TEACHER prose can re-open anything.)
		const mutated = record().map((m) =>
			(m as { id?: string }).id === "s1"
				? ({ ...m, content: [...(m as { content: unknown[] }).content, { type: "text", text: "the answer merged in late" }] } as never)
				: m,
		);
		chatStore.saveMessages(chatId, mutated);
		const afterMerge = coverageOf(messages(), ledgers.readCoverage(), chatId);
		assert.equal(afterMerge.uncoveredCount, 1, "only the mutated message re-opens");

		const reRunViews: string[] = [];
		const reOpener = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([findingsStep((v) => reRunViews.push(v))]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		await reOpener.runExtraction(chatId);
		assert.equal(reRunViews.length, 1, "one batch: the single re-opened message");
		assert.ok(reRunViews[0]!.includes("the answer merged in late") && !reRunViews[0]!.includes("short topic two"));
		assert.ok(reRunViews[0]!.includes("short topic one"), "the re-opened message renders its full prose");
		assert.equal(coverageOf(messages(), ledgers.readCoverage(), chatId).uncoveredCount, 0, "re-covered");
	});
});

// ─── session deletion mid-run (wave 6) ─────────────────────────────────────

// ─── per-chunk parallel jobs (owner, 2026-09-28) ─────────────────────────────

describe("per-chunk parallel jobs (owner, 2026-09-28)", () => {
	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	/** 8 single-line chunks: one line per chunk under a tiny budget — a
	 *  fan-out wide enough to see both the 3-slot semaphore and the queue. */
	const wideText = () =>
		Array.from({ length: 8 }, (_, i) => `note ${i}: ${"x".repeat(90)}`).join("\n");

	it("one job per chunk, SERIALIZED per source: the registry shows one live row at a time, and a source-wide abort ends the run", async () => {
		const ledgers = memoryLedgers();
		// The extractor call hangs until its ABORT — the observation window:
		// the parked chunk-1 job must be the ONLY live row (later chunks
		// mint only when their turn comes, digest order, owner 2026-09-30).
		const abortingStep: FauxResponseStep = (_context, options) =>
			new Promise((_resolve, reject) => {
				const sig = options?.signal;
				const die = () => {
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				};
				if (sig?.aborted) die();
				else sig?.addEventListener("abort", die, { once: true });
			});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) =>
				role === "extractor" ? fauxEngine([abortingStep]) : submitModel("submit_review", { links: [] }),
			getChunkTokens: () => 20,
		});
		const runPromise = pipeline.importNotes({ filePath: "/vault/parallel.md", text: wideText() });

		const srcId = extractionStatuses().find((r) => r.chatId.startsWith("src_"))!.chatId;
		await until(() => extractionStatuses().some((r) => r.chatId === srcId && r.phase === "extracting"), 500);
		const rows = extractionStatuses().filter((r) => r.chatId === srcId);
		assert.equal(rows.length, 1, "one live row — the source's chunks run strictly in order");
		assert.equal(rows[0]!.phase, "extracting");
		assert.deepEqual(rows[0]!.part, { i: 1, n: 8 }, "the row carries its part");

		// SOURCE-WIDE abort: the parked job dies and the run ENDS — no
		// later chunk ever mints (fresh rows would hang un-aborted).
		assert.equal(abortExtraction(srcId), true);
		await assert.rejects(runPromise, (error) => error instanceof NotesImportError && error.outcome === "aborted");
		assert.equal(extractionStatuses().filter((r) => r.chatId === srcId).length, 0, "all rows leave the registry");
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		// Per-job usage: the ONE minted job persisted its (failed) spend.
		const source = ledgers.readSources().find((src) => src.id === srcId)!;
		assert.equal(source.extractions?.length, 1, "only the aborted job bills — later chunks never ran");
		assert.ok(source.extractions!.every((entry) => entry.stats === undefined), "no job merged — no stats");
	});

	it("parallel extracts, serialized audits: extractor concurrency peaks at the cap, the auditor NEVER overlaps", async () => {
		const ledgers = memoryLedgers();
		let extractInFlight = 0;
		let extractPeak = 0;
		let auditInFlight = 0;
		let auditPeak = 0;
		// Hand-built submit messages (findingsStep()/passThroughAuditStep()
		// are step FACTORIES — the slow wrapper must return messages).
		const findingsMessage = fauxAssistantMessage(
			[fauxToolCall("submit_findings", FINDINGS as unknown as ToolCall["arguments"], { id: "findings-call" })],
			{ stopReason: "toolUse" },
		);
		const reviewMessage = fauxAssistantMessage(
			[fauxToolCall("submit_review", { links: [] } as unknown as ToolCall["arguments"], { id: "review-call" })],
			{ stopReason: "toolUse" },
		);
		const slowExtract: FauxResponseStep = async () => {
			extractInFlight++;
			extractPeak = Math.max(extractPeak, extractInFlight);
			await sleep(5);
			extractInFlight--;
			return findingsMessage;
		};
		const slowAudit: FauxResponseStep = async () => {
			auditInFlight++;
			auditPeak = Math.max(auditPeak, auditInFlight);
			await sleep(5);
			auditInFlight--;
			return reviewMessage;
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) =>
				role === "extractor" ? fauxEngine([slowExtract]) : fauxEngine([slowAudit]),
			getChunkTokens: () => 20,
		});
		const stats = await pipeline.importNotes({ filePath: "/vault/parallel-2.md", text: wideText() });

		// SERIALIZED PER SOURCE (owner, 2026-09-30 evening): one source's
		// chunks run strictly in order — each extractor continues the
		// digest of every earlier merge, so the peak within one source is
		// ONE concurrent extract. (Cross-source runs still parallelize;
		// the 3-permit semaphore still caps those.)
		assert.equal(extractPeak, 1, "one source, one extract at a time — strict order");
		assert.equal(auditPeak, 1, "audits serialize behind the gate — never two at once");
		// Identical findings in every chunk, one merge PER chunk (jobs are
		// independent — owner, 2026-09-29): 8 chunks × 2 propositions,
		// 8 × 1 chain. The auditor's links, not the merger, dedupe identity.
		assert.deepEqual(stats, { nodes: 16, chains: 8 });
		assert.equal(ledgers.readNodes().length, 16);
	});
});

describe("the session-deletion guard (chat deleted mid-run)", () => {
	it("a run whose chat dies mid-extraction aborts at the merge with nothing merged, checkpointed, or billed", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		// The chat record is deleted DURING the audit model call — the worst
		// window: findings already spent, the merge next.
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", { links: [] }, () => chatStore.deleteChat(chatId)),
		});
		const stats = await pipeline.runExtraction(chatId);

		// The abort rides the existing abort path: info, not error; zero
		// emissions (stats present but empty — nothing merged).
		assert.ok(stats);
		assert.equal(stats.nodes, 0);
		assert.equal(stats.chains, 0);

		// Nothing merged, nothing checkpointed — the deleted chat leaves no
		// trace for a later snapshot to resurrect.
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readChains().length, 0);
		assert.equal(ledgers.readCoverage().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0);

		// The run is off the registry (the finally always cleans up).
		assert.equal(extractionStatuses().some((run) => run.chatId === chatId), false);
		// And its partial spend died with the chat — no usage row on a ghost.
		assert.equal(chatStore.getChat(chatId), null);
	});
});

// ─── digest-aware serialized extraction + chain simplification (owner, 2026-09-30 evening) ────

describe("digest-aware serialized extraction (the extractor is the assembler)", () => {
	it("both source prompts retain their goal and the shared build-on-the-digest doctrine", () => {
		assert.match(EXTRACTION_CORE.entailment, /JOINTLY entail a conclusion/);
		assert.match(EXTRACTION_CORE.entailment, /[Ee]ntailment is the\s+only link that earns a\s+chain/);
		assert.match(EXTRACTION_CORE.continuation, /build\s+on it\. Reference an existing idea by its id/);
		assert.match(EXTRACTION_CORE.submission, /OR existing ids from THE GRAPH SO FAR, verbatim/);
		assert.match(EXTRACTOR_INSTRUCTIONS, /THE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations/);
		assert.match(EXTRACTOR_INSTRUCTIONS, /examples,\s+notation glosses, and restatements that no argument needs are not core ideas/);
		for (const prompt of [EXTRACTOR_INSTRUCTIONS, NOTES_EXTRACTOR_INSTRUCTIONS]) {
			for (const section of Object.values(EXTRACTION_CORE)) assert.ok(prompt.includes(section));
		}
		assert.match(SESSION_PREAMBLE, /building on everything already extracted from this source/);
		assert.match(NOTES_PREAMBLE, /building on everything already extracted from this source/);
	});

	it("sourceDigest renders the same-source truth (ids verbatim) and stays empty for a barren source", () => {
		const seed = (id: string, name: string, chatId: string): GraphNode => ({
			id,
			name,
			statement: `statement of ${name}`,
			aliases: [],
			createdAt: "2026-09-30T00:00:00.000Z",
			provenance: [{ chatId, messageId: "" }],
		});
		const chain = (id: string, premises: string[], conclusion: string, chatId: string): GraphChain => ({
			id,
			premises,
			conclusion,
			createdAt: "2026-09-30T00:00:01.000Z",
			provenance: [{ chatId, messageId: "" }],
		});
		const graph = {
			nodes: [seed("n_a", "Self-ownership", "src_1"), seed("n_x", "Foreign key", "src_2")],
			chains: [chain("arg_1", ["n_a"], "n_x", "src_2")], // same NAME, other source — excluded
			sessions: {},
			sources: {},
		} as unknown as Parameters<typeof sourceDigest>[0];
		assert.equal(sourceDigest(graph, "src_9"), "", "a source owning nothing runs bare — no digest block");
		const digest = sourceDigest(graph, "src_1");
		assert.match(digest, /THE GRAPH SO FAR/);
		assert.match(digest, /n_a \| Self-ownership \| statement of Self-ownership/);
		assert.doesNotMatch(digest, /Foreign key/, "other sources' material never leaks into the digest");
		assert.doesNotMatch(digest, /DERIVATIONS ALREADY RECORDED/, "no same-source chains → no chain block");
	});

	it("the real auditor receives the proposed ids, batched candidate tool and practical-equivalence prompt", async () => {
		const ledgers = memoryLedgers();
		ledgers.appendNode({
			id: "n_seed", name: "Evaporation", statement: "Liquid changes into vapor.", aliases: [],
			createdAt: "2026-01-01T00:00:00Z", provenance: [{ chatId: "old_source", messageId: "" }],
		});
		const auditor = fauxEngine([
			(context) => {
				const system = context.messages.find((message) => message.role === "system");
				assert.ok(system && system.role === "system");
				assert.ok(system.toolsAdded?.some((tool) => tool.name === "find_candidates"));
				assert.ok(!system.toolsAdded?.some((tool) => tool.name === "find"));
				const instructions = typeof system.content === "string" ? system.content : system.content.map((part) => part.text).join("\n");
				assert.match(instructions, /REVIEW THE PROVIDED RECORDS/);
				assert.match(instructions, /CALLING the submit_review TOOL/);
				assert.match(instructions, /JSON\s+printed as text, does not submit a review/);
				assert.match(instructions, /statement AND its matched aliases are accepted knowledge/);
				assert.doesNotMatch(instructions, /WHOLE proposition|majority of its clauses/);
				const view = capturedView(context);
				const initial = JSON.parse(view.slice(view.indexOf("{")));
				assert.deepEqual(initial.matches[0].candidateIds, ["n_seed"], "the model starts with candidates, not an instruction to fetch them");
				assert.equal(initial.candidates[0].statement, "Liquid changes into vapor.");
				assert.doesNotMatch(view, /Explore it with your tools|current knowledge graph has/);
				return fauxAssistantMessage([fauxToolCall("find_candidates", { propositions: [{ id: "p1" }] }, { id: "lookup" })], { stopReason: "toolUse" });
			},
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				assert.ok(result && result.role === "toolResult");
				const text = result.content.find((part) => part.type === "text");
				assert.ok(text && text.type === "text");
				const candidates = JSON.parse(text.text);
				assert.deepEqual(candidates.matches[0].candidateIds, ["n_seed"]);
				assert.equal(candidates.candidates[0].statement, "Liquid changes into vapor.");
				return fauxAssistantMessage([fauxToolCall("submit_review", { links: [{ id: "p1", linkTo: "n_seed" }] }, { id: "review" })], { stopReason: "toolUse" });
			},
		]);
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, auditor,
			extractor: submitModel("submit_findings", { propositions: [{ id: "p1", name: "Vaporization", statement: "Liquid changes into vapor.", aliases: [] }], chains: [] }),
		});
		const stats = await pipeline.importNotes({ filePath: "synthetic-candidates.txt", text: "Liquid changes into vapor." });
		assert.equal(stats.nodes, 0, "the candidate identity is used by the existing merger");
		assert.equal(getGraph(ledgers).nodes.length, 1);
		assert.ok(getGraph(ledgers).nodes[0]!.provenance.some((point) => point.chatId === ledgers.readSources()[0]!.id));
	});

	it("a supplied accepted alias can be matched and submitted in one auditor response, with no lookup", async () => {
		const ledgers = memoryLedgers();
		ledgers.appendNode({
			id: "n_seed", name: "Legacy label", statement: "The original canonical statement.",
			aliases: ["An amber canoe travels upstream."], createdAt: "2026-01-01T00:00:00Z",
			provenance: [{ chatId: "old_source", messageId: "" }],
		});
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers,
			extractor: submitModel("submit_findings", { propositions: [{ id: "p1", name: "Upstream travel", statement: "An amber canoe travels upstream.", aliases: [] }], chains: [] }),
			auditor: fauxEngine([(context) => {
				calls++;
				const view = capturedView(context);
				const initial = JSON.parse(view.slice(view.indexOf("{")));
				assert.deepEqual(initial.candidates[0].matchedAliases, ["An amber canoe travels upstream."]);
				assert.doesNotMatch(view, /PRIVATE SOURCE PASSAGE/);
				return fauxAssistantMessage([fauxToolCall("submit_review", { links: [{ id: "p1", linkTo: "n_seed" }] }, { id: "review" })], { stopReason: "toolUse" });
			}]),
		});
		const stats = await pipeline.importNotes({ filePath: "synthetic-alias.txt", text: "PRIVATE SOURCE PASSAGE" });
		assert.equal(calls, 1);
		assert.equal(stats.nodes, 0);
		assert.equal(getGraph(ledgers).nodes.length, 1);
	});

	it("a seeded digest rides the extractor's view: mixed-namespace chains reference existing ids VERBATIM", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const seed = (id: string, name: string): GraphNode => ({
			id,
			name,
			statement: `statement of ${name}`,
			aliases: [],
			createdAt: "2026-09-30T00:00:00.000Z",
			provenance: [{ chatId, messageId: "m0" }],
		});
		ledgers.appendNode(seed("n_a", "Self-ownership"));
		const FINDINGS_B: SessionFindings = {
			propositions: [{ id: "p1", name: "Appropriation axiom", statement: "c", aliases: [], messageId: "a1" }],
			chains: [{ premises: ["n_a", "p1"], conclusion: "p1", }].slice(0, 0), // chains live in the engine below
		};
		const views: string[] = [];
		const extractor = fauxEngine([
			(context) => {
				views.push(capturedView(context));
				const submit = {
					propositions: FINDINGS_B.propositions,
					chains: [{ premises: ["n_a", "p1"], conclusion: "p1b" }],
				};
				// conclusion p1b must exist — real submit:
				submit.propositions.push({ id: "p1b", name: "Property rights", statement: "d", aliases: [], messageId: "a2" });
				return fauxAssistantMessage([fauxToolCall("submit_findings", submit as unknown as ToolCall["arguments"], { id: "f1" })], { stopReason: "toolUse" });
			},
		]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		const stats = await pipeline.runExtraction(chatId);

		// The extractor's view LED with the digest (existing id verbatim).
		assert.match(views[0]!, /THE GRAPH SO FAR/);
		assert.match(views[0]!, /n_a \| Self-ownership/);

		// Mixed namespace resolved: n_a passes through verbatim; p1/p1b
		// resolve through the job-local map.
		assert.deepEqual(stats, { nodes: 2, chains: 1 });
		const stored = ledgers.readChains();
		assert.equal(stored.length, 1);
		const byName = new Map(ledgers.readNodes().map((n) => [n.name, n.id]));
		assert.deepEqual(stored[0]!.premises, ["n_a", byName.get("Appropriation axiom")]);
		assert.equal(stored[0]!.conclusion, byName.get("Property rights"));
	});

	it("a chain endpoint that resolves NOWHERE is refused with the problem and the retry merges (error-back)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const badThenGood = fauxEngine([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(
							"submit_findings",
							{ propositions: [], chains: [{ premises: ["n_nope"], conclusion: "also_nope" }] } as unknown as ToolCall["arguments"],
							{ id: "bad" },
						),
					],
					{ stopReason: "toolUse" },
				),
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(
							"submit_findings",
							{
								propositions: [{ id: "p1", name: "Axiom", statement: "s", aliases: [], messageId: "a1" }],
								chains: [],
							} as unknown as ToolCall["arguments"],
							{ id: "good" },
						),
					],
					{ stopReason: "toolUse" },
				),
		]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: badThenGood,
			auditor: submitModel("submit_review", { links: [] }),
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(stats, { nodes: 1, chains: 0 }, "the refused attempt left nothing; the retry merged");
	});

	it("batches serialize: chunk 2's extractor starts only after chunk 1's audit ran (digest order, owner 2026-09-30 evening)", async () => {
		const { chatId } = chunkyChat(); // 2 deterministic batches at the 4096 override
		const ledgers = memoryLedgers();
		const events: string[] = [];
		let extractCalls = 0;
		let auditCalls = 0;
		// One step per engine call (faux engines consume steps): two batches.
		const extractStep = (): FauxResponseStep => (context) => {
			extractCalls++;
			events.push(`extract${extractCalls}`);
			// The anchor is copied from the CURRENT stretch's first TEACHER
			// label (a1 in batch 1, a4 in batch 2) — batch-local by construction.
			const anchor = /TEACHER \[([^\]]+)\]/.exec(capturedView(context))?.[1] ?? "a1";
			const submit = {
				...FINDINGS,
				propositions: FINDINGS.propositions.map((p) => ({ ...p, messageId: anchor })),
			};
			return fauxAssistantMessage(
				[fauxToolCall("submit_findings", submit as unknown as ToolCall["arguments"], { id: `f${extractCalls}` })],
				{ stopReason: "toolUse" },
			);
		};
		const auditStep = (): FauxResponseStep => () => {
			auditCalls++;
			events.push(`audit${auditCalls}`);
			return fauxAssistantMessage(
				[fauxToolCall("submit_review", { links: [] } as unknown as ToolCall["arguments"], { id: `r${auditCalls}` })],
				{ stopReason: "toolUse" },
			);
		};
		const extractor = fauxEngine([extractStep(), extractStep()]);
		const auditor = fauxEngine([auditStep(), auditStep()]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor,
			getChunkTokens: () => 4096, // two batches over the chunky fixture (the factory default, 4096 — halved back 2026-10-13)
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(events, ["extract1", "audit1", "extract2", "audit2"], "strict per-source order: extract → audit → merge → NEXT extract");
		assert.equal(stats.nodes, 4, "both batches merged (2 propositions each)");
	});
});

describe("chain simplification (the merger's maintenance pass, owner 2026-09-30 evening)", () => {
	const chain = (id: string, premises: string[], conclusion: string, createdAt: string): GraphChain => ({
		id,
		premises,
		conclusion,
		createdAt,
		provenance: [{ chatId: "src_1", messageId: "" }],
	});

	it("the owner example: [A,B]⇒X + [X,C]⇒Y make [A,B,C]⇒Y redundant (ancestry-cover)", () => {
		const kept = simplifyChains([
			chain("arg_3", ["n_a", "n_b", "n_c"], "n_y", "2026-09-30T03:00:00.000Z"),
			chain("arg_1", ["n_a", "n_b"], "n_x", "2026-09-30T01:00:00.000Z"),
			chain("arg_2", ["n_x", "n_c"], "n_y", "2026-09-30T02:00:00.000Z"),
		]);
		assert.deepEqual(kept.map((c) => c.id).sort(), ["arg_1", "arg_2"]);
	});

	it("prefer-fewest-premises: a strict premise-superset of a kept chain drops", () => {
		const kept = simplifyChains([
			chain("arg_1", ["n_a"], "n_z", "2026-09-30T01:00:00.000Z"),
			chain("arg_2", ["n_a", "n_b"], "n_z", "2026-09-30T02:00:00.000Z"),
		]);
		assert.deepEqual(kept.map((c) => c.id), ["arg_1"]);
	});

	it("genuinely different routes to one conclusion stand; a superset route yields to the lean one", () => {
		const kept = simplifyChains([
			chain("arg_1", ["n_a"], "n_y", "2026-09-30T01:00:00.000Z"),
			chain("arg_2", ["n_b"], "n_y", "2026-09-30T02:00:00.000Z"),
			chain("arg_3", ["n_c", "n_d"], "n_y", "2026-09-30T03:00:00.000Z"),
			chain("arg_4", ["n_a", "n_c"], "n_y", "2026-09-30T04:00:00.000Z"),
		]);
		// arg_3's premises are covered by NO kept chain — an independent
		// route, it stands. arg_4 is a strict premise-superset of arg_1's
		// route (n_a already suffices) — the lean derivation wins.
		assert.deepEqual(kept.map((c) => c.id).sort(), ["arg_1", "arg_2", "arg_3"]);
	});

	it("ancestry reaches transitively: [W]⇒A chains through [A,B]⇒X", () => {
		const kept = simplifyChains([
			chain("arg_1", ["n_w"], "n_a", "2026-09-30T01:00:00.000Z"),
			chain("arg_2", ["n_a", "n_b"], "n_x", "2026-09-30T02:00:00.000Z"),
			chain("arg_3", ["n_x", "n_c"], "n_y", "2026-09-30T03:00:00.000Z"),
			chain("arg_4", ["n_w", "n_b", "n_c"], "n_y", "2026-09-30T04:00:00.000Z"),
		]);
		assert.deepEqual(kept.map((c) => c.id).sort(), ["arg_1", "arg_2", "arg_3"]);
	});

	it("same-key provenance lines drop TOGETHER (a key is kept or dropped as a whole)", () => {
		const kept = simplifyChains([
			chain("arg_1", ["n_a"], "n_z", "2026-09-30T01:00:00.000Z"),
			{ ...chain("arg_1", ["n_a"], "n_z", "2026-09-30T01:00:00.000Z"), provenance: [{ chatId: "src_2", messageId: "" }] },
			chain("arg_2", ["n_a", "n_b"], "n_z", "2026-09-30T02:00:00.000Z"),
			{ ...chain("arg_2", ["n_a", "n_b"], "n_z", "2026-09-30T02:00:00.000Z"), provenance: [{ chatId: "src_2", messageId: "" }] },
		]);
		assert.deepEqual(kept.map((c) => c.id), ["arg_1", "arg_1"], "the superset key's every line went, the kept key's every line stayed");
	});

	it("the merge applies it live: a redundant arrival is skipped silently, stats count appends and drops", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		// Seed [A,B]⇒X and [X,C]⇒Y as an earlier source's chains.
		const seedNode = (id: string, name: string): GraphNode => ({
			id,
			name,
			statement: `statement of ${name}`,
			aliases: [],
			createdAt: "2026-09-30T00:00:00.000Z",
			provenance: [{ chatId, messageId: "m0" }],
		});
		for (const [id, name] of [
			["n_a", "A"],
			["n_b", "B"],
			["n_c", "C"],
			["n_x", "X"],
			["n_y", "Y"],
		] as const)
			ledgers.appendNode(seedNode(id, name));
		ledgers.appendChain(chain("arg_1", ["n_a", "n_b"], "n_x", "2026-09-30T01:00:00.000Z"));
		ledgers.appendChain(chain("arg_2", ["n_x", "n_c"], "n_y", "2026-09-30T02:00:00.000Z"));

		// The chat re-asserts the full derivation [A,B,C]⇒Y (all-existing
		// ids, digest references) — redundant given what stands.
		const redundant: SessionFindings = {
			propositions: [],
			chains: [{ premises: ["n_a", "n_b", "n_c"], conclusion: "n_y" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", redundant),
			auditor: submitModel("submit_review", { links: [] }),
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.equal(stats.chains, 1, "the append happened (stats count activity)");
		assert.equal(stats.droppedChains, 1, "the simplification pass then removed it (maintenance)");
		const stored = ledgers.readChains();
		assert.equal(stored.length, 2, "the ledger is back to the two lean chains");
	});
});


describe("notes import completion and retry reliability", () => {
	const input = { filePath: "reliability.md", text: NOTES_TEXT };
	const make = (graphStore: GraphStore, extractor = submitModel("submit_findings", NOTES_FINDINGS)) =>
		createExtractionPipeline({ chatStore, graphStore, extractor, auditor: submitModel("submit_review", NOTES_VERDICT) });
	const incomplete = (outcome: NotesImportError["outcome"], nodes: number) => (error: unknown) => {
		assert.ok(error instanceof NotesImportError);
		assert.equal(error.outcome, outcome);
		assert.equal(error.partialStats.nodes, nodes);
		return true;
	};

	it("failure followed by an unchanged retry really extracts and preserves both usage records", async () => {
		const ledgers = memoryLedgers();
		await assert.rejects(make(ledgers, silentModel()).importNotes(input), incomplete("failed", 0));
		assert.deepEqual(await make(ledgers).importNotes(input), { nodes: 1, chains: 0 });
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("zero new nodes and an empty file are successful, but the readiness gate still applies", async () => {
		const ledgers = memoryLedgers();
		assert.deepEqual(await make(ledgers, submitModel("submit_findings", { propositions: [], chains: [] })).importNotes(input), { nodes: 0, chains: 0 });
		assert.deepEqual(await make(ledgers).importNotes({ ...input, text: " \n" }), { nodes: 0, chains: 0 });
		await assert.rejects(createExtractionPipeline({ chatStore, graphStore: ledgers }).importNotes({ ...input, text: "" }), ModelsNotConfiguredError);
		await assert.rejects(createExtractionPipeline({ chatStore, graphStore: ledgers, extractor: submitModel("submit_findings", NOTES_FINDINGS), auditor: submitModel("submit_review", NOTES_VERDICT), providerKeyMissing: () => providerKeyMissing("openai", ["cheap"]) }).importNotes(input), ProviderKeyMissingError);
	});

	it("isolates an ordinary failed chunk, reports partial, and keeps earlier/later merges and usage", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 1,
			engineFor: (role) => role === "auditor" ? submitModel("submit_review", NOTES_VERDICT) : fauxEngine([() => {
				calls++;
				if (calls === 2) throw new Error("synthetic failed chunk");
				return fauxAssistantMessage([fauxToolCall("submit_findings", NOTES_FINDINGS as unknown as ToolCall["arguments"])], { stopReason: "toolUse" });
			}]),
		});
		await assert.rejects(pipeline.importNotes({ ...input, text: "first chunk\nsecond chunk\nthird chunk" }), incomplete("partial", 2));
		assert.equal(calls, 3);
		assert.equal(ledgers.readNodes().length, 2);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 3);
	});

	it("an abort after an earlier merge stops later chunks without losing graph or billed usage", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 1,
			engineFor: (role) => role === "auditor" ? submitModel("submit_review", NOTES_VERDICT) : submitModel("submit_findings", NOTES_FINDINGS, () => {
				calls++;
				if (calls === 2) abortExtraction(ledgers.readSources()[0]!.id);
			}),
		});
		await assert.rejects(pipeline.importNotes({ ...input, text: "first chunk\nsecond chunk\nthird chunk" }), incomplete("aborted", 1));
		assert.equal(calls, 2);
		assert.equal(ledgers.readNodes().length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	for (const abortAt of [1, 2]) it(`abort in chunk ${abortAt} survives a usage-persistence error and stops later chunks`, async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		let cancelled = false;
		let usageFailures = 0;
		const graphStore: GraphStore = { ...ledgers, appendSourceUsage: (id, entry) => {
			if (cancelled) { usageFailures++; throw new Error("synthetic usage persistence failure during abort"); }
			ledgers.appendSourceUsage(id, entry);
		} };
		const pipeline = createExtractionPipeline({
			chatStore, graphStore, getChunkTokens: () => 1,
			engineFor: (role) => role === "auditor" ? submitModel("submit_review", NOTES_VERDICT) : submitModel("submit_findings", NOTES_FINDINGS, () => {
				calls++;
				if (calls === abortAt) {
					cancelled = true;
					assert.equal(abortExtraction(ledgers.readSources()[0]!.id), true);
				}
			}),
		});
		const wholeFile = { ...input, text: "first chunk\nsecond chunk\nthird chunk" };
		await assert.rejects(pipeline.importNotes(wholeFile), (error) => {
			incomplete("aborted", abortAt - 1)(error);
			assert.match((error as NotesImportError).message, /synthetic usage persistence failure during abort/);
			return true;
		});
		assert.equal(calls, abortAt, "no later extractor runs with a fresh controller after cancellation");
		assert.equal(usageFailures, 1, "the aborted chunk attempted to persist usage and surfaced its failure");
		assert.equal(ledgers.readNodes().length, abortAt - 1, "earlier graph merges retained");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, abortAt - 1, "earlier usage retained");
		assert.equal(extractionStatuses().length, 0, "cancelled job row removed");
		assert.deepEqual(await make(ledgers).importNotes(wholeFile), { nodes: 1, chains: 0 }, "source exclusion released for an explicit unchanged whole-file retry");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, abortAt);
	});

	it("a usage-persistence error without an aborted signal remains an isolated failure and later chunks run", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		const graphStore: GraphStore = { ...ledgers, appendSourceUsage: (id, entry) => {
			if (calls === 1) throw new Error("synthetic isolated usage failure");
			ledgers.appendSourceUsage(id, entry);
		} };
		const pipeline = createExtractionPipeline({
			chatStore, graphStore, getChunkTokens: () => 1,
			engineFor: (role) => role === "auditor" ? submitModel("submit_review", NOTES_VERDICT) : submitModel("submit_findings", NOTES_FINDINGS, () => { calls++; }),
		});
		await assert.rejects(pipeline.importNotes({ ...input, text: "first chunk\nsecond chunk\nthird chunk" }), (error) => {
			incomplete("partial", 3)(error);
			assert.match((error as NotesImportError).message, /synthetic isolated usage failure/);
			return true;
		});
		assert.equal(calls, 3, "ordinary cleanup failure does not imply cancellation");
		assert.equal(ledgers.readNodes().length, 3);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("overlapping identical or different contents are busy BEFORE source metadata changes, across pipeline instances", async () => {
		const ledgers = memoryLedgers();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let upserts = 0;
		const tracked = { ...ledgers, upsertSource: (source: NotesSource) => { upserts++; ledgers.upsertSource(source); } };
		const first = make(tracked, gatedSubmitModel("submit_findings", NOTES_FINDINGS, gate)).importNotes(input);
		const sourceBefore = structuredClone(ledgers.readSources());
		try {
			await assert.rejects(make(tracked).importNotes(input), incomplete("busy", 0));
			await assert.rejects(make(tracked).importNotes({ ...input, text: "changed" }), incomplete("busy", 0));
			assert.equal(upserts, 1, "busy calls cannot even attempt source metadata writes");
			assert.deepEqual(ledgers.readSources(), sourceBefore);
		} finally { release(); }
		await first;
		assert.deepEqual(await make(ledgers).importNotes(input), { nodes: 1, chains: 0 }, "lock released after lifecycle");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("a fulfilled zero-node chunk plus a failed chunk is partial, not failed or completed", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 1,
			engineFor: (role) => role === "auditor" ? submitModel("submit_review", NOTES_VERDICT) : fauxEngine([() => {
				if (++calls === 2) throw new Error("synthetic failed chunk");
				return fauxAssistantMessage([fauxToolCall("submit_findings", { propositions: [], chains: [] })], { stopReason: "toolUse" });
			}]),
		});
		await assert.rejects(pipeline.importNotes({ ...input, text: "first chunk\nsecond chunk" }), incomplete("partial", 0));
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("a merger failure after a node append is incomplete without rolling back that write", async () => {
		const ledgers = memoryLedgers();
		const broken = { ...ledgers, appendCheckpoint: () => { throw new Error("synthetic checkpoint failure after node append"); } };
		await assert.rejects(make(broken).importNotes(input), incomplete("failed", 0));
		assert.equal(ledgers.readNodes().length, 1, "already appended graph write retained even though merge never returned stats");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1);
	});

	for (const seam of ["layout", "usage"] as const) it(`a post-merge ${seam} failure is not false success and reports committed stats`, async () => {
		const ledgers = memoryLedgers();
		const originalUsage = ledgers.appendSourceUsage;
		let failed = false;
		const broken: GraphStore = { ...ledgers,
			...(seam === "layout" ? { writePositions: () => { throw new Error("synthetic layout failure"); } } : {
				appendSourceUsage: (id, entry) => { if (!failed) { failed = true; throw new Error("synthetic usage failure"); } originalUsage(id, entry); },
			}),
		};
		await assert.rejects(make(broken).importNotes(input), incomplete("failed", 1));
		assert.equal(ledgers.readNodes().length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1);
		await make(ledgers).importNotes(input);
	});

	it("source-upsert failure is typed and releases exclusion for retry", async () => {
		const ledgers = memoryLedgers();
		await assert.rejects(make({ ...ledgers, upsertSource: () => { throw new Error("synthetic metadata failure"); } }).importNotes(input), incomplete("failed", 0));
		await make(ledgers).importNotes(input);
	});

	for (const filePath of ["1.md", "1.1.md", "1 notes.md", "1.1 notes.md"]) it(`imports and repeats identical text for ${filePath}`, async () => {
		const ledgers = memoryLedgers();
		await make(ledgers).importNotes({ ...input, filePath });
		await make(ledgers).importNotes({ ...input, filePath });
		assert.equal(ledgers.readSources().length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
		assert.equal(ledgers.readNodes().length, 2);
	});
});
