import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_MINIMUM_VERSION } from "../src/core/contracts/codex.ts";
import { codexInstallationResponse as respond, codexInstallationStatus } from "../src/server/codex.ts";
const codexInstallationResponse: typeof respond = (request, inspect) => respond(request, inspect, () => true);

function request(headers: Record<string, string> = {}) {
	return new Request("http://localhost:3000/api/codex", { headers: { "x-learnharness-external-cli": "1", ...headers } });
}
const status = { state: "not-found" as const, version: null, minimumVersion: CODEX_MINIMUM_VERSION };

for (const headers of [
	{ origin: "https://attacker.invalid" },
	{ "sec-fetch-site": "cross-site" },
	{ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
	{ origin: "null" },
	{ "x-learnharness-external-cli": "" },
] as Record<string, string>[]) test(`unsafe status request ${JSON.stringify(headers)} never invokes the probe`, async () => {
	let probes = 0;
	const response = await codexInstallationResponse(request(headers), async () => { probes++; return status; });
	assert.equal(response.status, 403); assert.equal(probes, 0);
	assert.equal(response.headers.get("access-control-allow-origin"), null);
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("disabled opt-in never starts even a version probe", async () => {
	let probes = 0;
	const response = await respond(request(), async () => { probes++; return status; }, () => false);
	assert.equal(response.status, 403); assert.equal(probes, 0);
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("ordinary image/subresource GET without intent header cannot start a probe", async () => {
	const response = await codexInstallationResponse(new Request("http://localhost:3000/api/codex"), async () => assert.fail("must not probe"));
	assert.equal(response.status, 403);
});

for (const headers of [{}, { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }] as Record<string, string>[]) test(`legitimate Providers GET ${JSON.stringify(headers)} is supported`, async () => {
	let probes = 0;
	const response = await codexInstallationResponse(request(headers), async () => { probes++; return status; });
	assert.equal(response.status, 200); assert.equal(probes, 1);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.deepEqual(await response.json(), status);
});

test("a forged forwarded origin cannot authorize a foreign Origin header", async () => {
	const response = await codexInstallationResponse(request({ origin: "https://attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "https" }), async () => assert.fail("must not probe"));
	assert.equal(response.status, 403);
});

test("production status reports not-found when discovery finds nothing", async () => {
	assert.deepEqual(await codexInstallationStatus(() => null), { state: "not-found", version: null, minimumVersion: CODEX_MINIMUM_VERSION });
});
