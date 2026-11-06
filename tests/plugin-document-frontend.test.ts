import assert from "node:assert/strict";
import { it } from "node:test";
import { PluginFrontendManager, type PluginHost } from "../components/plugin-manager.ts";
import type { PluginFrontendContext, PluginInfo } from "../src/core/plugins.ts";

const info: PluginInfo = { id: "document-fixture", enabled: true, status: "active", revision: "1", manifest: {
	apiVersion: 1, id: "document-fixture", name: "Documents", version: "1.0.0", minAppVersion: "0.4.1", main: "main.js",
} };
const result = { name: "lesson.csv", markdown: "subject,value\nphysics,3", notices: ["Fixture notice"] };
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}
async function fixture(fetch: PluginHost["fetch"]) {
	const contexts: PluginFrontendContext[] = [];
	const manager = new PluginFrontendManager({ fetch,
		importModule: async () => ({ activate(ctx) { contexts.push(ctx); } }), pathname: () => "/", navigate() {},
	});
	manager.reconcile([info]); await tick();
	assert.equal(contexts.length, 1);
	return { manager, contexts, context: contexts[0]! };
}

it("frontend documents uploads a real File as multipart, without JSON serialization or caller-supplied Content-Type", async t => {
	let requests = 0;
	const file = new File([result.markdown], result.name, { type: "application/octet-stream" });
	const f = await fixture(async (url, init) => {
		requests++;
		assert.equal(String(url), "/api/plugins/document-fixture/documents/markdown");
		assert.equal(init?.method, "POST");
		assert.equal(init.headers, undefined, "fetch must supply the multipart boundary");
		assert.ok(init.body instanceof FormData);
		assert.deepEqual([...init.body.keys()], ["file"]);
		const uploaded = init.body.get("file");
		assert.ok(uploaded instanceof File);
		assert.equal(uploaded.name, file.name);
		assert.equal(await uploaded.text(), result.markdown);
		assert.equal(init.signal?.aborted, false);
		return Response.json(result);
	});
	t.after(() => f.manager.dispose());
	assert.deepEqual(await f.context.documents.toMarkdown(file), result);
	assert.equal(requests, 1);
});

it("frontend documents rejects non-Files and pre-aborted calls without sending an upload", async t => {
	let requests = 0;
	const f = await fixture(async () => { requests++; return Response.json(result); });
	t.after(() => f.manager.dispose());
	for (const invalid of ["/private/lesson.txt", new Blob(["not a File"]), null]) {
		await assert.rejects(f.context.documents.toMarkdown(invalid as File), /File/);
	}
	const controller = new AbortController(); controller.abort();
	await assert.rejects(f.context.documents.toMarkdown(new File(["text"], "lesson.txt"), { signal: controller.signal }), { name: "AbortError" });
	const custom = new AbortController(); custom.abort("caller cancelled");
	await assert.rejects(f.context.documents.toMarkdown(new File(["text"], "lesson.txt"), { signal: custom.signal }), error => error === "caller cancelled");
	assert.equal(requests, 0);
});

it("frontend documents combines caller cancellation with owner lifetime and rejects an abort-ignoring late response", async t => {
	const response = deferred<Response>();
	let requestSignal!: AbortSignal;
	const f = await fixture(async (_url, init) => { requestSignal = init!.signal!; return response.promise; });
	t.after(() => f.manager.dispose());
	const caller = new AbortController();
	const converted = f.context.documents.toMarkdown(new File(["text"], "lesson.txt"), { signal: caller.signal });
	const rejected = assert.rejects(converted, { name: "AbortError" });
	assert.equal(requestSignal.aborted, false);
	caller.abort();
	assert.equal(requestSignal.aborted, true);
	assert.equal(f.context.signal.aborted, false, "canceling one conversion must not deactivate the plugin");
	response.resolve(Response.json(result));
	await rejected;
});

it("frontend documents fences the old generation after disable/re-enable even when fetch ignores abort", async t => {
	const response = deferred<Response>();
	let requests = 0, requestSignal!: AbortSignal;
	const f = await fixture(async (_url, init) => {
		requests++; requestSignal = init!.signal!;
		return requests === 1 ? response.promise : Response.json(result);
	});
	t.after(() => f.manager.dispose());
	const old = f.context;
	const rejected = assert.rejects(old.documents.toMarkdown(new File(["text"], "lesson.txt")), /no longer active/);
	f.manager.reconcile([{ ...info, enabled: false, status: "disabled" }]);
	assert.equal(requestSignal.aborted, true);
	f.manager.reconcile([info]); await tick();
	assert.equal(f.contexts.length, 2);
	response.resolve(Response.json(result)); await rejected;
	await assert.rejects(old.documents.toMarkdown(new File(["late"], "lesson.txt")), /no longer active/);
	assert.equal(requests, 1);
	assert.deepEqual(await f.contexts[1]!.documents.toMarkdown(new File(["current"], "lesson.txt")), result);
});

it("frontend documents propagates host busy/refusal errors, without inventing a result discriminant", async t => {
	const f = await fixture(async () => Response.json({ error: "Document conversion is busy. Please retry." }, { status: 409 }));
	t.after(() => f.manager.dispose());
	await assert.rejects(f.context.documents.toMarkdown(new File(["text"], "lesson.txt")), /busy.*retry/);
});

it("frontend documents rechecks caller lifetime after response JSON parsing, not only after fetch", async t => {
	const body = deferred<unknown>();
	const caller = new AbortController();
	const f = await fixture(async () => ({ ok: true, json: () => body.promise }) as Response);
	t.after(() => f.manager.dispose());
	const rejected = assert.rejects(f.context.documents.toMarkdown(new File(["text"], "lesson.txt"), { signal: caller.signal }), { name: "AbortError" });
	await tick(); caller.abort(); body.resolve(result); await rejected;
});
