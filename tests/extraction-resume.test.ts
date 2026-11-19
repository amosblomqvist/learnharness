/**
 * Resumable notes extraction (owner, 2026-11-13): a stopped import of the
 * same file text at the same chunk budget resumes at the first chunk that
 * never merged instead of re-paying the whole book. The checkpoint lives on
 * the NotesSource record (`resume`), so it survives process restarts and a
 * re-upload of the same file.
 *
 * Laws pinned here:
 *  - only successfully merged LEADING chunks advance `done`
 *  - a completed run clears the checkpoint (an explicit re-import stays whole)
 *  - a changed file text or chunk budget starts from chunk 1
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { CoverageEntry, ExtractionRunUsage, GraphChain, GraphNode, NotesSource, SessionCheckpoint } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { createExtractionPipeline, NotesImportError } from "../src/agent/subagents/extraction.ts";
import { chatStore } from "../src/store/chats.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

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
		appendCoverage: (e) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
		upsertSource: (s: NotesSource) => {
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
		readPositions: () => Object.fromEntries([...positions].map(([id, p]) => [id, { ...p }])),
		writePositions: (next) => {
			positions.clear();
			for (const [id, p] of Object.entries(next)) positions.set(id, { x: p.x, y: p.y });
		},
		rewriteLedgers: (next) => {
			if (next.nodes) nodes.splice(0, nodes.length, ...next.nodes.map((n) => ({ ...n, provenance: [...n.provenance], aliases: [...n.aliases] })));
			if (next.chains) chains.splice(0, chains.length, ...next.chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })));
			if (next.coverage) coverage.splice(0, coverage.length, ...next.coverage.map((c) => ({ ...c })));
			if (next.checkpoints) checkpoints.splice(0, checkpoints.length, ...next.checkpoints.map((c) => ({ ...c })));
		},
	} satisfies GraphStore;
}

const FINDINGS = {
	propositions: [{ id: "p1", name: "Vim normal mode", statement: "Vim starts in Normal mode, where keys are commands.", aliases: [] }],
	chains: [],
};
const VERDICT = { links: [], edges: [] } as const;

/** Three chunks at budget 1: one heading-less line each. */
const THREE = "first chunk line\nsecond chunk line\nthird chunk line";
const TWO = "first chunk line\nsecond chunk line";

/** An extractor that counts model calls and can fail at a chosen 1-based
 *  call. Faux steps are one-shot, so the queue is pre-built per run. */
function countingExtractor(failAt?: number, steps = 6): { engine: PiEngine; calls: () => number } {
	let calls = 0;
	const step = () => {
		calls++;
		if (failAt !== undefined && calls === failAt) throw new Error("synthetic failed chunk");
		return fauxAssistantMessage([fauxToolCall("submit_findings", FINDINGS as unknown as ToolCall["arguments"])], { stopReason: "toolUse" });
	};
	return { engine: fauxEngine(Array.from({ length: steps }, () => step)), calls: () => calls };
}

/** A pipeline over one store whose extractor fails at call `failAt` only on
 *  its first run (later runs are clean). */
function pipeline(ledgers: GraphStore, extractor: PiEngine) {
	return createExtractionPipeline({
		chatStore,
		graphStore: ledgers,
		getChunkTokens: () => 1,
		extractor,
		auditor: fauxEngine(Array.from({ length: 8 }, () => () =>
			fauxAssistantMessage([fauxToolCall("submit_review", VERDICT as unknown as ToolCall["arguments"])], { stopReason: "toolUse" }))),
	});
}

const input = { filePath: "/vault/three.md", text: THREE };

function unfinished(error: unknown): boolean {
	assert.ok(error instanceof NotesImportError);
	assert.notEqual(error.outcome, "completed");
	return true;
}

// ─── the laws ────────────────────────────────────────────────────────────────

