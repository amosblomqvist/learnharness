/**
 * The renderer's Silero client: what it sends to /api/stt/vad and how it treats the
 * answers. fetch is a fake; the real model is in dictation-vad-runtime.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreVad } from "../components/dictation-vad.ts";
import { GROQ_DICTATION_HEADER } from "../src/core/dictation.ts";
import { decodePcm16Wav } from "../src/core/wav.ts";

const pcm = Int16Array.from({ length: 1500 }, (_, i) => i - 750);

function fake(answer: () => Response | Promise<Response>) {
	const seen: { url: string; init: RequestInit }[] = [];
	const request = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return answer(); }) as unknown as typeof fetch;
	return { seen, request };
}

describe("scoreVad", () => {
	it("posts the clip as a 16 kHz WAV to the VAD route with the dictation header, and returns the probabilities", async () => {
		const { seen, request } = fake(() => Response.json({ probs: [0.1, 0.9, 0.5] }));
		assert.deepEqual(await scoreVad(request, pcm, 16000), [0.1, 0.9, 0.5]);
		assert.equal(seen[0]!.url, "/api/stt/vad");
		assert.equal(seen[0]!.init.method, "POST");
		assert.deepEqual(seen[0]!.init.headers, { [GROQ_DICTATION_HEADER]: "1" });
		const audio = (seen[0]!.init.body as FormData).get("audio") as File;
		assert.equal(audio.type, "audio/wav");
		assert.deepEqual(decodePcm16Wav(new Uint8Array(await audio.arrayBuffer()), 16000), pcm);
	});

	it("rejects on a refusal, a server error, or an answer that is not probabilities", async () => {
		const rejects = (response: () => Response) => assert.rejects(scoreVad(fake(response).request, pcm, 16000));
		await rejects(() => Response.json({ message: "no", retryable: false }, { status: 403 }));
		await rejects(() => Response.json({ message: "engine", retryable: false }, { status: 503 }));
		await rejects(() => Response.json({}));
		await rejects(() => Response.json({ probs: ["x"] }));
		await rejects(() => new Response("<html>", { status: 502 }));
		await assert.rejects(scoreVad((async () => { throw new TypeError("offline"); }) as typeof fetch, pcm, 16000));
	});

	it("is aborted by the caller's signal, and by its own timeout", async () => {
		const stuck = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
		const controller = new AbortController();
		const pending = scoreVad(stuck as unknown as typeof fetch, pcm, 16000, controller.signal);
		controller.abort(new Error("cancelled"));
		await assert.rejects(pending, /cancelled/);
		const { seen, request } = fake(() => Response.json({ probs: [] }));
		await scoreVad(request, pcm, 16000);
		const signal = seen[0]!.init.signal!;
		assert.equal(signal.aborted, false);
		assert.ok(signal instanceof AbortSignal, "a timeout signal is always attached");
	});
});
