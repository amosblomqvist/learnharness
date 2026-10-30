/**
 * /api/study (docs/designs/study-time.md): app/api/study/route.ts against a
 * temp LH_DATA_DIR — body/query validation, status mapping, no-store.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-route-"));
process.env.LH_DATA_DIR = dir;
const { GET, POST } = await import("../app/api/study/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const post = (body: unknown, raw = false) =>
	POST(new Request("http://x/api/study", { method: "POST", body: raw ? (body as string) : JSON.stringify(body) }));
const get = (query: string) => GET(new Request(`http://x/api/study${query}`));

describe("POST /api/study", () => {
	it("400 invalid_body for bad JSON and bad input", async () => {
		for (const bad of [post("{nope", true), post({}), post({ input: { type: "pause" } }), post({ input: { type: "active", chatId: "a b", windowId: "w" } }), post(null)]) {
			const res = await bad;
			assert.equal(res.status, 400);
			assert.deepEqual(await res.json(), { error: "invalid_body" });
		}
	});

	it("maps StudyResult: 404 chat_not_found, 400 chat_not_started, 200 ok", async () => {
		const missing = await post({ input: { type: "active", chatId: "nope", windowId: "w" } });
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { error: "chat_not_found" });

		const chat = stores.chatStore.createChat("c");
		const unstarted = await post({ input: { type: "active", chatId: chat.id, windowId: "w" } });
		assert.equal(unstarted.status, 400);
		assert.deepEqual(await unstarted.json(), { error: "chat_not_started" });

		stores.chatStore.saveMessages(chat.id, [newUserMessage("hi")]);
		const ok = await post({ input: { type: "active", chatId: chat.id, windowId: "w" } });
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), { ok: true });

		const closeAll = await post({ input: { type: "closeAll" } });
		assert.equal(closeAll.status, 200);
	});
});

describe("GET /api/study", () => {
	it("400 invalid_tz and invalid_range", async () => {
		for (const q of ["?range=week", "?tz=Mars/Olympus&range=week", "?tz="]) {
			const res = await get(q);
			assert.equal(res.status, 400, q);
			assert.deepEqual(await res.json(), { error: "invalid_tz" });
		}
		for (const q of ["?tz=UTC", "?tz=UTC&range=year"]) {
			const res = await get(q);
			assert.equal(res.status, 400, q);
			assert.deepEqual(await res.json(), { error: "invalid_range" });
		}
	});

	it("200 with the summary and Cache-Control: no-store", async () => {
		const res = await get("?tz=UTC&range=month");
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("cache-control"), "no-store");
		const body = (await res.json()) as { cards: unknown; range: { key: string }; grid: { days: unknown[] }; idleMinutes: number };
		assert.equal(body.range.key, "month");
		assert.ok(Array.isArray(body.grid.days));
		assert.equal(body.idleMinutes, 5);
	});
});