describe("resumable notes extraction", () => {
	it("resumes after the last merged chunk of a partial run instead of re-extracting the whole file", async () => {
		const ledgers = memoryLedgers();
		const first = countingExtractor(3);
		await assert.rejects(pipeline(ledgers, first.engine).importNotes(input), unfinished);
		assert.equal(first.calls(), 3, "all three chunks were attempted once");
		const checkpoint = ledgers.readSources()[0]!.resume;
		assert.deepEqual(checkpoint && { chunks: checkpoint.chunks, done: checkpoint.done }, { chunks: 3, done: 2 }, "the leading two chunks merged before the failure");

		const retry = countingExtractor();
		await pipeline(ledgers, retry.engine).importNotes(input);
		assert.equal(retry.calls(), 1, "only the unfinished third chunk re-ran");
		assert.equal(ledgers.readSources()[0]!.resume, undefined, "a completed run clears the checkpoint");
	});

	it("starts from the top when the file text changed", async () => {
		const ledgers = memoryLedgers();
		await assert.rejects(pipeline(ledgers, countingExtractor(3).engine).importNotes(input), unfinished);

		const retry = countingExtractor();
		await pipeline(ledgers, retry.engine).importNotes({ filePath: input.filePath, text: TWO });
		assert.equal(retry.calls(), 2, "different text means a different fingerprint: both chunks run");
		assert.equal(ledgers.readSources()[0]!.resume, undefined);
	});

	it("a completed import re-imports the whole file (no silent skip)", async () => {
		const ledgers = memoryLedgers();
		await pipeline(ledgers, countingExtractor().engine).importNotes(input);
		const retry = countingExtractor();
		await pipeline(ledgers, retry.engine).importNotes(input);
		assert.equal(retry.calls(), 3);
	});

	it("a failed first chunk leaves no resume point", async () => {
		const ledgers = memoryLedgers();
		await assert.rejects(pipeline(ledgers, countingExtractor(1).engine).importNotes(input), unfinished);
		assert.equal(ledgers.readSources()[0]!.resume, undefined);
	});

	it("retries a final usage write failure without model calls, then explicitly re-imports all chunks", async () => {
		const ledgers = memoryLedgers();
		const first = countingExtractor();
		const appendUsage = ledgers.appendSourceUsage;
		let failUsage = true;
		ledgers.appendSourceUsage = (id, entry) => {
			if (failUsage && first.calls() === 3 && entry.stats) {
				failUsage = false;
				throw new Error("synthetic final usage write failure");
			}
			appendUsage(id, entry);
		};
		await assert.rejects(pipeline(ledgers, first.engine).importNotes(input), (error: unknown) => {
			unfinished(error);
			assert.ok(error instanceof NotesImportError);
			assert.match(error.message, /synthetic final usage write failure/);
			assert.equal(error.partialStats.nodes, 3, "all merges landed even though usage persistence failed");
			return true;
		});
		assert.equal(first.calls(), 3);
		const checkpoint = ledgers.readSources()[0]!.resume;
		assert.deepEqual(checkpoint && { chunks: checkpoint.chunks, done: checkpoint.done }, { chunks: 3, done: 3 });
		const usage = ledgers.readSources()[0]!.extractions;

		const retry = countingExtractor();
		const stats = await pipeline(ledgers, retry.engine).importNotes(input);
		assert.equal(retry.calls(), 0, "a full committed prefix skips all extractor calls");
		assert.deepEqual(stats, { nodes: 0, chains: 0 });
		assert.equal(ledgers.readSources()[0]!.resume, undefined);
		assert.deepEqual(ledgers.readSources()[0]!.extractions, usage, "a no-model retry invents no usage recovery");

		const reimport = countingExtractor();
		await pipeline(ledgers, reimport.engine).importNotes(input);
		assert.equal(reimport.calls(), 3, "clearing the checkpoint keeps explicit re-import whole");
	});

	for (const [label, fields] of [
		["fractional done", { done: 1.5 }],
		["done exceeds chunks", { done: 4 }],
		["string done", { done: "2" }],
		["string chunks", { chunks: "3" }],
	] as const) {
		it(`restarts every chunk for an injected malformed checkpoint (${label})`, async () => {
			const ledgers = memoryLedgers();
			await assert.rejects(pipeline(ledgers, countingExtractor(3).engine).importNotes(input), unfinished);
			const source = ledgers.readSources()[0]!;
			const resume = JSON.parse(JSON.stringify({ ...source.resume, ...fields }));
			ledgers.upsertSource({ ...source, resume });

			const retry = countingExtractor();
			await pipeline(ledgers, retry.engine).importNotes(input);
			assert.equal(retry.calls(), 3, "injected stores must not bypass checkpoint validation");
			assert.equal(ledgers.readSources()[0]!.resume, undefined);
		});
	}

	it("clears an incompatible checkpoint before changed text fails, so reverting text starts whole", async () => {
		const ledgers = memoryLedgers();
		await assert.rejects(pipeline(ledgers, countingExtractor(3).engine).importNotes(input), unfinished);
		const changed = countingExtractor(1);
		await assert.rejects(pipeline(ledgers, changed.engine).importNotes({ filePath: input.filePath, text: "changed first chunk line" }), unfinished);
		assert.equal(changed.calls(), 1);
		assert.equal(ledgers.readSources()[0]!.resume, undefined, "the old text's checkpoint is gone before the first changed chunk runs");

		const reverted = countingExtractor();
		await pipeline(ledgers, reverted.engine).importNotes(input);
		assert.equal(reverted.calls(), 3, "reverting text must not resurrect the old completed prefix");
	});

	it("clears an incompatible chunk budget before extraction starts", async () => {
		const ledgers = memoryLedgers();
		await assert.rejects(pipeline(ledgers, countingExtractor(3).engine).importNotes(input), unfinished);
		const changed = countingExtractor(1);
		const changedPipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			getChunkTokens: () => 100,
			extractor: changed.engine,
			auditor: fauxEngine([() => fauxAssistantMessage([fauxToolCall("submit_review", VERDICT as unknown as ToolCall["arguments"])], { stopReason: "toolUse" })]),
		});
		await assert.rejects(changedPipeline.importNotes(input), unfinished);
		assert.equal(changed.calls(), 1);
		assert.equal(ledgers.readSources()[0]!.resume, undefined);

		const retry = countingExtractor();
		await pipeline(ledgers, retry.engine).importNotes(input);
		assert.equal(retry.calls(), 3);
	});

	it("does not advance the prefix when persisting the checkpoint fails", async () => {
		const ledgers = memoryLedgers();
		const upsertSource = ledgers.upsertSource;
		let failCheckpoint = true;
		ledgers.upsertSource = (source) => {
			if (failCheckpoint && source.resume) {
				failCheckpoint = false;
				throw new Error("synthetic checkpoint write failure");
			}
			upsertSource(source);
		};
		const first = countingExtractor();
		await assert.rejects(pipeline(ledgers, first.engine).importNotes(input), unfinished);
		assert.equal(first.calls(), 3);
		assert.equal(ledgers.readSources()[0]!.resume, undefined, "later merges cannot jump over the unpersisted leading chunk");

		const retry = countingExtractor();
		await pipeline(ledgers, retry.engine).importNotes(input);
		assert.equal(retry.calls(), 3);
	});

	it("persists a committed checkpoint before layout fails", async () => {
		const ledgers = memoryLedgers();
		const writePositions = ledgers.writePositions;
		ledgers.writePositions = () => { throw new Error("synthetic layout write failure"); };
		const first = countingExtractor();
		await assert.rejects(pipeline(ledgers, first.engine).importNotes(input), unfinished);
		assert.equal(first.calls(), 3);
		assert.equal(ledgers.readSources()[0]!.resume?.done, 3, "layout failure must not erase committed merges");
		assert.deepEqual(ledgers.readPositions(), {});
		const failedRetry = countingExtractor();
		await assert.rejects(pipeline(ledgers, failedRetry.engine).importNotes(input), (error: unknown) => {
			unfinished(error);
			assert.ok(error instanceof NotesImportError);
			assert.match(error.message, /synthetic layout write failure/);
			return true;
		});
		assert.equal(failedRetry.calls(), 0);
		assert.equal(ledgers.readSources()[0]!.resume?.done, 3);
		ledgers.writePositions = writePositions;

		const retry = countingExtractor();
		const stats = await pipeline(ledgers, retry.engine).importNotes(input);
		assert.equal(retry.calls(), 0);
		assert.deepEqual(stats, { nodes: 0, chains: 0 });
		const positions = ledgers.readPositions();
		assert.ok(Object.keys(positions).length > 0, "completed retry restores the rendered layout ledger");
		for (const node of ledgers.readNodes()) {
			const position = positions[node.id];
			assert.ok(position, `missing rendered position for ${node.id}`);
			assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y), `nonfinite rendered position for ${node.id}`);
		}
		assert.equal(ledgers.readSources()[0]!.resume, undefined);
	});
});
