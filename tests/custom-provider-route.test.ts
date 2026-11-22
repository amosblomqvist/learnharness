/**
 * POST /api/custom-provider — the connect policy around manually typed model
 * ids. Two rules earn a route test (the pure pieces live in
 * custom-endpoint.test.ts):
 *   1. Typed ids make a FAILED probe survivable, but never a rejected key.
 *   2. A failed probe never shrinks the snapshot it already stored: that prune
 *      would take the model metadata and the user's pins with it.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { CustomProviderSettings } from "../src/core/settings.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-route-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
const SETTINGS_FILE = path.join(dir, "settings.json");

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
	delete process.env.LH_AUTH_FILE;
});

type Route = typeof import("../app/api/custom-provider/route.ts");
let route: Route;
before(async () => {
	route = await import("../app/api/custom-provider/route.ts");
});

const BASE = "http://h/v1";
/** A connected endpoint with two discovered models, a pin on each, one typed id.
 *  Written in the single-endpoint era's shape on purpose: every test below runs
 *  against the migrated record. */
const CONNECTED = {
	version: 1,
	customProvider: {
		baseUrl: BASE,
		authMode: "keyless",
		models: [{ id: "disc-1", context: 131072 }, { id: "disc-2" }],
		overrides: { "disc-1": { context: 200000 }, "disc-2": { maxTokens: 8192 } },
		manualModels: ["m1"],
	},
};

function seed(record: unknown): void {
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(record, null, "\t"), "utf-8");
}

function stored(): { customProviders?: CustomProviderSettings[] } {
	return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
}

/** The stored endpoints, as the file holds them. */
function endpoints(): CustomProviderSettings[] {
	return stored().customProviders ?? [];
}

async function storedIds(): Promise<string[]> {
	const body = (await route.GET(new Request("http://localhost/api/custom-provider")).json()) as { endpoints: { id: string }[] };
	return body.endpoints.map((e) => e.id);
}

async function revision(): Promise<string> {
	return route.GET(new Request("http://localhost/api/custom-provider")).headers.get("etag")!;
}

function answerWith(status: number, statusText: string, body?: unknown): void {
	globalThis.fetch = (async () => (body === undefined ? new Response("nope", { status, statusText }) : Response.json(body))) as typeof fetch;
}

/** Connect. `id` names the endpoint being reconnected; absent connects the
 *  first stored one, exactly as the settings editor does. `addNew` asks for a
 *  second endpoint instead. The id comes from the route's own projection, so a
 *  seeded single-endpoint record is seen as the `custom` endpoint it migrates to. */
async function post(payload: Record<string, unknown>, addNew = false): Promise<Response> {
	const stored = addNew ? [] : ((await route.GET(new Request("http://localhost/api/custom-provider")).json()) as { endpoints: { id: string }[] }).endpoints;
	const id = stored[0]?.id ?? "";
	return route.POST(
		new Request("http://localhost/api/custom-provider", {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://localhost", "if-match": route.GET(new Request("http://localhost/api/custom-provider")).headers.get("etag")! },
			body: JSON.stringify({ id, authMode: "key" in payload ? "apiKey" : "keyless", ...payload }),
		}),
	);
}

