import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MAX_IMPORT_BYTES, NotesImportControl, NotesImportErrors, NotesImportNotices, parseNotesImportResults, postNotesImport, useNotesImport, type NotesImportResult } from "../components/notes-import.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
let current: ReturnType<typeof useNotesImport>;
let starts = 0, finishes = 0;
async function mount() {
	starts = 0; finishes = 0;
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	function Harness() {
		current = useNotesImport({ onStart: () => { starts++; }, onFinish: () => { finishes++; } });
		return <NotesImportErrors errors={current.errors} />;
	}
	await act(async () => { root!.render(<Harness />); });
}
async function submit(selected: File[] | null = [...files]) { await act(async () => { current.onImportFiles(selected as unknown as FileList | null); }); }
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); host = undefined; globalThis.fetch = originalFetch; });
const files = [new File(["one"], "same.md"), new File(["two"], "same.md")];
const completed = (requestIndex = 0, filePath = "same.md"): NotesImportResult => ({ requestIndex, filePath, ok: true, outcome: "completed", stats: { nodes: 0, chains: 0 } });

it("maps out-of-order responses by index, not duplicate basenames", () => {
	const results = [completed(1), { ...completed(0), stats: { nodes: 7 } }];
	assert.deepEqual(parseNotesImportResults({ results }, files), results);
});
for (const [name, results] of [
	["missing index", [{ ...completed(), requestIndex: undefined }, completed(1)]],
	["duplicate index", [completed(), completed()]], ["missing row", [completed()]],
	["out-of-range index", [completed(), completed(2)]],
	["wrong filename", [{ ...completed(), filePath: "different.md" }, completed(1)]],
	["missing stats", [{ ...completed(), stats: undefined }, completed(1)]],
	["unknown outcome", [{ ...completed(), outcome: "unchanged" }, completed(1)]],
	["conflicting ok", [{ ...completed(), ok: false }, completed(1)]],
	["invalid stats", [{ ...completed(), stats: { nodes: "bad" } }, completed(1)]],
	["invalid details", [{ ...completed(), slots: [42] }, completed(1)]],
	["invalid provider", [{ ...completed(), provider: 42 }, completed(1)]],
	["invalid code", [{ ...completed(), code: 42 }, completed(1)]],
	["invalid missing", [{ ...completed(), missing: [42] }, completed(1)]],
	["invalid error", [{ ...completed(), error: 42 }, completed(1)]],
	["invalid notice", [{ ...completed(), notice: 42 }, completed(1)]],
	["missing failure error", [{ ...completed(), ok: false, outcome: "failed" }, completed(1)]],
] as const) it(`malformed response (${name}) warns to inspect before retrying`, () => { assert.throws(() => parseNotesImportResults({ results }, files), /Check the graph before retrying/); });

it("POST includes captured files and relative identities, preserving provider details", async () => {
	const file = new File(["two"], "same.md"); Object.defineProperty(file, "webkitRelativePath", { value: "Course/Week/same.md" });
	const refused: NotesImportResult = { requestIndex: 0, filePath: file.webkitRelativePath, ok: false, outcome: "failed", code: "provider_key_missing", provider: "openai", slots: ["cheap"], error: "No key is set" };
	globalThis.fetch = async (url, init) => {
		assert.equal(url, "/api/graph/import"); assert.equal(init?.method, "POST");
		const form = init?.body as FormData;
		const sent = form.getAll("files") as File[];
		assert.equal(sent.length, 1); assert.equal(await sent[0]!.text(), "two");
		assert.deepEqual(form.getAll("paths"), [file.webkitRelativePath]);
		return Response.json({ results: [refused] });
	};
	assert.deepEqual(await postNotesImport([file]), [refused]);
});

for (const outcome of ["completed", "failed", "partial", "aborted", "busy"] as const) it(`${outcome} preserves escaped raw failure details without result/retry controls`, async () => {
	const file = new File(["notes"], "<script>notes.md");
	const result: NotesImportResult = { ...completed(0, file.name), outcome, ok: outcome === "completed", error: "<img>synthetic failure", code: "provider_key_missing", provider: "openai", missing: ["OPENAI_API_KEY"], slots: ["cheap", "strong"] };
	globalThis.fetch = async () => Response.json({ results: [result] });
	await mount(); await submit([file]);
	assert.equal(current.importing, false); assert.equal(starts, 1); assert.equal(finishes, 1);
	assert.deepEqual(Object.keys(current).sort(), ["errors", "importing", "notices", "onImportFiles"]);
	const html = host!.innerHTML;
	assert.doesNotMatch(html, /<button|<section|<ul|border|bg-card|rounded|shadow|Retry|Dismiss|Import complete/);
	if (outcome === "completed") { assert.equal(html, ""); assert.deepEqual(current.errors, []); }
	else {
		assert.deepEqual(current.errors, [`${file.name}: ${result.error}\nprovider_key_missing — openai — OPENAI_API_KEY — cheap, strong`]);
		assert.match(html, /&lt;script&gt;notes.md: &lt;img&gt;synthetic failure/); assert.match(html, /role="alert"/); assert.doesNotMatch(html, /<script>|<img>/);
	}
});
for (const details of [{ code: "models_not_configured", missing: ["cheap", "strong", "vision"] }, { code: "provider_key_missing", provider: "openai", slots: ["cheap"] }, { code: "provider_key_missing" }, {}]) it(`configuration details survive (${JSON.stringify(details)})`, async () => {
	globalThis.fetch = async () => Response.json({ results: [{ requestIndex: 0, filePath: "same.md", ok: false, outcome: "failed", error: "Existing raw error", ...details }] });
	await mount(); await submit([files[0]!]);
	const suffix = details.code === "models_not_configured" ? "\nmodels_not_configured — cheap, strong, vision" : details.provider ? "\nprovider_key_missing — openai — cheap" : details.code ? "\nprovider_key_missing" : "";
	assert.deepEqual(current.errors, [`same.md: Existing raw error${suffix}`]);
});

