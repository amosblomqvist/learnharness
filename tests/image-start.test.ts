import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelCannotReadImages, modelKeyOf, startFirstMessage } from "../components/start-image-session.ts";
import { startDraftSession } from "../components/new-session.tsx";
import { wireImages, type DraftImage, type ModelCatalogResponse } from "../src/core/index.ts";

const img: DraftImage = { id: "img_client", type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" };

interface Call { url: string; body: any }
function server(script: Array<(call: Call) => Response>) {
	const calls: Call[] = [];
	const fetchLike = (async (url: string, init?: RequestInit) => {
		const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
		calls.push(call);
		return script[calls.length - 1]!(call);
	}) as typeof fetch;
	return { calls, fetchLike };
}
const created = (id = "c_1") => () => Response.json({ id });
const sse = () => new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
const refusal = () => Response.json({ error: "Model X cannot read images.", code: "model_cannot_read_images" }, { status: 422 });

const cat = (id: string, thinkingLevel: string) =>
	({ models: [], defaults: null, slots: { strong: { model: { provider: "p", id }, thinkingLevel } } }) as unknown as ModelCatalogResponse;

describe("startFirstMessage (image first messages)", () => {
	it("creates the chat, POSTs the normal turn with native images, awaits the ACK, then returns the plain URL", async () => {
		const s = server([created(), sse]);
		const r = await startFirstMessage({ createBody: { title: "t" }, text: "look", images: [img], fetchLike: s.fetchLike });
		assert.deepEqual(r, { ok: true, chatId: "c_1", target: "/chat/c_1" });
		assert.deepEqual(s.calls.map((c) => c.url), ["/api/chats", "/api/chat"]);
		assert.deepEqual(s.calls[1]!.body, { chatId: "c_1", input: { type: "text", text: "look", images: wireImages([img]) } });
		assert.ok(!("id" in (s.calls[1]!.body.input.images[0] as object)), "the client id never crosses the wire");
		assert.ok(!r.ok || !JSON.stringify(r).includes(img.data), "no image bytes in the navigation target");
	});

	it("image-only is allowed (empty text)", async () => {
		const s = server([created(), sse]);
		const r = await startFirstMessage({ createBody: { title: "Pasted image" }, text: "", images: [img], fetchLike: s.fetchLike });
		assert.equal(r.ok, true);
		assert.equal(s.calls[1]!.body.input.text, "");
	});

	it("a refused turn (422) returns the vision error, does not navigate, and keeps the chat id for a retry", async () => {
		const s = server([created("c_9"), refusal]);
		const r = await startFirstMessage({ createBody: { title: "t" }, text: "x", images: [img], fetchLike: s.fetchLike });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.error, "Model X cannot read images.");
		assert.deepEqual(r.reuse, { key: JSON.stringify({ createBody: { title: "t" }, modelKey: null }), chatId: "c_9" });
		// retry reuses the fresh chat: no second create
		const s2 = server([sse]);
		const again = await startFirstMessage({ createBody: { title: "t" }, text: "x", images: [img], fetchLike: s2.fetchLike, reuse: r.reuse });
		assert.equal(again.ok, true);
		assert.deepEqual(s2.calls.map((c) => c.url), ["/api/chat"]);
		// a changed create body does not reuse
		const s3 = server([created("c_10"), sse]);
		await startFirstMessage({ createBody: { title: "other" }, text: "x", images: [img], fetchLike: s3.fetchLike, reuse: r.reuse });
		assert.equal(s3.calls[0]!.url, "/api/chats");
	});

	it("create failures (non-ok, missing id) fail cleanly and never POST a turn", async () => {
		const bad = server([() => Response.json({ error: "no" }, { status: 500 })]);
		assert.equal((await startFirstMessage({ createBody: {}, text: "x", images: [img], fetchLike: bad.fetchLike })).ok, false);
		const noId = server([() => Response.json({})]);
		assert.equal((await startFirstMessage({ createBody: {}, text: "x", images: [img], fetchLike: noId.fetchLike })).ok, false);
		assert.equal(bad.calls.length + noId.calls.length, 2);
	});

	it("a network failure on the turn POST fails without reuse", async () => {
		const s = server([created(), () => { throw new Error("offline"); }]);
		const r = await startFirstMessage({ createBody: {}, text: "x", images: [img], fetchLike: s.fetchLike });
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.reuse, undefined, "uncertain persist: no reuse");
	});

	it("text-only keeps the ?prompt= handoff and posts no turn", async () => {
		const s = server([created("c_t")]);
		const r = await startFirstMessage({ createBody: {}, text: "a b", images: [], fetchLike: s.fetchLike });
		assert.deepEqual(r, { ok: true, chatId: "c_t", target: "/chat/c_t?prompt=a%20b" });
		assert.equal(s.calls.length, 1);
	});
});

