/**
 * EDITING A QUEUED STEER (issue #321): the input contract and the route.
 * PUT /api/chats/:id/steer edits or cancels (blank text) a composer steer
 * that pi has not drained yet. The queue mechanics themselves are pinned in
 * tests/jobs.test.ts (editLiveSteer); this file pins the parse contract and
 * the HTTP contract: 404 unknown chat, 400 malformed body, 409 when there
 * is nothing editable, 200 and the live queue actually changed.
 *
 * Runs under an isolated LH_DATA_DIR (the artifact-ui discipline: the seam
 * is set before any config-loading import, so every app-module import is
 * dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-steer-edit-"));
process.env.LH_DATA_DIR = TMP_DATA;

type Put = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let PUT: Put;
let parseUserSteerEditInput: typeof import("../src/core/input-events.ts").parseUserSteerEditInput;
let ChatInputError: typeof import("../src/core/input-events.ts").ChatInputError;
let createChat: (title: string) => { id: string };
let jobs: typeof import("../src/server/jobs.ts");

before(async () => {
	PUT = (await import("../app/api/chats/[id]/steer/route.ts")).PUT as Put;
	const input = await import("../src/core/input-events.ts");
	parseUserSteerEditInput = input.parseUserSteerEditInput;
	ChatInputError = input.ChatInputError;
	createChat = (await import("../src/server/chats.ts")).createChat;
	jobs = await import("../src/server/jobs.ts");
});

describe("parseUserSteerEditInput", () => {
	it("accepts an id and text, keeping the text verbatim", () => {
		assert.deepEqual(parseUserSteerEditInput({ type: "steer-edit", id: "steer_a", text: " hello " }), {
			type: "steer-edit",
			id: "steer_a",
			text: " hello ",
		});
	});

	it("accepts blank text — that is the cancel", () => {
		assert.equal(parseUserSteerEditInput({ type: "steer-edit", id: "steer_a", text: "" }).text, "");
	});

	it("rejects a non-object, a wrong type, a missing id and a non-string text", () => {
		for (const bad of [null, "x", { type: "steer", id: "a", text: "t" }, { type: "steer-edit", text: "t" },
			{ type: "steer-edit", id: "", text: "t" }, { type: "steer-edit", id: "a" }, { type: "steer-edit", id: "a", text: 1 }]) {
			assert.throws(() => parseUserSteerEditInput(bad), ChatInputError);
		}
	});
});

describe("PUT /api/chats/:id/steer", () => {
	const put = (id: string, body: unknown) =>
		PUT(new Request("http://x/api", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
	const edit = (id: string, text: string) => ({ input: { type: "steer-edit", id, text } });

	it("404s an unknown chat", async () => {
		assert.equal((await put("nope", edit("steer_a", "x"))).status, 404);
	});

	it("400s a malformed body", async () => {
		const chat = createChat("steer edit: 400");
		assert.equal((await put(chat.id, {})).status, 400);
		assert.equal((await put(chat.id, { input: { type: "steer", id: "a", text: "t" } })).status, 400);
		assert.equal((await put(chat.id, { input: { type: "steer-edit", id: "a" } })).status, 400);
	});

	it("400s a body that is not JSON at all (not a 500)", async () => {
		const chat = createChat("steer edit: not json");
		const res = await PUT(new Request("http://x/api", { method: "PUT", body: "{not json" }), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /json/i);
	});

	it("409s when there is no live turn", async () => {
		const chat = createChat("steer edit: idle");
		assert.equal((await put(chat.id, edit("steer_a", "x"))).status, 409);
	});

	it("409s when the steer is not in the queue (already drained)", async () => {
		const chat = createChat("steer edit: drained");
		const queue: { id: string; content: string }[] = [];
		jobs.registerLiveAgent(chat.id, {
			steer: (m: never) => queue.push(m),
			clearSteeringQueue: () => { queue.length = 0; },
			peekQueuedMessages: () => queue.slice(),
		} as never);
		assert.equal((await put(chat.id, edit("steer_gone", "x"))).status, 409);
		jobs.unregisterLiveAgent(chat.id);
	});

	it("200s and rewrites the queued steer; blank text removes it", async () => {
		const chat = createChat("steer edit: 200");
		const queue: { id: string; content: string }[] = [];
		jobs.registerLiveAgent(chat.id, {
			steer: (m: never) => queue.push(m),
			clearSteeringQueue: () => { queue.length = 0; },
			peekQueuedMessages: () => queue.slice(),
		} as never);
		assert.equal(jobs.steerLiveChat(chat.id, { id: "steer_q", role: "user", content: "before", timestamp: 1 } as never), true);

		const edited = await put(chat.id, edit("steer_q", "after"));
		assert.equal(edited.status, 200);
		assert.deepEqual(queue.map((m) => [m.id, m.content]), [["steer_q", "after"]]);

		const cancelled = await put(chat.id, edit("steer_q", "  "));
		assert.equal(cancelled.status, 200);
		assert.deepEqual(queue, []);
		jobs.unregisterLiveAgent(chat.id);
	});
});
