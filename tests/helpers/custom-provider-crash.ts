/** Child-process fixture: owned profile only; every upstream fetch is synthetic. */
import fs from "node:fs";
import { AUTH_FILE, SETTINGS_FILE } from "../../config.ts";
const [mode, action = "key", fault = "none"] = process.argv.slice(2);
const requests: { url: string; authorization: string | null }[] = [];
globalThis.fetch = async (url, init) => {
	requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
	if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "m" }] });
	return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
};
const rename = fs.renameSync;
const write = fs.writeFileSync;
const read = fs.readFileSync;
let authRenames = 0;
fs.renameSync = (...args: Parameters<typeof rename>) => {
	if (args[1] === AUTH_FILE) {
		authRenames++;
		if (fault === "auth-before-rename" || (fault === "double-io" && authRenames > 1)) throw new Error("fixture auth I/O failure");
		rename(...args);
		if (fault === "after-auth") process.exit(77);
		return;
	}
	return rename(...args);
};
fs.writeFileSync = (...args: Parameters<typeof write>) => {
	if (args[0] === SETTINGS_FILE && fault === "double-io") throw new Error("fixture settings I/O failure");
	if (args[0] === SETTINGS_FILE && fault === "settings-landed") { write(...args); throw new Error("fixture ambiguous settings completion"); }
	return write(...args);
};
fs.readFileSync = ((...args: Parameters<typeof read>) => {
	if (args[0] === AUTH_FILE && fault === "unreadable") throw Object.assign(new Error("fixture unreadable auth"), { code: "EACCES" });
	return read(...args);
}) as typeof read;
await import("../../src/server/keys.ts");
if (mode === "inspect") {
	const { piModels, piEngineForSpec } = await import("../../src/agent/models.ts");
	const { normalizeContext } = await import("@earendil-works/pi-ai");
	const enabled = Boolean(piModels().getProvider("custom"));
	let reason: string | undefined;
	try {
		const engine = piEngineForSpec({ provider: "custom", id: "m" });
		reason = (await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] }), {}).result()).stopReason;
	} catch { reason = "refused"; }
	const { keyStatuses } = await import("../../src/server/keys.ts");
	console.log(JSON.stringify({ enabled, reason, requests, statusIds: keyStatuses().map(row => row.id), metadataInEnv: process.env.__learnharness_custom_provider_binding !== undefined }));
} else {
	const route = await import("../../app/api/custom-provider/route.ts");
	const get = route.GET(new Request("http://localhost/api/custom-provider"));
	const payload = action === "keyless" ? { baseUrl: "http://second.invalid/v1", authMode: "keyless" }
		: action === "envMove" ? { baseUrl: "http://second.invalid/v1", authMode: "apiKey", reuseKey: true }
		: action === "reuse" ? { baseUrl: "http://first.invalid/v1", authMode: "apiKey", reuseKey: true }
		: { baseUrl: "http://second.invalid/v1", authMode: "apiKey", key: "fixture-new-key" };
	const request = new Request("http://localhost/api/custom-provider", { method: action === "disconnect" ? "DELETE" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", "if-match": get.headers.get("etag")! }, body: JSON.stringify(payload) });
	const result = await route.POST(request);
	console.log(JSON.stringify({ status: result.status, body: await result.json(), requests }));
}
