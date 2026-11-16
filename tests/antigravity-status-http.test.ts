import assert from "node:assert/strict";
import { test } from "node:test";
import { createAntigravityInstallerManager } from "../src/agent/antigravity/installation.ts";
import type { AntigravityStatus } from "../src/core/contracts/antigravity.ts";
import {
	antigravityInstallResponse as rawInstallRespond,
	antigravityStatusResponse as rawStatusRespond,
} from "../src/server/antigravity.ts";

const antigravityStatusResponse: typeof rawStatusRespond = (request, inspect) =>
	rawStatusRespond(request, inspect, () => true);

function statusReq(headers: Record<string, string> = {}, method = "GET") {
	return new Request("http://localhost:3000/api/antigravity", {
		method,
		headers: { "x-learnharness-antigravity": "1", ...headers },
	});
}

function installReq(method: "POST" | "DELETE" | "GET" = "POST", headers: Record<string, string> = {}) {
	return new Request("http://localhost:3000/api/antigravity/install", {
		method,
		headers: { "x-learnharness-antigravity": "1", ...headers },
	});
}

const sampleStatus: AntigravityStatus = {
	enabled: true,
	binaryPath: null,
	state: "not-installed",
	source: null,
	version: null,
	minimumCliVersion: "1.5.0",
	managedInstalled: false,
	busy: false,
	install: { phase: "idle" },
	auth: { signedIn: false, phase: "idle", attemptId: null, authUrl: null, error: null },
	error: null,
};

for (const headers of [
	{ origin: "https://attacker.invalid" },
	{ "sec-fetch-site": "cross-site" },
	{ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
	{ origin: "null" },
	{ "x-learnharness-antigravity": "" },
] as Record<string, string>[]) {
	test(`unsafe status request ${JSON.stringify(headers)} is rejected with 403 without probing`, async () => {
		let probes = 0;
		const response = await antigravityStatusResponse(statusReq(headers), async () => {
			probes++;
			return sampleStatus;
		});
		assert.equal(response.status, 403);
		assert.equal(probes, 0);
		assert.equal(response.headers.get("access-control-allow-origin"), null);
	});

	test(`unsafe install/remove request ${JSON.stringify(headers)} is rejected with 403`, async () => {
		let started = 0;
		const installer = createAntigravityInstallerManager({
			resolveRuntime: async () => ({ runtime: null, managedInstalled: false, updateRequiredVersion: null, error: null }),
			installManaged: async () => {
				started++;
			},
		});
		const res = await rawInstallRespond(installReq("POST", headers), {
			enabled: () => true,
			installer,
		});
		assert.equal(res.status, 403);
		assert.equal(started, 0);
	});
}

test("GET without x-learnharness-antigravity custom header is rejected with 403", async () => {
	const response = await antigravityStatusResponse(new Request("http://localhost:3000/api/antigravity"), async () =>
		assert.fail("must not probe"),
	);
	assert.equal(response.status, 403);
});

test("forged x-forwarded-host cannot authorize a foreign Origin header", async () => {
	const response = await antigravityStatusResponse(
		statusReq({
			origin: "https://attacker.invalid",
			"x-forwarded-host": "attacker.invalid",
			"x-forwarded-proto": "https",
		}),
		async () => assert.fail("must not probe"),
	);
	assert.equal(response.status, 403);
});

test("unsupported HTTP methods return 405", async () => {
	const s = await antigravityStatusResponse(statusReq({}, "POST"), async () => assert.fail("must not probe"));
	assert.equal(s.status, 405);

	const i = await rawInstallRespond(installReq("GET"), { enabled: () => true });
	assert.equal(i.status, 405);
});

for (const headers of [
	{},
	{ origin: "http://localhost:3000", "sec-fetch-site": "same-origin" },
] as Record<string, string>[]) {
	test(`same-origin status request ${JSON.stringify(headers)} returns status with no-store`, async () => {
		let probes = 0;
		const response = await antigravityStatusResponse(statusReq(headers), async () => {
			probes++;
			return sampleStatus;
		});
		assert.equal(response.status, 200);
		assert.equal(probes, 1);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.deepEqual(await response.json(), sampleStatus);
	});
}

test("POST /install starts background install (202), DELETE while busy returns 409, and DELETE after completion removes managed install (200)", async () => {
	let finishInstall!: () => void;
	let installed = false;
	let removedCalls = 0;

	const installer = createAntigravityInstallerManager({
		resolveRuntime: async () =>
			installed
				? {
						runtime: {
							source: "managed",
							kind: "acp-server",
							executablePath: "/data/agy_acp_server.par",
							harnessPath: "/data/localharness_external",
							args: ["--uid="],
							version: "1.4.5",
						},
						managedInstalled: true,
						updateRequiredVersion: null,
						error: null,
					}
				: {
						runtime: null,
						managedInstalled: false,
						updateRequiredVersion: null,
						error: null,
					},
		installManaged: async (onProgress) => {
			onProgress({ phase: "downloading", downloadedBytes: 100, totalBytes: 200 });
			await new Promise<void>((resolve) => {
				finishInstall = () => {
					installed = true;
					resolve();
				};
			});
		},
		removeManaged: () => {
			removedCalls++;
			const wasInstalled = installed;
			installed = false;
			return { removed: wasInstalled };
		},
	});

	const postRes = await rawInstallRespond(installReq("POST"), {
		enabled: () => true,
		binaryPath: () => undefined,
		installer,
	});
	assert.equal(postRes.status, 202);
	const postBody = (await postRes.json()) as AntigravityStatus;
	assert.equal(postBody.busy, true);
	assert.equal(postBody.install.phase, "downloading");

	const conflictRes = await rawInstallRespond(installReq("DELETE"), {
		enabled: () => true,
		binaryPath: () => undefined,
		installer,
	});
	assert.equal(conflictRes.status, 409);
	assert.equal(removedCalls, 0);

	finishInstall();
	await installer.waitForIdle();

	const deleteRes = await rawInstallRespond(installReq("DELETE"), {
		enabled: () => true,
		binaryPath: () => undefined,
		installer,
	});
	assert.equal(deleteRes.status, 200);
	const deleteBody = (await deleteRes.json()) as AntigravityStatus & { removed: boolean };
	assert.equal(deleteBody.removed, true);
	assert.equal(deleteBody.managedInstalled, false);
	assert.equal(removedCalls, 1);
});
