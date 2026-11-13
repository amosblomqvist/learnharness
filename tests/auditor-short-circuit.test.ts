import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { createExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import type { GraphChain, GraphNode, NotesSource } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { chatStore } from "../src/store/chats.ts";
import type { PiEngine } from "../src/agent/models.ts";

function createMemoryGraphStore(initialNodes: GraphNode[] = []): GraphStore {
	const nodes: GraphNode[] = [...initialNodes];
	const chains: GraphChain[] = [];
	const sources = new Map<string, NotesSource>();
	return {
		appendNode: (n) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendChain: (c) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		appendCheckpoint: () => {},
		readCheckpoints: () => [],
		appendCoverage: () => {},
		readCoverage: () => [],
		upsertSource: (s) => { sources.set(s.id, s); },
		readSources: () => [...sources.values()],
		deleteSources: (ids) => [...ids].reduce((count, id) => count + Number(sources.delete(id)), 0),
		appendSourceUsage: () => {},
		readPositions: () => ({}),
		writePositions: () => {},
		rewriteLedgers: () => {},
	};
}

function submitEngine(name: string, input: unknown, onCall?: () => void): PiEngine {
	const faux = createFauxCore({});
	const step: FauxResponseStep = () => {
		onCall?.();
		return fauxAssistantMessage(
			[fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })],
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses([step]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("Auditor short-circuiting", () => {
	it("skips auditor LLM call when graph has no existing nodes", async () => {
		let auditorCalled = false;
		const graphStore = createMemoryGraphStore([]);

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore,
			extractor: submitEngine("submit_findings", {
				propositions: [{ id: "p1", name: "Concept A", statement: "Statement A" }],
				chains: [],
			}),
			auditor: submitEngine("submit_review", { links: [] }, () => {
				auditorCalled = true;
			}),
		});

		const stats = await pipeline.importNotes({ filePath: "test.md", text: "Some notes" });
		assert.equal(stats.nodes, 1);
		assert.equal(auditorCalled, false, "Auditor LLM must not be called when graph has 0 nodes");
	});

	it("skips auditor LLM call when no candidates match any propositions", async () => {
		let auditorCalled = false;
		const existingNode: GraphNode = {
			id: "existing_1",
			name: "Completely Unrelated Zoology",
			statement: "Mammals have hair and produce milk.",
			aliases: [],
			provenance: [{ chatId: "src_1", messageId: "" }],
			createdAt: "2026-11-13T00:00:00.000Z",
		};
		const graphStore = createMemoryGraphStore([existingNode]);

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore,
			extractor: submitEngine("submit_findings", {
				propositions: [{ id: "p2", name: "Quantum Superposition", statement: "Particles exist in multiple states." }],
				chains: [],
			}),
			auditor: submitEngine("submit_review", { links: [] }, () => {
				auditorCalled = true;
			}),
		});

		const stats = await pipeline.importNotes({ filePath: "quantum.md", text: "Quantum physics text" });
		assert.equal(stats.nodes, 1);
		assert.equal(auditorCalled, false, "Auditor LLM must not be called when 0 candidates match");
	});
});
