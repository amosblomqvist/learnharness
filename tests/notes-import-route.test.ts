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
import { tinyPdf } from "./helpers/tiny-pdf.ts";
import { MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BYTES } from "../lib/notes-import-limits.ts";

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
		deleteSources: (ids) => [...ids].reduce((count, id) => count + Number(sources.delete(id)), 0),
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

function upload(files: { name: string; bytes: Uint8Array<ArrayBuffer> | string }[]) {
	const form = new FormData();
	for (const { name, bytes } of files) form.append("files", new File([bytes], name));
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}

it("a PDF reaches the pipeline as page-marked Markdown and reports skipped image-only pages", async () => {
	const received: string[] = [];
	extraction.importNotes = async ({ text }) => { received.push(text); return { nodes: 1, chains: 0 }; };
	const pdf = tinyPdf([{ image: true }, { runs: [{ text: "Week 3", x: 72, y: 700, size: 20 }, { text: "Plants make sugar.", x: 72, y: 660 }] }]);
	const response = await POST(upload([{ name: "lecture.pdf", bytes: pdf }, { name: "notes.md", bytes: "# plain notes" }]));
	const { results } = await response.json();
	assert.deepEqual(received.sort(), ["# plain notes", "--- Page 2 ---\n\n# Week 3\n\nPlants make sugar."]);
	const byName = (name: string) => results.find((r: { filePath: string }) => r.filePath === name);
	assert.equal(byName("lecture.pdf").outcome, "completed");
	assert.equal(byName("lecture.pdf").notice, "Scanned pages may have errors. Skipped 1 image-only page; OCR is not supported.");
	assert.equal(byName("notes.md").notice, undefined, "text files carry no notice");
});

it("PDFs are known by their bytes, not their names", async () => {
	const received: string[] = [];
	extraction.importNotes = async ({ text }) => { received.push(text); return { nodes: 0, chains: 0 }; };
	const pdf = tinyPdf([{ runs: [{ text: "Inside a misnamed file", x: 72, y: 700 }] }]);
	await POST(upload([{ name: "renamed.txt", bytes: pdf }, { name: "fake.pdf", bytes: "just text" }]));
	assert.deepEqual(received.sort(), ["--- Page 1 ---\n\nInside a misnamed file", "just text"]);
});

it("PDFs with nothing to import are refused before any model call", async () => {
	let calls = 0;
	extraction.importNotes = async () => { calls++; return { nodes: 0, chains: 0 }; };
	const response = await POST(upload([
		{ name: "scan.pdf", bytes: tinyPdf([{ image: true }, {}]) },
		{ name: "broken.pdf", bytes: "%PDF-1.4\nnot really a pdf" },
		{ name: "huge.pdf", bytes: tinyPdf(Array.from({ length: 1001 }, () => ({}))) },
	]));
	const { results } = await response.json();
	assert.equal(calls, 0);
	const errorOf = (name: string) => results.find((r: { filePath: string }) => r.filePath === name);
	for (const [name, error] of [["scan.pdf", "OCR not supported yet."], ["broken.pdf", "Could not open this PDF."], ["huge.pdf", "Too long. Max 1,000 pages."]] as const) {
		assert.equal(errorOf(name).ok, false);
		assert.equal(errorOf(name).outcome, "failed");
		assert.equal(errorOf(name).error, error);
	}
});

it("PDF notices count only image-only pages, not blanks, and preserve the scanner caveat for text-only PDFs", async () => {
	extraction.importNotes = async () => ({ nodes: 0, chains: 0 });
	const text = { runs: [{ text: "Text page", x: 72, y: 600 }] };
	const response = await POST(upload([
		{ name: "mixed.pdf", bytes: tinyPdf([{ image: true }, {}, text, { image: true }]) },
		{ name: "text.pdf", bytes: tinyPdf([text]) },
	]));
	const { results } = await response.json();
	assert.equal(results.find((r: { filePath: string }) => r.filePath === "mixed.pdf").notice,
		"Scanned pages may have errors. Skipped 2 image-only pages; OCR is not supported.");
	assert.equal(results.find((r: { filePath: string }) => r.filePath === "text.pdf").notice, "Scanned pages may have errors.");
	assert.ok(results.every((r: { ok: boolean }) => r.ok));
});

