import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it, type TestContext } from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import type { PluginFrontendContext } from "../src/core/plugins.ts";
import { createPluginHost } from "../src/server/plugin-host.ts";
import { createPluginDocumentRoute, createPluginTransport } from "../src/server/plugin-transport.ts";
import { createPluginDocumentConverter } from "../src/server/plugin-documents.ts";
import { convertPdf } from "../src/agent/subagents/pdf-ops.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}
async function fixture(t: TestContext, pdfConverter = convertPdf) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-document-integration-"));
	const directory = path.join(root, "plugins");
	for (const id of ["document-one", "document-two"]) {
		const dist = path.join(directory, id, "dist"); fs.mkdirSync(dist, { recursive: true });
		fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", main: "main.js" }));
		fs.writeFileSync(path.join(dist, "main.js"), "export function activate() {}");
	}
	const converter = createPluginDocumentConverter({ convertPdf: pdfConverter });
	const host = createPluginHost({ directory, appVersion: "0.4.1", convertDocument: converter.convert,
		createServices() { throw new Error("Pure document conversion must not construct backend/model/learning services"); },
	});
	await host.initialize();
	await host.setEnabled("document-one", true); await host.setEnabled("document-two", true);
	const transport = createPluginTransport({ getHost: async () => host, directory });
	const route = createPluginDocumentRoute(transport);
	const contexts = new Map<string, PluginFrontendContext>();
	const statuses: number[] = [];
	const manager = new PluginFrontendManager({
		fetch: async (url, init) => {
			const match = /^\/api\/plugins\/([^/]+)\/documents\/markdown$/.exec(String(url));
			assert.ok(match, "only the document endpoint is called, never graph/import or generation");
			const response = await route.POST(new Request(`http://localhost${url}`, init), { params: Promise.resolve({ id: decodeURIComponent(match[1]!) }) });
			statuses.push(response.status); return response;
		},
		importModule: async () => ({ activate(context) { contexts.set(context.manifest.id, context); } }),
		pathname: () => "/", navigate() {},
	});
	t.after(async () => { await manager.dispose(); await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
	manager.reconcile(host.list()); await tick();
	assert.equal(contexts.size, 2);
	return { root, directory, host, manager, contexts, statuses };
}
function files(directory: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const name = path.join(directory, entry.name);
		if (entry.isDirectory()) for (const [child, bytes] of Object.entries(files(name))) result[`${entry.name}/${child}`] = bytes;
		else result[entry.name] = fs.readFileSync(name).toString("base64");
	}
	return result;
}

it("multipart frontend-to-host flow converts a real renamed PDF and arbitrary-suffix UTF-8 without storage/model effects", async t => {
	const f = await fixture(t), context = f.contexts.get("document-one")!;
	const before = files(f.root);
	const source = "ν = 3\nA local physics fact.\n";
	assert.deepEqual(await context.documents.toMarkdown(new File([source], "lesson.custom", { type: "application/octet-stream" })), {
		name: "lesson.custom", markdown: source, notices: [],
	});
	const pdf = new Uint8Array(tinyPdf([{ runs: [{ text: "Force equals mass times acceleration.", x: 72, y: 700 }] }]));
	const converted = await context.documents.toMarkdown(new File([pdf], "renamed.txt", { type: "text/plain" }));
	assert.equal(converted.name, "renamed.txt");
	assert.match(converted.markdown, /^--- Page 1 ---/);
	assert.match(converted.markdown, /Force equals mass times acceleration\./);
	assert.ok(converted.notices.some(notice => /extraction.*errors/.test(notice)));
	assert.deepEqual(files(f.root), before, "conversion creates neither uploads nor plugin/graph/provider records");
	assert.deepEqual(f.statuses, [200, 200]);
});

it("multipart frontend-to-host flow refuses corrupt PDF/binary/oversize output without successful DTOs", async t => {
	const f = await fixture(t), context = f.contexts.get("document-one")!;
	const before = files(f.root);
	await assert.rejects(context.documents.toMarkdown(new File(["Not a PDF."], "broken.PDF")), /Could not open this PDF/);
	await assert.rejects(context.documents.toMarkdown(new File([new Uint8Array([0xff, 0xfe, 0x00])], "binary.unknown")), /UTF-8/);
	await assert.rejects(context.documents.toMarkdown(new File(["é".repeat(1024 * 1024 + 1)], "large.any")), /Max 2 MiB/);
	assert.deepEqual(f.statuses, [400, 400, 413]);
	assert.deepEqual(files(f.root), before);
});

it("one shared host converter remains busy across plugins until a cancelled underlying parser settles", async t => {
	const parser = deferred<Awaited<ReturnType<typeof convertPdf>>>(), started = deferred<void>();
	let calls = 0, signal!: AbortSignal;
	const f = await fixture(t, async (_bytes, _maxPages, options) => {
		calls++; signal = options!.signal!; started.resolve(); return parser.promise;
	});
	const one = f.contexts.get("document-one")!, two = f.contexts.get("document-two")!;
	const caller = new AbortController();
	const rejected = assert.rejects(one.documents.toMarkdown(new File(["%PDF-fixture"], "pending.pdf"), { signal: caller.signal }), { name: "AbortError" });
	await started.promise; caller.abort();
	assert.equal(signal.aborted, true);
	await assert.rejects(two.documents.toMarkdown(new File(["An independent document."], "second.txt")), /busy.*retry/);
	assert.equal(calls, 1);
	parser.resolve({ kind: "converted", pages: [{ kind: "text", number: 1, markdown: "Late text" }] });
	await rejected;
	assert.deepEqual(await two.documents.toMarkdown(new File(["Retry text."], "second.txt")), { name: "second.txt", markdown: "Retry text.", notices: [] });
	assert.deepEqual(f.statuses, [409, 409, 200]);
});
