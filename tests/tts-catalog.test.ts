/**
 * The voices and models routes (ElevenLabs voice slice 9), with a fake
 * upstream fetch (no network):
 *   - voices: every page followed until has_more is false (page_size=100),
 *     cloned voices included, mapped to { id, name, category }
 *   - models: only can_do_text_to_speech, mapped to { id, name, maxChars },
 *     cached for TTS_MODELS_CACHE_MS
 *   - keyless 503 / upstream 502 for both, key never in a body
 *   - speak() plays the resolved model: listed model honoured, an unlisted one
 *     falls back, an unavailable list trusts the request
 * Throwaway key strings only.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { TTS_MODELS_CACHE_MS, clearTtsModelsCache, listTtsModels, listTtsVoices, speak } from "../src/server/tts.ts";

const KEY = `${"k".repeat(36)}wxyz`; // throwaway
const getKey = (id: string) => (id === "ELEVENLABS_API_KEY" ? KEY : undefined);
const noKey = () => undefined;

interface Call {
	url: string;
	init: RequestInit;
}

/** A fake fetch answering by URL; records every call. */
function fake(answer: (url: URL, call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetchFn = async (url: string, init: RequestInit) => {
		const call = { url, init };
		calls.push(call);
		return answer(new URL(url), call);
	};
	return { calls, fetchFn };
}

beforeEach(() => clearTtsModelsCache());

describe("GET voices", () => {
	const voice = (n: number, category = "premade") => ({ voice_id: `v${n}`, name: `Voice ${n}`, category, labels: { x: "y" } });

	it("follows next_page_token until has_more is false and maps id, name, category", async () => {
		const { calls, fetchFn } = fake((url) => {
			const token = url.searchParams.get("next_page_token");
			if (token === null) return Response.json({ voices: [voice(1), voice(2, "cloned")], has_more: true, next_page_token: "t2" });
			if (token === "t2") return Response.json({ voices: [voice(3, "professional")], has_more: true, next_page_token: "t3" });
			return Response.json({ voices: [voice(4)], has_more: false, next_page_token: null });
		});
		const res = await listTtsVoices({ fetchFn, getKey });
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), [
			{ id: "v1", name: "Voice 1", category: "premade" },
			{ id: "v2", name: "Voice 2", category: "cloned" },
			{ id: "v3", name: "Voice 3", category: "professional" },
			{ id: "v4", name: "Voice 4", category: "premade" },
		]);
		assert.equal(calls.length, 3);
		for (const call of calls) {
			const url = new URL(call.url);
			assert.equal(`${url.origin}${url.pathname}`, "https://api.elevenlabs.io/v2/voices");
			assert.equal(url.searchParams.get("page_size"), "100");
			assert.equal(new Headers(call.init.headers).get("xi-api-key"), KEY);
		}
		assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get("next_page_token")), [null, "t2", "t3"]);
	});

	it("a single page makes a single call", async () => {
		const { calls, fetchFn } = fake(() => Response.json({ voices: [voice(1)], has_more: false }));
		assert.equal(((await (await listTtsVoices({ fetchFn, getKey })).json()) as unknown[]).length, 1);
		assert.equal(calls.length, 1);
	});

	it("a token that never advances does not loop forever", async () => {
		const { calls, fetchFn } = fake(() => Response.json({ voices: [voice(1)], has_more: true, next_page_token: "same" }));
		const res = await listTtsVoices({ fetchFn, getKey });
		assert.equal(res.status, 200);
		assert(calls.length <= 2);
	});

	it("is 503 keyless without calling upstream", async () => {
		const { calls, fetchFn } = fake(() => Response.json({}));
		const res = await listTtsVoices({ fetchFn, getKey: noKey });
		assert.equal(res.status, 503);
		const body = (await res.json()) as { message: string; keyless: string };
		assert.equal(body.keyless, "ELEVENLABS_API_KEY");
		assert.equal(typeof body.message, "string");
		assert.equal(calls.length, 0);
	});

	it("is 502 with ElevenLabs' status when a page fails, and never leaks the key", async () => {
		const { fetchFn } = fake((url) =>
			url.searchParams.get("next_page_token") === null
				? Response.json({ voices: [voice(1)], has_more: true, next_page_token: "t2" })
				: Response.json({ detail: { status: "missing_permissions", message: `needs voices_read for ${KEY}` } }, { status: 401 }),
		);
		const res = await listTtsVoices({ fetchFn, getKey });
		assert.equal(res.status, 502);
		const text = await res.text();
		assert.equal(text.includes(KEY), false);
		const body = JSON.parse(text) as { message: string; upstreamStatus: number };
		assert.equal(body.upstreamStatus, 401);
		assert(body.message.includes("401"));
	});

	it("is 502 when the upstream is unreachable", async () => {
		const fetchFn = async () => {
			throw new Error(`connect failed for ${KEY}`);
		};
		const res = await listTtsVoices({ fetchFn, getKey });
		assert.equal(res.status, 502);
		assert.equal((await res.text()).includes(KEY), false);
	});
});

