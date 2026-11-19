import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { it } from "node:test";
import { getCloneableBody } from "next/dist/server/body-streams.js";
import { NextRequest } from "next/server";
// Installed Next retains this name for its Proxy matcher test helper.
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { config, proxy } from "../proxy.ts";
import { createPluginDocumentConverter, MAX_DOCUMENT_BODY_BYTES } from "../src/server/plugin-documents.ts";
import { createPluginDocumentRoute, createPluginTransport } from "../src/server/plugin-transport.ts";

const origin = "http://localhost";
const documentPath = "/api/plugins/document-one/documents/markdown";
const result = { name: "small.txt", markdown: "small valid text 字", notices: [] as string[] };

/** Next's router tests the raw AND decoded pathname with OR semantics. */
function proxyMatches(path: string): boolean {
	const url = new URL(path, origin);
	const matches = (value: URL) => unstable_doesProxyMatch({ config, nextConfig: {}, url: value.href });
	if (matches(url)) return true;
	try { url.pathname = decodeURIComponent(url.pathname); } catch { /* Next ignores decode errors. */ }
	return matches(url);
}

it("Proxy excludes only the exact document endpoint, optional trailing slash and query, including encoded valid IDs", () => {
	for (const path of [
		documentPath, `${documentPath}/`, `${documentPath}?request=1`, `${documentPath}/?request=1`,
		"/api/plugins/document%2Done/documents/markdown", "/api/plugins/%64ocument-one/documents/markdown/",
	]) assert.equal(proxyMatches(path), false, path);
});

it("Proxy retains API roots, siblings, endpoint lookalikes and all other API routes", () => {
	for (const path of [
		"/api", "/api/", "/api?request=1", "/api/?request=1",
		"/api/plugins", "/api/plugins/document-one", "/api/plugins/document-one/call",
		"/api/plugins/document-one/documents", "/api/plugins/document-one/documents/other",
		`${documentPath}/extra`, `${documentPath}ish`, `${documentPath}.json`, `${documentPath}.rsc`,
		"/api/plugins/document-one/other/documents/markdown", "/api/plugins/documents/markdown",
		"/api/graph/import", "/api/events", "/api/chat", "/api/settings/models", "/api/chats/scratch/markdown",
	]) assert.equal(proxyMatches(path), true, path);
	for (const path of ["/", "/chat/new", "/apix", "/api-other/plugins/document-one/documents/markdown"]) {
		assert.equal(proxyMatches(path), false, path);
	}
});

/** Use installed Next's real clone/finalize implementation, not a mock of its
 * truncation. Holding a cloneable-body wrapper alone must leave the stream intact. */
async function uploadThroughNext(path: string, oversized: boolean, forceClone = proxyMatches(path), declaredLength?: string) {
	const form = new FormData();
	form.append("file", new File([result.markdown], result.name));
	const sample = new Request(new URL(path, origin), { method: "POST", body: form });
	const prefix = Buffer.from(await sample.arrayBuffer());
	const chunk = Buffer.alloc(64 * 1024, 32); // Legal MIME epilogue after a complete multipart form.
	const chunks: Buffer[] = oversized ? [prefix, ...Array<Buffer>(417).fill(chunk)] : [prefix];
	const actualBytes = chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0);
	const raw = Object.assign(Readable.from(chunks), { url: path }) as IncomingMessage;
	const holder = getCloneableBody(raw, MAX_DOCUMENT_BODY_BYTES);
	if (forceClone) {
		holder.cloneBodyStream().resume();
		await holder.finalize();
	}
	if (declaredLength !== undefined) sample.headers.set("content-length", declaredLength);
	const request = new Request(sample.url, {
		method: "POST", headers: sample.headers, body: raw, duplex: "half",
	} as unknown as RequestInit);
	return { request, cloned: forceClone, actualBytes };
}

it("installed Next forced-clone control demonstrates the previous oversized-epilogue acceptance", async t => {
	const warning = t.mock.method(console, "warn", () => {});
	const { request, actualBytes } = await uploadThroughNext(documentPath, true, true);
	assert.ok(actualBytes > MAX_DOCUMENT_BODY_BYTES);
	assert.equal(request.headers.has("content-length"), false);
	assert.deepEqual(await createPluginDocumentConverter().convert(request, new AbortController().signal), result);
	assert.equal(warning.mock.callCount(), 1, "Next warns and silently shortens rather than refusing the body");
});

for (const declaredLength of [undefined, "1"]) it(`current Proxy config preserves actual-byte rejection with ${declaredLength ? "lying" : "no"} Content-Length`, async t => {
	t.mock.method(console, "warn", () => {});
	const { request, actualBytes, cloned } = await uploadThroughNext(`${documentPath}/?request=1`, true, undefined, declaredLength);
	assert.ok(actualBytes > MAX_DOCUMENT_BODY_BYTES);
	assert.equal(request.headers.get("content-length"), declaredLength ?? null);
	await assert.rejects(createPluginDocumentConverter().convert(request, new AbortController().signal), (error: unknown) => {
		assert.equal((error as { status?: number }).status, 413);
		assert.match((error as Error).message, /26 MiB/);
		return true;
	});
	assert.equal(cloned, false, "the endpoint must bypass Proxy execution, not merely skip auth inside Proxy");
});

it("current Proxy config leaves a valid no-Content-Length multipart document convertible without cloning", async () => {
	const { request, cloned } = await uploadThroughNext(documentPath, false);
	assert.equal(request.headers.has("content-length"), false);
	assert.deepEqual(await createPluginDocumentConverter().convert(request, new AbortController().signal), result);
	assert.equal(cloned, false);
});

