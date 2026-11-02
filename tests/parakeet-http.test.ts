import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createParakeetHandlers } from "../src/server/parakeet-http.ts";
import type { ParakeetModelStatus } from "../src/server/parakeet-model.ts";
import { ParakeetNotReadyError } from "../src/server/parakeet-transcriber.ts";

function setup(initial: ParakeetModelStatus = { state: "missing" }) {
	let status = initial;
	const calls: string[] = [];
	const model = {
		status: () => status,
		download: () => { calls.push("download"); status = { state: "downloading", receivedBytes: 0, totalBytes: 10 }; return Promise.resolve(); },
		remove: async () => { calls.push("remove"); status = { state: "missing" }; },
	};
	let transcribe: (pcm: Uint8Array) => Promise<string> = async () => "hola mundo";
	const transcriber = { transcribe: (pcm: Uint8Array) => { calls.push("transcribe"); return transcribe(pcm); } };
	const handlers = createParakeetHandlers({ model, transcriber, maxAudioBytes: 8 });
	return { handlers, calls, setTranscribe: (fn: typeof transcribe) => { transcribe = fn; } };
}
const post = (body: BodyInit | null = null, headers: Record<string, string> = {}) =>
	new Request("http://127.0.0.1/api/stt/parakeet", { method: "POST", body, headers });

describe("Parakeet HTTP handlers", () => {
	it("reports the model status without caching", async () => {
		const { handlers } = setup({ state: "ready", diskBytes: 5 });
		const res = await handlers.status();
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("cache-control"), "no-store");
		assert.deepEqual(await res.json(), { state: "ready", diskBytes: 5 });
	});

	it("starts a download and answers 202 with the downloading status", async () => {
		const { handlers, calls } = setup();
		const res = await handlers.startDownload(post());
		assert.equal(res.status, 202);
		assert.equal(((await res.json()) as ParakeetModelStatus).state, "downloading");
		assert.deepEqual(calls, ["download"]);
	});

	it("does not crash or hang the request when the background download later fails", async () => {
		const { handlers } = setup();
		const failing = createParakeetHandlers({
			model: { status: () => ({ state: "missing" }), download: () => Promise.reject(new Error("boom")), remove: async () => {} },
			transcriber: { transcribe: async () => "" },
			maxAudioBytes: 8,
		});
		const res = await failing.startDownload(post());
		assert.equal(res.status, 202);
		await new Promise((r) => setTimeout(r, 10)); // an unhandled rejection would fail the run
		assert.ok(handlers);
	});

	it("removes the model (cancelling a download) and answers with the new status", async () => {
		const { handlers, calls } = setup({ state: "ready", diskBytes: 5 });
		const res = await handlers.remove(new Request("http://127.0.0.1/api/stt/parakeet", { method: "DELETE" }));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { state: "missing" });
		assert.deepEqual(calls, ["remove"]);
	});

	it("refuses cross-site requests that change state", async () => {
		const { handlers, calls } = setup();
		const cross = { "sec-fetch-site": "cross-site" };
		assert.equal((await handlers.startDownload(post(null, cross))).status, 403);
		assert.equal((await handlers.remove(new Request("http://127.0.0.1/x", { method: "DELETE", headers: cross }))).status, 403);
		assert.equal((await handlers.transcribe(post(new Uint8Array(4), cross))).status, 403);
		assert.deepEqual(calls, []);
		assert.equal((await handlers.startDownload(post(null, { "sec-fetch-site": "same-origin" }))).status, 202);
	});

	it("transcribes the posted PCM and returns the text", async () => {
		const { handlers, setTranscribe } = setup({ state: "ready", diskBytes: 5 });
		let seen = 0;
		setTranscribe(async (pcm) => { seen = pcm.byteLength; return "hola mundo"; });
		const res = await handlers.transcribe(post(new Uint8Array(4)));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { text: "hola mundo" });
		assert.equal(seen, 4);
	});

	it("answers 409 not-ready when the model is not installed", async () => {
		const { handlers, setTranscribe } = setup();
		setTranscribe(async () => { throw new ParakeetNotReadyError(); });
		const res = await handlers.transcribe(post(new Uint8Array(4)));
		assert.equal(res.status, 409);
		assert.equal(((await res.json()) as { code: string }).code, "not-ready");
	});

	it("rejects audio over the limit with 413 before transcribing", async () => {
		const { handlers, calls } = setup({ state: "ready", diskBytes: 5 });
		const res = await handlers.transcribe(post(new Uint8Array(9)));
		assert.equal(res.status, 413);
		assert.deepEqual(calls, []);
	});

	it("rejects a malformed body with 400 and reports transcriber failures as 500", async () => {
		const { handlers, setTranscribe } = setup({ state: "ready", diskBytes: 5 });
		setTranscribe(async () => { throw new RangeError("Audio must be 16-bit PCM samples"); });
		assert.equal((await handlers.transcribe(post(new Uint8Array(3)))).status, 400);
		setTranscribe(async () => { throw new Error("decode exploded"); });
		const res = await handlers.transcribe(post(new Uint8Array(4)));
		assert.equal(res.status, 500);
		assert.match(((await res.json()) as { message: string }).message, /decode exploded/);
	});

	it("stops reading a chunked body as soon as the limit is crossed, with no Content-Length", async () => {
		const { handlers, calls } = setup({ state: "ready", diskBytes: 5 });
		let pulled = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulled === 8) controller.close();
				else { pulled++; controller.enqueue(new Uint8Array(4)); }
			},
			cancel() { cancelled = true; },
		});
		const res = await handlers.transcribe(new Request("http://127.0.0.1/x", { method: "POST", body, duplex: "half" } as RequestInit));
		assert.equal(res.status, 413);
		assert.deepEqual(await res.json(), { message: "Recording is too long to transcribe" });
		assert.ok(pulled <= 4, `read ${pulled} of 8 chunks`);
		assert.equal(cancelled, true);
		assert.deepEqual(calls, []);
	});

	it("counts the bytes it actually reads when Content-Length understates the body", async () => {
		const { handlers, calls } = setup({ state: "ready", diskBytes: 5 });
		const res = await handlers.transcribe(post(new Uint8Array(9), { "content-length": "4" }));
		assert.equal(res.status, 413);
		assert.deepEqual(calls, []);
	});

	it("answers 400 with a message when the body read is interrupted", async () => {
		const { handlers, calls } = setup({ state: "ready", diskBytes: 5 });
		const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("socket closed mid-body")); } });
		const res = await handlers.transcribe(new Request("http://127.0.0.1/x", { method: "POST", body, duplex: "half" } as RequestInit));
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { message: "Could not read the recording" });
		assert.deepEqual(calls, []);
	});

	it("accepts a body of exactly the limit and an empty body path unchanged", async () => {
		const { handlers, setTranscribe } = setup({ state: "ready", diskBytes: 5 });
		let seen = -1;
		setTranscribe(async (pcm) => { seen = pcm.byteLength; return "ok"; });
		assert.equal((await handlers.transcribe(post(new Uint8Array(8)))).status, 200);
		assert.equal(seen, 8);
	});
});