describe("GET models", () => {
	const models = [
		{ model_id: "eleven_v4_turbo", name: "Eleven v4 Turbo", can_do_text_to_speech: true, maximum_text_length_per_request: 10000 },
		{ model_id: "eleven_english_sts_v2", name: "STS", can_do_text_to_speech: false, maximum_text_length_per_request: 5000 },
		{ model_id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", can_do_text_to_speech: true, maximum_text_length_per_request: 40000 },
	];

	it("returns only text-to-speech models as { id, name, maxChars }", async () => {
		const { calls, fetchFn } = fake(() => Response.json(models));
		const res = await listTtsModels({ fetchFn, getKey });
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), [
			{ id: "eleven_v4_turbo", name: "Eleven v4 Turbo", maxChars: 10000 },
			{ id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", maxChars: 40000 },
		]);
		assert.equal(calls[0]!.url, "https://api.elevenlabs.io/v1/models");
		assert.equal(new Headers(calls[0]!.init.headers).get("xi-api-key"), KEY);
	});

	it("reuses the list for the cache window, then asks again", async () => {
		let t = 1_000_000;
		const { calls, fetchFn } = fake(() => Response.json(models));
		const deps = { fetchFn, getKey, now: () => t };
		await listTtsModels(deps);
		t += TTS_MODELS_CACHE_MS - 1;
		await listTtsModels(deps);
		assert.equal(calls.length, 1);
		t += 2;
		await listTtsModels(deps);
		assert.equal(calls.length, 2);
	});

	it("a failure is not cached", async () => {
		let fail = true;
		const { calls, fetchFn } = fake(() => (fail ? new Response("nope", { status: 500 }) : Response.json(models)));
		assert.equal((await listTtsModels({ fetchFn, getKey })).status, 502);
		fail = false;
		assert.equal((await listTtsModels({ fetchFn, getKey })).status, 200);
		assert.equal(calls.length, 2);
	});

	it("is 503 keyless and 502 upstream", async () => {
		const { calls, fetchFn } = fake(() => Response.json({}));
		const keyless = await listTtsModels({ fetchFn, getKey: noKey });
		assert.equal(keyless.status, 503);
		assert.equal(((await keyless.json()) as { keyless: string }).keyless, "ELEVENLABS_API_KEY");
		assert.equal(calls.length, 0);

		const bad = fake(() => new Response(`bad key ${KEY}`, { status: 403 }));
		const res = await listTtsModels({ fetchFn: bad.fetchFn, getKey });
		assert.equal(res.status, 502);
		assert.equal((await res.text()).includes(KEY), false);
	});
});