describe("POST /api/custom-provider — typed ids and a failed probe", () => {
	it("a transient failure keeps the stored models, their metadata, and their pins", async () => {
		seed(CONNECTED);
		answerWith(503, "Service Unavailable");

		const res = await post({ baseUrl: BASE, manualModels: "m1" });
		assert.equal(res.status, 200);

		const cp = endpoints()[0];
		assert.deepEqual(cp?.models?.map((m) => m.id), ["disc-1", "disc-2", "m1"]);
		assert.deepEqual(cp?.models?.[0], { id: "disc-1", context: 131072 }, "detected metadata survives");
		assert.deepEqual(cp?.overrides, CONNECTED.customProvider.overrides, "the prune must not fire on a failed probe");
		assert.deepEqual(cp?.manualModels, ["m1"]);
	});

	it("a rejected key fails the connect even when ids are typed", async () => {
		seed(CONNECTED);
		answerWith(401, "Unauthorized");
		const before = stored();

		const res = await post({ baseUrl: BASE, key: "sk-abcdefghijk", manualModels: "m1" });
		assert.equal(res.status, 502);
		assert.deepEqual(stored(), before, "nothing is stored on an auth failure");
	});

	it("a new URL with no model list starts from the typed ids alone", async () => {
		seed(CONNECTED);
		answerWith(404, "Not Found");

		const res = await post({ baseUrl: "http://other/v1", manualModels: "y, x" });
		assert.equal(res.status, 200);

		const cp = endpoints()[0];
		assert.deepEqual(cp?.models?.map((m) => m.id), ["x", "y"], "the previous endpoint's models do not follow the URL");
		assert.equal(cp?.overrides, undefined, "no pin survives a list the old pins do not belong to");
		assert.deepEqual(cp?.manualModels, ["y", "x"], "the typed order is kept as typed");
	});

	it("no model list and no typed ids still refuses, with the hint", async () => {
		answerWith(404, "Not Found");

		const res = await post({ baseUrl: BASE });
		assert.equal(res.status, 502);
		const body = (await res.json()) as { error: string };
		assert.match(body.error, /404/);
		assert.match(body.error, /add model IDs manually/);
	});

	it("reconnecting refreshes nested limits in storage and GET without replacing user pins", async () => {
		seed(CONNECTED);
		answerWith(200, "OK", { data: [
			{ id: "disc-1", reasoning: true, limit: { context: 1050000, input: 922000, output: 128000 } },
			{ id: "disc-2", limit: { context: 65536, output: 16384 } },
		] });
		const res = await post({ baseUrl: BASE, manualModels: "disc-1, m1" });
		assert.equal(res.status, 200);
		const models = [
			{ id: "disc-1", reasoning: true, context: 1050000, maxTokens: 128000 },
			{ id: "disc-2", context: 65536, maxTokens: 16384 },
			{ id: "m1" },
		];
		assert.deepEqual((await res.json()).models, models);
		const cp = endpoints()[0]!;
		assert.deepEqual(cp.models, models);
		assert.deepEqual(cp.overrides, CONNECTED.customProvider.overrides);
		const get = await route.GET(new Request("http://localhost/api/custom-provider")).json();
		assert.deepEqual(get.endpoints[0].models, models);
		assert.deepEqual(get.endpoints[0].overrides, CONNECTED.customProvider.overrides);
		// Build from the persisted snapshot: pins win per field, while the
		// unpinned fields use rediscovered values and manual-only ids stay at defaults.
		const { buildOpenAiCompatibleProvider } = await import("../src/server/custom-provider.ts");
		const registered = buildOpenAiCompatibleProvider({ id: cp.id, name: "Custom endpoint", baseUrl: BASE, models: cp.models!, overrides: cp.overrides }).getModels();
		assert.deepEqual(registered.map((model) => [model.id, model.contextWindow, model.maxTokens]), [
			["disc-1", 200000, 128000], ["disc-2", 65536, 8192], ["m1", 8192, 4096],
		]);
	});

	it("a working probe merges the typed ids and keeps discovered metadata", async () => {
		seed(CONNECTED);
		answerWith(200, "OK", { data: [{ id: "disc-1", context_length: 65536 }] });

		const res = await post({ baseUrl: BASE, manualModels: "disc-1, m2" });
		assert.equal(res.status, 200);

		const cp = endpoints()[0];
		assert.deepEqual(cp?.models?.map((m) => m.id), ["disc-1", "m2"]);
		assert.deepEqual(cp?.models?.[0], { id: "disc-1", context: 65536 }, "discovery is not replaced by a bare typed id");
		assert.deepEqual(cp?.overrides, { "disc-1": { context: 200000 } }, "pins follow the ids this connect offers");
		assert.deepEqual(cp?.manualModels, ["disc-1", "m2"]);
	});
});