const methods = ["POST", "GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const secret = "a".repeat(64);
const capabilityHeader = "x-learnharness-desktop";
const forbidden = { error: "Desktop API access requires the trusted LearnHarness window." };

async function withDesktopEnvironment(marker: string | undefined, capability: string | undefined, run: () => Promise<void>) {
	const beforeMarker = process.env.LH_DESKTOP_SERVER, beforeCapability = process.env.LH_DESKTOP_API_SECRET;
	try {
		if (marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = marker;
		if (capability === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = capability;
		await run();
	} finally {
		if (beforeMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = beforeMarker;
		if (beforeCapability === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = beforeCapability;
	}
}

/** Fail immediately on body access and independently count any internal reads. */
function unreadableRequest(method: typeof methods[number], headers?: HeadersInit) {
	let reads = 0, bodyAccesses = 0;
	const body = new ReadableStream<Uint8Array>({
		pull() { reads++; throw new Error("This method must never read the upload"); },
	}, { highWaterMark: 0 });
	const request = new Request(new URL(documentPath, origin), {
		method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body, duplex: "half" }),
	} as RequestInit);
	Object.defineProperty(request, "body", { get() { bodyAccesses++; throw new Error("This method must never access the body"); } });
	return {
		request,
		assertUntouched() {
			assert.equal(bodyAccesses, 0, `${method}: body accessor`);
			assert.equal(reads, 0, `${method}: stream reads`);
			assert.equal(request.bodyUsed, false, `${method}: bodyUsed`);
		},
	};
}

it("document route authenticates ALL methods before params, transport/getHost, or any body access", async t => {
	const getHost = t.mock.fn(async () => { throw new Error("Authorization must precede host composition"); });
	const transport = createPluginTransport({ getHost, directory: "/unused-document-route-test" });
	const convert = t.mock.method(transport, "convertDocument");
	const route = createPluginDocumentRoute(transport);
	const refusals = [
		{ marker: "1", capability: secret, supplied: undefined },
		{ marker: "1", capability: secret, supplied: "" },
		{ marker: "1", capability: secret, supplied: "wrong" },
		{ marker: "1", capability: secret, supplied: `${secret}, ${secret}` },
		{ marker: "1", capability: undefined, supplied: secret },
		{ marker: "1", capability: "too-short", supplied: "too-short" },
		{ marker: undefined, capability: secret, supplied: undefined },
	];
	for (const { marker, capability, supplied } of refusals) await withDesktopEnvironment(marker, capability, async () => {
		for (const method of methods) {
			const headers: Record<string, string> = supplied === undefined ? {} : { [capabilityHeader]: supplied };
			const upload = unreadableRequest(method, headers);
			let paramsAccesses = 0;
			const context = { get params(): Promise<{ id: string }> { paramsAccesses++; throw new Error("Authorization must precede params"); } };
			const response = method === "POST" ? await route.POST(upload.request, context) : await route[method](upload.request);
			assert.equal(response.status, 403, method);
			assert.equal(response.headers.get("Cache-Control"), "no-store", method);
			assert.deepEqual(await response.json(), forbidden, method);
			const proxyRefusal = proxy(new NextRequest(new URL("/api/settings", origin), { method, headers }));
			assert.equal(response.status, proxyRefusal.status, `${method}: same existing Proxy policy`);
			assert.deepEqual(await proxyRefusal.json(), forbidden, method);
			assert.equal(paramsAccesses, 0, method);
			upload.assertUntouched();
		}
	});
	assert.equal(convert.mock.callCount(), 0, "no resource operation before authority");
	assert.equal(getHost.mock.callCount(), 0, "no root composition before authority");
});

it("authorized document route methods preserve POST dispatch, empty 405s and OPTIONS 204 with Allow", async t => {
	for (const mode of ["desktop", "browser-only", "secret-without-marker"] as const) {
		await withDesktopEnvironment(mode === "desktop" ? "1" : undefined, mode === "browser-only" ? undefined : secret, async () => {
			const headers: Record<string, string> = mode === "browser-only" ? {} : { [capabilityHeader]: secret };
			const forwarded = Response.json(result, { headers: { "Cache-Control": "no-store" } });
			const convert = t.mock.fn(async (id: string, request: Request) => {
				assert.equal(id, "document-one");
				assert.equal(request, post);
				return forwarded;
			});
			const route = createPluginDocumentRoute({ convertDocument: convert });
			for (const method of methods) {
				if (method === "POST") continue;
				const upload = unreadableRequest(method, headers);
				const response = await route[method](upload.request);
				assert.equal(response.status, method === "OPTIONS" ? 204 : 405, `${mode}: ${method}`);
				if (method === "OPTIONS") assert.equal(response.headers.get("Allow"), "OPTIONS, POST");
				assert.equal(await response.text(), "", `${mode}: ${method}`);
				upload.assertUntouched();
			}
			assert.equal(convert.mock.callCount(), 0, "non-POST methods do not dispatch conversion");
			const form = new FormData(); form.append("file", new File([result.markdown], result.name));
			const post = new Request(new URL(documentPath, origin), { method: "POST", headers, body: form });
			assert.equal(await route.POST(post, { params: Promise.resolve({ id: "document-one" }) }), forwarded);
			assert.equal(convert.mock.callCount(), 1);
			assert.equal(post.bodyUsed, false, "route forwards the original request untouched");
		});
	}
});