describe("speak() uses the resolved model", () => {
	const audio = () => new Response(new Uint8Array([1, 2]), { status: 200 });
	const list = (...ids: string[]) =>
		ids.map((model_id) => ({ model_id, name: model_id, can_do_text_to_speech: true, maximum_text_length_per_request: 1000 }));

	/** A fake serving `modelList` (or failing) and recording the TTS bodies. */
	function setup(modelList: unknown) {
		const spoken: string[] = [];
		const { fetchFn } = fake((url, call) => {
			if (url.pathname === "/v1/models") return modelList === undefined ? new Response("down", { status: 500 }) : Response.json(modelList);
			spoken.push((JSON.parse(call.init.body as string) as { model_id: string }).model_id);
			return audio();
		});
		return { spoken, deps: { fetchFn, getKey } };
	}

	it("keeps a requested model the account lists", async () => {
		const { spoken, deps } = setup(list("eleven_v4_turbo", "eleven_v3"));
		await speak({ text: "Hi.", modelId: "eleven_v3" }, deps);
		assert.deepEqual(spoken, ["eleven_v3"]);
	});

	it("replaces an unlisted model with the default, then Flash, then the first", async () => {
		const a = setup(list("eleven_flash_v2_5", "eleven_v4_turbo"));
		await speak({ text: "Hi.", modelId: "gone" }, a.deps);
		assert.deepEqual(a.spoken, ["eleven_v4_turbo"]);
		clearTtsModelsCache();
		const b = setup(list("eleven_v3", "eleven_flash_v2_5"));
		await speak({ text: "Hi.", modelId: "gone" }, b.deps);
		assert.deepEqual(b.spoken, ["eleven_flash_v2_5"]);
		clearTtsModelsCache();
		const c = setup(list("eleven_v3", "eleven_multilingual_v2"));
		await speak({ text: "Hi." }, c.deps);
		assert.deepEqual(c.spoken, ["eleven_v3"]);
	});

	it("an unavailable list still plays: the requested model, else v4 Turbo", async () => {
		const a = setup(undefined);
		await speak({ text: "Hi.", modelId: "eleven_v3" }, a.deps);
		await speak({ text: "Hi." }, a.deps);
		assert.deepEqual(a.spoken, ["eleven_v3", "eleven_v4_turbo"]);
	});
});

describe("speak() uses the resolved voice", () => {
	const ALICE = "Xb7hH8MSUJpSbSDYk0k2";
	const audio = () => new Response(new Uint8Array([1, 2]), { status: 200 });
	const page = (...ids: string[]) => ({ voices: ids.map((voice_id) => ({ voice_id, name: voice_id, category: "premade" })), has_more: false });

	/** A fake serving `voicePages` by token (or failing when undefined), recording the voice each TTS call used. */
	function setup(voicePages: Record<string, unknown> | undefined) {
		const spoken: string[] = [];
		const counts = { voices: 0 };
		const { fetchFn } = fake((url) => {
			if (url.pathname === "/v1/models") return new Response("down", { status: 500 });
			if (url.pathname === "/v2/voices") {
				counts.voices++;
				if (voicePages === undefined) return new Response("down", { status: 500 });
				return Response.json(voicePages[url.searchParams.get("next_page_token") ?? ""]);
			}
			spoken.push(url.pathname.split("/")[3]!);
			return audio();
		});
		return { spoken, counts, deps: { fetchFn, getKey } };
	}

	it("keeps a saved voice the account lists, wherever it sits in the pages", async () => {
		const { spoken, deps } = setup({
			"": { ...page("a", ALICE), has_more: true, next_page_token: "t2" },
			t2: page("clone1"),
		});
		await speak({ text: "Hi.", voiceId: "clone1" }, deps);
		assert.deepEqual(spoken, ["clone1"]);
	});

	it("falls back to Alice when the saved voice is not on the account", async () => {
		const { spoken, deps } = setup({ "": page(ALICE, "clone1") });
		await speak({ text: "Hi.", voiceId: "gone" }, deps);
		assert.deepEqual(spoken, [ALICE]);
	});

	it("an unavailable voice list still plays the saved voice, else Alice", async () => {
		const { spoken, deps } = setup(undefined);
		await speak({ text: "Hi.", voiceId: "clone1" }, deps);
		await speak({ text: "Hi." }, deps);
		assert.deepEqual(spoken, ["clone1", ALICE]);
	});

	it("looks the list up once per cache window; a failure is retried, not cached", async () => {
		let t = 1_000_000;
		const ok = setup({ "": page(ALICE) });
		const deps = { ...ok.deps, now: () => t };
		await speak({ text: "Hi." }, deps);
		await speak({ text: "Hi." }, deps);
		assert.equal(ok.counts.voices, 1, "second speak reuses the cached list");
		t += TTS_MODELS_CACHE_MS + 1;
		await speak({ text: "Hi." }, deps);
		assert.equal(ok.counts.voices, 2, "expired list is fetched again");

		clearTtsModelsCache();
		const down = setup(undefined);
		await speak({ text: "Hi." }, down.deps);
		await speak({ text: "Hi." }, down.deps);
		assert.equal(down.counts.voices, 2, "failures are not cached");
	});
});