describe("custom endpoints — more than one", () => {
	it("a second endpoint joins the record without touching the first", async () => {
		seed(CONNECTED);
		answerWith(200, "OK", { data: [{ id: "second-1" }] });

		const res = await post({ name: "Work gateway", baseUrl: "http://work/v1" }, true);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { id: string; name: string };
		assert.match(body.id, /^custom-[a-f0-9]{8}$/, "an added endpoint never takes the legacy id");
		assert.equal(body.name, "Work gateway");

		const list = endpoints();
		assert.equal(list.length, 2);
		assert.equal(list[0].id, "custom", "the migrated endpoint keeps its id");
		assert.deepEqual(list[0].models, CONNECTED.customProvider.models);
		assert.deepEqual(list[1].models, [{ id: "second-1" }]);
	});

	it("a name can be changed without re-probing the endpoint", async () => {
		seed(CONNECTED);
		const id = (await storedIds())[0];
		answerWith(200, "OK", { data: [{ id: "disc-1" }, { id: "disc-2" }] });

		const res = await post({ id, name: "Home server", baseUrl: BASE });
		assert.equal(res.status, 200);
		assert.equal((await res.json()).name, "Home server");
		assert.equal(endpoints()[0].name, "Home server");
		const get = await route.GET(new Request("http://localhost/api/custom-provider")).json();
		assert.equal(get.endpoints[0].name, "Home server");
		assert.equal(get.endpoints[0].id, id);
	});

	it("each endpoint keeps its own pins", async () => {
		seed(CONNECTED);
		answerWith(200, "OK", { data: [{ id: "second-1", context: 32000 }] });
		const added = (await (await post({ baseUrl: "http://work/v1" }, true)).json()) as { id: string };

		const res = await route.PATCH(new Request("http://localhost/api/custom-provider", {
			method: "PATCH",
			headers: { "content-type": "application/json", origin: "http://localhost", "if-match": await revision() },
			body: JSON.stringify({ id: added.id, overrides: { "second-1": { context: 128000 } } }),
		}));
		assert.equal(res.status, 200);

		const list = endpoints();
		assert.deepEqual(list[1].overrides, { "second-1": { context: 128000 } });
		assert.deepEqual(list[0].overrides, CONNECTED.customProvider.overrides, "the first endpoint's pins are untouched");
	});

	it("disconnecting one endpoint leaves the other connected", async () => {
		seed(CONNECTED);
		answerWith(200, "OK", { data: [{ id: "second-1" }] });
		const added = (await (await post({ baseUrl: "http://work/v1" }, true)).json()) as { id: string };

		const res = await route.DELETE(new Request("http://localhost/api/custom-provider", {
			method: "DELETE",
			headers: { "content-type": "application/json", origin: "http://localhost", "if-match": await revision() },
			body: JSON.stringify({ id: added.id }),
		}));
		assert.equal(res.status, 200);
		assert.deepEqual(await storedIds(), ["custom"]);

		const get = await route.GET(new Request("http://localhost/api/custom-provider")).json();
		assert.deepEqual(get.endpoints.map((e: { id: string }) => e.id), ["custom"]);
	});

	it("an unknown endpoint id is refused instead of silently added", async () => {
		seed(CONNECTED);
		const res = await post({ id: "custom-deadbeef", baseUrl: BASE });
		assert.equal(res.status, 409);
		assert.deepEqual(await storedIds(), ["custom"]);
	});

	it("a rename is saved without probing, even with the endpoint offline", async () => {
		seed(CONNECTED);
		let probes = 0;
		globalThis.fetch = (async () => { probes++; throw new Error("no probe expected"); }) as typeof fetch;

		const res = await post({ name: "Offline rename" });
		assert.equal(res.status, 200);
		assert.equal(probes, 0, "renaming never needs the server to answer");
		assert.equal(endpoints()[0].name, "Offline rename");
		assert.deepEqual(endpoints()[0].models, CONNECTED.customProvider.models, "models are untouched");
		assert.equal(endpoints()[0].baseUrl, BASE, "the address is untouched");

		const cleared = await post({ name: "" });
		assert.equal(cleared.status, 200);
		assert.equal(endpoints()[0].name, undefined, "an empty name falls back to the default");
	});

	it("a hand-edited id can never shadow a built-in provider", async () => {
		seed({
			version: 1,
			customProviders: [
				{ id: "openai", baseUrl: BASE, authMode: "keyless", models: [{ id: "x" }] },
				{ id: "custom", baseUrl: BASE, authMode: "keyless", models: [{ id: "y" }] },
			],
		});
		const get = await route.GET(new Request("http://localhost/api/custom-provider")).json();
		assert.deepEqual(get.endpoints.map((e: { id: string }) => e.id), ["custom"], "the invalid row is dropped");
	});
});
