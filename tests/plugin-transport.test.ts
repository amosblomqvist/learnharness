import assert from "node:assert/strict";
import { it } from "node:test";
import { createPluginTransport, type PluginTransportHost } from "../src/server/plugin-transport.ts";
import { PluginHostError } from "../src/server/plugin-host.ts";

const request = (body: unknown) => new Request("http://localhost/api/plugins", { method: "POST", body: JSON.stringify(body) });
function fixture() {
	const calls: unknown[] = [];
	const host: PluginTransportHost = {
		list: () => [], refresh: async () => { calls.push("refresh"); },
		setEnabled: async (id, enabled) => { calls.push({ id, enabled }); },
		call: async (id, operation, input) => { calls.push({ id, operation, input }); return input; },
		convertDocument: async (id, request) => { calls.push({ id, request }); return { name: "fixture.txt", markdown: "Text", notices: [] }; },
		asset: () => ({ bytes: new TextEncoder().encode("export const value = 1;"), contentType: "text/javascript" }),
	};
	return { host, calls, transport: createPluginTransport({ getHost: async () => host, directory: "/temporary/plugins" }) };
}
it("plugin HTTP adapter preserves list, explicit toggles and JSON operation results", async () => {
	const { transport, calls } = fixture();
	assert.deepEqual(await (await transport.list()).json(), { plugins: [], directory: "/temporary/plugins" });
	assert.equal((await transport.setEnabled("example", request({ enabled: false }))).status, 200);
	assert.equal((await transport.refresh(request({ action: "refresh" }))).status, 200);
	const call = await transport.call("example", request({ operation: "snapshot", input: { id: 1 } }));
	assert.deepEqual(await call.json(), { result: { id: 1 } });
	assert.deepEqual(calls, [{ id: "example", enabled: false }, "refresh", { id: "example", operation: "snapshot", input: { id: 1 } }]);
});
it("plugin document transport forwards the untouched binary request and returns the exact uncached DTO", async () => {
	const { transport, calls, host } = fixture();
	const form = new FormData(); form.append("file", new File(["Text"], "fixture.txt"));
	const upload = new Request("http://localhost/api/plugins/example/documents/markdown", { method: "POST", body: form });
	host.convertDocument = async (id, request) => {
		calls.push({ id, request });
		assert.equal(request, upload); assert.equal(request.bodyUsed, false);
		const file = (await request.formData()).get("file"); assert.ok(file instanceof File);
		assert.equal(await file.text(), "Text");
		return { name: "fixture.txt", markdown: "Text", notices: ["Example notice"] };
	};
	const converted = await transport.convertDocument("example", upload);
	assert.deepEqual(await converted.json(), { name: "fixture.txt", markdown: "Text", notices: ["Example notice"] });
	assert.equal(converted.headers.get("Cache-Control"), "no-store");
	assert.equal(calls.length, 1);
	host.convertDocument = async () => { throw new PluginHostError(413, "Converted Markdown is too large. Max 2 MiB."); };
	const refused = await transport.convertDocument("example", upload);
	assert.equal(refused.status, 413);
	assert.deepEqual(await refused.json(), { error: "Converted Markdown is too large. Max 2 MiB." });
	host.convertDocument = async () => { throw new PluginHostError(409, "Document conversion is busy. Please retry."); };
	assert.equal((await transport.convertDocument("example", upload)).status, 409);
});
it("plugin HTTP adapter rejects malformed input before invoking a plugin", async () => {
	const { transport, calls } = fixture();
	for (const body of [null, [], true, {}, { enabled: "yes" }]) assert.equal((await transport.setEnabled("example", request(body))).status, 400);
	assert.equal((await transport.refresh(request({ action: "install" }))).status, 400);
	assert.equal((await transport.call("example", request({ operation: 1 }))).status, 400);
	assert.equal((await transport.call("example", new Request("http://localhost", { method: "POST", body: "not json" }))).status, 400);
	assert.deepEqual(calls, []);
});
it("plugin HTTP adapter exposes operational failures instead of treating them as input errors", async () => {
	const { host } = fixture();
	host.call = async () => { throw new Error("Plugin operation failed"); };
	const transport = createPluginTransport({ getHost: async () => host, directory: "/temporary/plugins" });
	const failed = await transport.call("example", request({ operation: "read" }));
	assert.equal(failed.status, 500);
	assert.deepEqual(await failed.json(), { error: "Plugin operation failed" });
	const broken = createPluginTransport({ getHost: async () => { throw new Error("Corrupt plugin state"); }, directory: "/temporary/plugins" });
	assert.equal((await broken.list()).status, 500);
});
it("plugin HTTP adapter preserves expected errors across Next module instances", async () => {
	const { host } = fixture();
	// A separately compiled host entry has a different constructor but the same
	// process-wide error brand. Numeric status alone is never trusted.
	const hostErrorBrand = Symbol.for("learnharness.plugin-host-error");
	class OtherModuleHostError extends Error {
		readonly [hostErrorBrand] = true;
		readonly status = 409;
	}
	host.call = async () => { throw new OtherModuleHostError("Plugin disabled"); };
	const transport = createPluginTransport({ getHost: async () => host, directory: "/temporary/plugins" });
	const refused = await transport.call("example", request({ operation: "read" }));
	assert.equal(refused.status, 409);
	assert.deepEqual(await refused.json(), { error: "Plugin disabled" });
	host.call = async () => { throw Object.assign(new Error("Unbranded plugin failure"), { status: 404 }); };
	assert.equal((await transport.call("example", request({ operation: "read" }))).status, 500);
});
it("plugin HTTP adapter uses typed host errors and keeps code assets uncached", async () => {
	const { transport, host } = fixture();
	const asset = await transport.asset("example", ["main.js"]);
	assert.equal(asset.status, 200);
	assert.equal(asset.headers.get("X-Content-Type-Options"), "nosniff");
	assert.equal(asset.headers.get("Cache-Control"), "no-store");
	assert.match(await asset.text(), /export const/);
	host.asset = () => { throw new PluginHostError(404, "Asset unavailable"); };
	assert.equal((await transport.asset("example", ["data", "private.json"])).status, 404);
});