describe("retry reuse rules", () => {
	const args = (fetchLike: typeof fetch, over: object = {}) => ({ createBody: { title: "t" }, text: "x", images: [img], fetchLike, ...over });
	it("a changed model (strong pin / thinking level) creates a new chat", async () => {
		const first = server([created("c_a"), refusal]);
		const r = await startFirstMessage(args(first.fetchLike, { modelKey: modelKeyOf(cat("m1", "high")) }));
		assert.equal(r.ok, false);
		if (r.ok) return;
		const same = server([sse]);
		await startFirstMessage(args(same.fetchLike, { modelKey: modelKeyOf(cat("m1", "high")), reuse: r.reuse }));
		assert.deepEqual(same.calls.map((c) => c.url), ["/api/chat"]);
		for (const other of [cat("m2", "high"), cat("m1", "low")]) {
			const s = server([created("c_b"), sse]);
			await startFirstMessage(args(s.fetchLike, { modelKey: modelKeyOf(other), reuse: r.reuse }));
			assert.equal(s.calls[0]!.url, "/api/chats");
		}
	});
	it("reuse only after known pre-persist refusals (400/413/422/503); never after network, 409 or 5xx", async () => {
		for (const [status, reusable] of [[400, true], [413, true], [422, true], [503, true], [409, false], [500, false], [502, false]] as const) {
			const s = server([created(), () => Response.json({ error: "no" }, { status })]);
			const r = await startFirstMessage(args(s.fetchLike));
			assert.equal(!r.ok && Boolean(r.reuse), reusable, String(status));
		}
		const net = server([created(), () => { throw new Error("offline"); }]);
		const r = await startFirstMessage(args(net.fetchLike));
		assert.equal(!r.ok && r.reuse, undefined);
	});
});

describe("startDraftSession with images", () => {
	it("returns the plain /chat/<id> (images are NOT in the query) after the ACK", async () => {
		const s = server([created("c_n"), sse]);
		const target = await startDraftSession("see", s.fetchLike, undefined, undefined, [img]);
		assert.equal(target, "/chat/c_n");
	});

	it("a refusal throws with the message and returns no target", async () => {
		const s = server([created("c_r"), refusal]);
		await assert.rejects(() => startDraftSession("see", s.fetchLike, undefined, undefined, [img]), { message: "Model X cannot read images." });
	});

	it("image-only titles the session 'Pasted image'", async () => {
		const s = server([created(), sse]);
		await startDraftSession("", s.fetchLike, undefined, undefined, [img]);
		assert.deepEqual(s.calls[0]!.body, { title: "Pasted image" });
	});
});

describe("modelCannotReadImages (pre-create guard)", () => {
	const catalog = (input: ("text" | "image")[]) =>
		({
			models: [{ id: "m", name: "Model M", provider: "p", input }],
			defaults: null,
			slots: { strong: { model: { provider: "p", id: "m" } } },
		}) as unknown as ModelCatalogResponse;
	it("refuses a known text-only model; passes vision and unknown models", () => {
		assert.match(modelCannotReadImages(catalog(["text"]))!, /Model M cannot read images/);
		assert.equal(modelCannotReadImages(catalog(["text", "image"])), null);
		assert.equal(modelCannotReadImages(undefined), null);
	});
});
