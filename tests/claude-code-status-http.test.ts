import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCodeInstallationResponse as respond } from "../src/server/claude-code.ts";
const claudeCodeInstallationResponse: typeof respond = (request, inspect) => respond(request, inspect, () => true);

function request(headers: Record<string, string> = {}) {
	return new Request("http://localhost:3000/api/claude-code", { headers: { "x-learnharness-claude-code": "1", ...headers } });
}
const status = { state: "not-found" as const, version: null, minimumVersion: "2.1.259" };

for (const headers of [
	{ origin: "https://attacker.invalid" },
	{ "sec-fetch-site": "cross-site" },
	{ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
	{ origin: "null" },
	{ "x-learnharness-claude-code": "" },
] as Record<string, string>[]) test(`unsafe status request ${JSON.stringify(headers)} never invokes the probe`, async () => {
	let probes = 0;
	const response = await claudeCodeInstallationResponse(request(headers), async () => { probes++; return status; });
	assert.equal(response.status, 403); assert.equal(probes, 0);
	assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("disabled opt-in never starts even a version probe", async () => {
	let probes = 0;
	const response = await respond(request(), async () => { probes++; return status; }, () => false);
	assert.equal(response.status, 403); assert.equal(probes, 0);
});

test("ordinary image/subresource GET without intent header cannot start a probe", async () => {
	const response = await claudeCodeInstallationResponse(new Request("http://localhost:3000/api/claude-code"), async () => assert.fail("must not probe"));
	assert.equal(response.status, 403);
});

for (const headers of [{}, { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }] as Record<string, string>[]) test(`legitimate Providers GET ${JSON.stringify(headers)} is supported`, async () => {
	let probes = 0;
	const response = await claudeCodeInstallationResponse(request(headers), async () => { probes++; return status; });
	assert.equal(response.status, 200); assert.equal(probes, 1);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), status);
});

test("a forged forwarded origin cannot authorize a foreign Origin header", async () => {
	const response = await claudeCodeInstallationResponse(request({ origin: "https://attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "https" }), async () => assert.fail("must not probe"));
	assert.equal(response.status, 403);
});