it("one-file responses are attributed in selection order despite duplicate basenames and completion order", async () => {
	let i = 0;
	globalThis.fetch = async (_url, init) => {
		const file = (init!.body as FormData).get("files") as File;
		const index = i++;
		return Response.json({ results: [{ requestIndex: 0, filePath: file.name, ok: index === 0, outcome: index === 0 ? "completed" : "partial", stats: { nodes: 0 }, error: index === 1 ? "first duplicate" : "second duplicate" }] });
	};
	await mount(); await submit([new File(["success"], "success.md"), ...files]);
	assert.deepEqual(current.errors, ["same.md: first duplicate", "same.md: second duplicate"]);
});
for (const kind of ["network", "non-JSON", "non-2xx", "malformed", "duplicate index"] as const) it(`${kind} hook failure is visible, never retried or reported as success`, async () => {
	let calls = 0;
	globalThis.fetch = async () => { calls++;
		if (kind === "network") throw new Error("synthetic offline");
		if (kind === "non-JSON") return new Response("not JSON");
		if (kind === "non-2xx") return Response.json({ error: "synthetic refused" }, { status: 503 });
		return Response.json({ results: kind === "duplicate index" ? [completed(), completed()] : [] });
	};
	await mount(); await submit();
	const message = kind === "network" ? "synthetic offline" : kind === "non-2xx" ? "Import request failed (HTTP 503): synthetic refused. Check the graph before retrying." : "Invalid import response. Check the graph before retrying.";
	assert.deepEqual(current.errors, files.map((file) => `${file.name}: ${message}`));
	assert.equal(calls, 2); assert.equal(finishes, 1); assert.equal(current.importing, false);
});

it("cancelled selections leave errors alone; another explicit selection clears them and reimports", async () => {
	globalThis.fetch = async () => Response.json({ results: [] });
	await mount(); await submit(); assert.equal(current.errors.length, 2);
	await submit(null); await submit([]); assert.equal(current.errors.length, 2);
	globalThis.fetch = async () => Response.json({ results: [completed()] });
	await submit(); assert.deepEqual(current.errors, []); assert.equal(finishes, 2); assert.equal(starts, 2);
});
it("PDF notices and failures survive per-file requests, in selection order", async () => {
	globalThis.fetch = async (_url, init) => {
		const file = (init!.body as FormData).get("files") as File;
		return Response.json({ results: [{ ...completed(0, file.name), notice: file.name === "c.pdf" ? "Scanned pages may have errors." : undefined,
			...(file.name === "a.pdf" ? { ok: false, outcome: "failed", error: "OCR not supported yet." } : {}) }] });
	};
	await mount(); await submit([new File(["a"], "a.pdf"), new File(["b"], "b.md"), new File(["c"], "c.pdf")]);
	assert.deepEqual(current.notices, ["c.pdf: Scanned pages may have errors."]); assert.deepEqual(current.errors, ["a.pdf: OCR not supported yet."]);
});
for (const [status, error] of [[413, "Too big. Max 25 MB."], [413, "Import request is too large. Select fewer files."], [400, "Could not read the upload. It may be incomplete; please select the files again."]] as const) it(`server refusal remains readable (${error})`, async () => {
	globalThis.fetch = async () => Response.json({ results: [], error }, { status });
	await mount(); await submit();
	assert.deepEqual(current.errors, files.map((file) => `${file.name}: Import request failed (HTTP ${status}): ${error} Check the graph before retrying.`));
	assert.deepEqual(current.notices, []); assert.equal(current.importing, false);
});
it("25 MiB is per file, not per selection; oversized files fail locally while smaller siblings upload", async () => {
	const sent: string[] = [];
	globalThis.fetch = async (_url, init) => { const file = (init!.body as FormData).get("files") as File; sent.push(file.name); return Response.json({ results: [completed(0, file.name)] }); };
	await mount();
	const half = new Uint8Array(MAX_IMPORT_BYTES / 2 + 1);
	await submit([new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], "textbook.pdf"), new File([half], "a.pdf"), new File([half], "b.pdf")]);
	assert.deepEqual(sent, ["a.pdf", "b.pdf"]); assert.deepEqual(current.errors, ["textbook.pdf: Too big. Max 25 MB."]);
});
it("picker stays enabled during imports, offers Files/Folder, and keeps PDF support", () => {
	const html = renderToStaticMarkup(<NotesImportControl importing onImportFiles={() => {}} />);
	assert.match(html, /webkitdirectory/); assert.match(html, /accept=".md,.markdown,.txt,.pdf"/); assert.doesNotMatch(html, /disabled/);
});
it("alerts/notices stay plain and escaped", () => {
	assert.equal(renderToStaticMarkup(<NotesImportErrors errors={[]} />), "");
	const html = renderToStaticMarkup(<NotesImportErrors errors={["one.md: failure", "two.md: failure"]} />);
	assert.equal((html.match(/role="alert"/g) ?? []).length, 2); assert.doesNotMatch(html, /<section|<button|border|bg-/);
	const notices = renderToStaticMarkup(<NotesImportNotices notices={["a.pdf: Scanned pages may have errors."]} />);
	assert.match(notices, /role="status"/); assert.match(notices, /text-muted-foreground/); assert.doesNotMatch(notices, /text-red/);
});