for (const image of ["mask", "inline"] as const) it(`mixed PDF notices include textless ${image} image pages`, async () => {
	extraction.importNotes = async () => ({ nodes: 0, chains: 0 });
	const response = await POST(upload([{ name: "mixed.pdf", bytes: tinyPdf([
		{ runs: [{ text: "Readable text", x: 72, y: 600 }] }, { image },
	]) }]));
	const { results } = await response.json();
	assert.equal(results[0].outcome, "completed");
	assert.equal(results[0].notice, "Scanned pages may have errors. Skipped 1 image-only page; OCR is not supported.");
});

for (const split of [false, true]) it(`server refuses actual file bytes over 25 MiB (${split ? "aggregate" : "single file"}) before the pipeline`, async () => {
	let calls = 0;
	extraction.importNotes = async () => { calls++; return { nodes: 0, chains: 0 }; };
	const files = split
		? [{ name: "a.txt", bytes: new Uint8Array(MAX_IMPORT_BYTES / 2 + 1) }, { name: "b.txt", bytes: new Uint8Array(MAX_IMPORT_BYTES / 2) }]
		: [{ name: "a.txt", bytes: new Uint8Array(MAX_IMPORT_BYTES + 1) }];
	const req = upload(files);
	req.headers.set("content-length", "1"); // not a trustworthy bound
	const response = await POST(req);
	assert.equal(response.status, 413);
	assert.deepEqual(await response.json(), { results: [], error: "Too big. Max 25 MB." });
	assert.equal(calls, 0);
});

it("server accepts exactly 25 MiB of files with multipart overhead below 26 MiB", async () => {
	let received = 0;
	extraction.importNotes = async ({ text }) => { received = text.length; return { nodes: 0, chains: 0 }; };
	const response = await POST(upload([{ name: "boundary.txt", bytes: new Uint8Array(MAX_IMPORT_BYTES) }]));
	assert.equal(response.status, 200);
	assert.equal(received, MAX_IMPORT_BYTES);
	assert.equal((await response.json()).results[0].outcome, "completed");
});

for (const declared of [undefined, "1"]) it(`server bounds streamed body bytes with ${declared ? "a misleading" : "no"} Content-Length and cancels oversize streams`, async () => {
	let calls = 0;
	let chunks = 0;
	let cancelled = false;
	extraction.importNotes = async () => { calls++; return { nodes: 0, chains: 0 }; };
	const body = new ReadableStream<Uint8Array>({
		pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
		cancel() { cancelled = true; },
	}, { highWaterMark: 0 });
	const req = new Request("http://localhost/api/graph/import", { method: "POST", body, duplex: "half",
		headers: { "content-type": "multipart/form-data; boundary=test", ...(declared ? { "content-length": declared } : {}) },
	} as RequestInit);
	const response = await POST(req);
	assert.equal(response.status, 413);
	assert.deepEqual(await response.json(), { results: [], error: "Import request is too large. Select fewer files." });
	assert.equal(chunks, MAX_IMPORT_BODY_BYTES / (1024 * 1024) + 1);
	assert.equal(cancelled, true);
	assert.equal(calls, 0);
});

it("oversized declared body is refused without reading it", async () => {
	let reads = 0;
	let cancelled = false;
	const req = new Request("http://localhost/api/graph/import", { method: "POST", duplex: "half",
		headers: { "content-length": String(MAX_IMPORT_BODY_BYTES + 1) },
		body: new ReadableStream({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }),
	} as RequestInit);
	const response = await POST(req);
	assert.equal(response.status, 413);
	assert.equal(reads, 0);
	assert.equal(cancelled, true);
});

it("malformed or proxy-truncated multipart is refused before any file enters the pipeline", async () => {
	let calls = 0;
	extraction.importNotes = async () => { calls++; return { nodes: 0, chains: 0 }; };
	const complete = upload([{ name: "first.md", bytes: "valid first file" }, { name: "second.md", bytes: "second file" }]);
	const bytes = new Uint8Array(await complete.arrayBuffer());
	for (const req of [
		new Request(complete.url, { method: "POST", body: bytes.slice(0, -20), headers: complete.headers }),
		new Request(complete.url, { method: "POST", body: "not multipart" }),
		new Request(complete.url, { method: "POST" }),
	]) {
		const response = await POST(req);
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { results: [], error: "Could not read the upload. It may be incomplete; please select the files again." });
	}
	assert.equal(calls, 0);
});
