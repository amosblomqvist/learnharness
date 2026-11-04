/**
 * POST /api/chats/:id/rewind (issue #321): the HTTP contract. The rewind
 * itself (graph, plan tree, jobs, steers, turn abort) is pinned in
 * tests/rewind.test.ts; this file pins what the route adds: 404 unknown
 * chat, 400 malformed body, the refusal envelope, and the success body.
 *
 * Runs under an isolated LH_DATA_DIR (the artifact-ui discipline: the seam
 * is set before any config-loading import, so every app-module import is
 * dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rewind-route-"));
process.env.LH_DATA_DIR = TMP_DATA;

type Post = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: Post;
let stores: typeof import("../src/server/stores.ts").stores;

before(async () => {
	POST = (await import("../app/api/chats/[id]/rewind/route.ts")).POST as Post;
	stores = (await import("../src/server/stores.ts")).stores;
});
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const user = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: 1 }) as LhMessage;
const assistant = (id: string, text: string): LhMessage => ({
	id, role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "faux", model: "faux",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 1,
}) as never;

describe("POST /api/chats/:id/rewind", () => {
	const post = (id: string, body: unknown) =>
		POST(new Request("http://x/api", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
	const seeded = () => {
		const chat = stores.chatStore.createChat("rewind route");
		stores.chatStore.saveMessages(chat.id, [user("u1", "teach me"), assistant("a1", "First lesson"), user("u2", "edit me"), assistant("a2", "Second lesson")]);
		return chat;
	};

	it("404s an unknown chat", async () => {
		assert.equal((await post("nope", { messageId: "u1" })).status, 404);
	});

	it("400s a body that is not JSON, not an object, or has no usable messageId (never a 500)", async () => {
		const chat = seeded();
		for (const bad of ["{not json", {}, { messageId: "" }, { messageId: 7 }, { messageId: null }]) {
			const res = await post(chat.id, bad);
			assert.equal(res.status, 400, JSON.stringify(bad));
			assert.ok(typeof ((await res.json()) as { error?: unknown }).error === "string");
		}
		assert.equal((await post(chat.id, "null")).status, 400, "a null body is a 400 too");
		assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 4, "a malformed request changes nothing");
	});

	it("refuses anything but the last user message with a 409 that names the right one", async () => {
		const chat = seeded();
		const res = await post(chat.id, { messageId: "u1" });
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), {
			error: "Only the last message you sent can be edited",
			code: "not_last_user_message",
			lastUserMessageId: "u2",
		});
		const unknown = await post(chat.id, { messageId: "nope" });
		assert.equal(unknown.status, 404);
		assert.equal(((await unknown.json()) as { code: string }).code, "message_not_found");
		assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 4);
	});

	it("200s with the removed text and rewinds the record to what came before", async () => {
		const chat = seeded();
		const res = await post(chat.id, { messageId: "u2" });
		assert.equal(res.status, 200);
		const body = (await res.json()) as Record<string, unknown>;
		assert.equal(body.ok, true);
		assert.equal(body.text, "edit me");
		assert.equal(body.removedMessages, 2);
		assert.equal(typeof body.graphRevision, "number");
		assert.deepEqual(stores.chatStore.getChat(chat.id)!.messages.map((m) => m.id), ["u1", "a1"], "1 2 — the edited message and its reply are gone");
		assert.equal("status" in body, false, "the HTTP status is not echoed into the body");
	});
});
