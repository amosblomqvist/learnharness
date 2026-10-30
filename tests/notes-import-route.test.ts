import assert from "node:assert/strict";
import { after, it } from "node:test";
import { POST } from "../app/api/graph/import/route.ts";
import { extraction } from "../src/server/index.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";
import { createExtractionPipeline, NotesImportError } from "../src/agent/subagents/extraction.ts";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { stores } from "../src/server/stores.ts";
import type { GraphStore } from "../src/core/ports.ts";
import type { GraphNode, GraphChain, NotesSource, SessionCheckpoint } from "../src/core/contracts.ts";

const original = extraction.importNotes;
after(() => { extraction.importNotes = original; });
function request(names: string[]) {
	const form = new FormData();
	for (const name of names) form.append("files", new File(["identical text"], name));
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}

it("route keeps three-worker batching, request positions and mixed per-file outcomes/config details", async () => {
	let active = 0;
	let peak = 0;
	extraction.importNotes = async ({ filePath }) => {
		active++; peak = Math.max(peak, active);
		try {
			await new Promise((resolve) => setTimeout(resolve, filePath === "slow.md" ? 25 : 1));
			if (filePath === "models.md") throw new ModelsNotConfiguredError(["cheap"]);
			if (filePath === "key.md") throw new ProviderKeyMissingError("openai", ["cheap"]);
			if (["failed", "partial", "aborted", "busy"].includes(filePath)) throw new NotesImportError(filePath as NotesImportError["outcome"], { nodes: 2, chains: 1 }, `synthetic ${filePath}`);
			if (filePath === "unknown.md") throw new Error("synthetic unknown error");
			return { nodes: 0, chains: 0 };
		} finally { active--; }
	};
	const names = ["slow.md", "same.md", "same.md", "failed", "partial", "aborted", "busy", "models.md", "key.md", "unknown.md"];
	const response = await POST(request(names));
	assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.equal(peak, 3);
	assert.notEqual(results[0].requestIndex, 0, "out-of-order completion remains supported");
	assert.equal(results.length, names.length);
	for (const [requestIndex, filePath] of names.entries()) {
		const result = results.find((r: { requestIndex: number }) => r.requestIndex === requestIndex);
		assert.equal(result.filePath, filePath);
		if (["failed", "partial", "aborted", "busy"].includes(filePath)) {
			assert.equal(result.outcome, filePath);
			assert.equal(result.ok, false);
			assert.deepEqual(result.stats, { nodes: 2, chains: 1 });
		} else if (["slow.md", "same.md"].includes(filePath)) {
			assert.equal(result.outcome, "completed"); assert.equal(result.ok, true);
		} else { assert.equal(result.ok, false); assert.equal(result.outcome, "failed"); }
	}
	assert.deepEqual(results.find((r: { filePath: string }) => r.filePath === "models.md").missing, ["cheap"]);
	const key = results.find((r: { filePath: string }) => r.filePath === "key.md");
	assert.equal(key.code, "provider_key_missing"); assert.equal(key.provider, "openai"); assert.deepEqual(key.slots, ["cheap"]);
});

it("real route plus in-memory ledgers and faux stages reprocess identical imports for all four filename cases", async () => {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const sources = new Map<string, NotesSource>();
	const graphStore: GraphStore = {
		appendNode: (node) => { nodes.push(node); }, readNodes: () => [...nodes],
		appendChain: (chain) => { chains.push(chain); }, readChains: () => [...chains],
		appendCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }, readCheckpoints: () => [...checkpoints],
		appendCoverage: () => {}, readCoverage: () => [],
		upsertSource: (source) => { sources.set(source.id, { ...source, extractions: sources.get(source.id)?.extractions ?? [] }); },
		readSources: () => [...sources.values()],
		appendSourceUsage: (id, usage) => { sources.get(id)!.extractions!.push(usage); },
		readPositions: () => ({}), writePositions: () => {}, rewriteLedgers: () => {},
	};
	let calls = 0;
	const pipeline = createExtractionPipeline({ chatStore: stores.chatStore, graphStore,
		engineFor: (role) => {
			const faux = createFauxCore({});
			faux.setResponses([() => {
				if (role === "extractor") calls++;
				return fauxAssistantMessage([fauxToolCall(role === "extractor" ? "submit_findings" : "submit_review", role === "extractor" ? {
					propositions: [{ id: "p1", name: "Synthetic import", statement: "Explicit notes imports process the whole file.", aliases: [] }], chains: [],
				} : { links: [] })], { stopReason: "toolUse" });
			}]);
			return { model: faux.getModel(), streamFn: faux.streamSimple };
		},
	});
	extraction.importNotes = pipeline.importNotes;
	const names = ["1.md", "1.1.md", "1 notes.md", "1.1 notes.md"];
	for (let pass = 0; pass < 2; pass++) {
		const response = await POST(request(names));
		const { results } = await response.json();
		assert.equal(results.length, 4);
		assert.ok(results.every((r: { ok: boolean; outcome: string }) => r.ok && r.outcome === "completed"));
	}
	assert.equal(calls, 8, "repeat identical imports execute real faux extractor calls");
	assert.equal(nodes.length, 8);
	assert.equal(sources.size, 4);
	assert.ok([...sources.values()].every((source) => source.extractions?.length === 2 && source.contentFp === undefined));
});

it("route returns 400 without files", async () => {
	const response = await POST(request([]));
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { results: [], error: "no files" });
});

it("route hands PDFs and images over as bytes and refuses oversized ones per file (issue #285)", async () => {
	const seen: Parameters<typeof extraction.importNotes>[0][] = [];
	extraction.importNotes = async (input) => { seen.push(input); return { nodes: 0, chains: 0 }; };
	const png = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	]);
	const huge = new Uint8Array(25 * 1024 * 1024 + 1);
	huge.set(new TextEncoder().encode("%PDF-"));
	const form = new FormData();
	form.append("files", new File([new TextEncoder().encode("%PDF-1.7\n")], "lecture.pdf"));
	form.append("files", new File([png], "board.png"));
	form.append("files", new File(["# plain notes"], "notes.md"));
	form.append("files", new File([huge], "huge.pdf"));
	const response = await POST(new Request("http://localhost/api/graph/import", { method: "POST", body: form }));
	const { results } = await response.json();
	const byName = (name: string) => results.find((r: { filePath: string }) => r.filePath === name);
	assert.ok(["lecture.pdf", "board.png", "notes.md"].every((name) => byName(name).ok));
	assert.deepEqual(byName("huge.pdf"), { filePath: "huge.pdf", requestIndex: 3, outcome: "failed", ok: false, error: "File too large (over 25 MB)" });
	const input = (name: string) => seen.find((i) => i.filePath === name)!;
	assert.ok("pdf" in input("lecture.pdf"));
	const board = input("board.png");
	assert.ok("image" in board && board.mimeType === "image/png");
	assert.deepEqual(input("notes.md"), { filePath: "notes.md", text: "# plain notes" });
	assert.equal(seen.length, 3, "the oversized file never reaches the pipeline");
});
