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
/** A connected endpoint with two discovered models, a pin on each, one typed id. */
const CONNECTED = {
	version: 1,
	customProviders: [{
		id: "custom",
		baseUrl: BASE,
		authMode: "keyless",
		models: [{ id: "disc-1", context: 131072 }, { id: "disc-2" }],
		overrides: { "disc-1": { context: 200000 }, "disc-2": { maxTokens: 8192 } },
		manualModels: ["m1"],
	}],
};

function seed(record: unknown): void {
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(record, null, "\t"), "utf-8");
}

function stored(): { customProviders?: { id?: string; label?: string; models?: { id: string }[]; overrides?: unknown; manualModels?: string[] }[] } {
	return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
}

function answerWith(status: number, statusText: string, body?: unknown): void {
	globalThis.fetch = (async () => (body === undefined ? new Response("nope", { status, statusText }) : Response.json(body))) as typeof fetch;
}

function postTo(id: string | null, payload: unknown): Promise<Response> {
	const authMode = payload && typeof payload === "object" && "key" in payload ? "apiKey" : "keyless";
	return route.POST(
		new Request("http://localhost/api/custom-provider", {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://localhost", "if-match": route.GET().headers.get("etag")! },
			body: JSON.stringify({ ...(id ? { id } : {}), authMode, ...payload as object }),
		}),
	);
}

function post(payload: unknown): Promise<Response> {
	return postTo("custom", payload);
}

describe("POST /api/custom-provider — typed ids and a failed probe", () => {
	it("a transient failure keeps the stored models, their metadata, and their pins", async () => {
		seed(CONNECTED);
		answerWith(503, "Service Unavailable");

		const res = await post({ baseUrl: BASE, manualModels: "m1" });
		assert.equal(res.status, 200);

		const cp = stored().customProviders?.[0];
		assert.deepEqual(cp?.models?.map((m) => m.id), ["disc-1", "disc-2", "m1"]);
		assert.deepEqual(cp?.models?.[0], { id: "disc-1", context: 131072 }, "detected metadata survives");
		assert.deepEqual(cp?.overrides, CONNECTED.customProviders[0]!.overrides, "the prune must not fire on a failed probe");
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

	it("a new endpoint with no model list starts from the typed ids alone", async () => {
		seed(CONNECTED);
		answerWith(404, "Not Found");

		const res = await post({ baseUrl: "http://other/v1", manualModels: "y, x" });
		assert.equal(res.status, 200);

		const cp = stored().customProviders?.[0];
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

	it("a working probe merges the typed ids and keeps discovered metadata", async () => {
		seed(CONNECTED);
		answerWith(200, "OK", { data: [{ id: "disc-1", context_length: 65536 }] });

		const res = await post({ baseUrl: BASE, manualModels: "disc-1, m2" });
		assert.equal(res.status, 200);

		const cp = stored().customProviders?.[0];
		assert.deepEqual(cp?.models?.map((m) => m.id), ["disc-1", "m2"]);
		assert.deepEqual(cp?.models?.[0], { id: "disc-1", context: 65536 }, "discovery is not replaced by a bare typed id");
		assert.deepEqual(cp?.overrides, { "disc-1": { context: 200000 } }, "pins follow the ids this connect offers");
		assert.deepEqual(cp?.manualModels, ["disc-1", "m2"]);
	});
});

describe("POST /api/custom-provider — creating another endpoint", () => {
	it("creates a second endpoint with a generated id and leaves the first untouched", async () => {
		seed(CONNECTED);
		answerWith(200, "OK", { data: [{ id: "s1" }, { id: "s2" }] });

		const res = await postTo(null, { label: "Local GPU", baseUrl: "http://local/v1", manualModels: "s3" });
		assert.equal(res.status, 200);

		const body = (await res.json()) as { provider: { id: string; label: string } };
		assert.match(body.provider.id, /^custom-[a-f0-9]{12}$/);
		assert.equal(body.provider.label, "Local GPU");

		const list = stored().customProviders ?? [];
		assert.equal(list.length, 2, "the legacy endpoint is kept");
		assert.deepEqual(list[0]?.id, "custom");
		assert.deepEqual(list[0]?.models?.map((m) => m.id), ["disc-1", "disc-2"]);
		assert.equal(list[1]?.id, body.provider.id);
		assert.equal(list[1]?.label, "Local GPU");
		assert.deepEqual(list[1]?.models?.map((m) => m.id), ["s1", "s2", "s3"]);
	});

	it("rejects an unknown id instead of silently creating it", async () => {
		seed(CONNECTED);
		const res = await postTo("custom-ffffffffffff", { baseUrl: "http://local/v1", manualModels: "s1" });
		assert.equal(res.status, 404);
		assert.equal(stored().customProviders?.length, 1);
	});

	it("rejects an explicitly blank name and caps a long one", async () => {
		seed(CONNECTED);
		answerWith(200, "OK", { data: [{ id: "s1" }] });
		const blank = await postTo(null, { label: "   ", baseUrl: "http://local/v1", manualModels: "s1" });
		assert.equal(blank.status, 400);
		const long = "x".repeat(80);
		const res = await postTo(null, { label: `  ${long}  `, baseUrl: "http://local/v1", manualModels: "s1" });
		assert.equal(res.status, 200);
		assert.equal(stored().customProviders?.at(-1)?.label, long.slice(0, 60));
	});
});
