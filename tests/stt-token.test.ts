/**
 * The dictation token mint (src/server/stt-token.ts): the server resolves the
 * provider from the saved choice + key presence, mints a short-lived token
 * upstream, and returns { provider, token }. fetch, key lookup and the saved
 * record are injected — no network, no real keys.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mintSttToken, type SttTokenDeps } from "../src/server/stt-token.ts";
import type { DictationProviderId } from "../src/core/index.ts";

const REAL_KEYS: Record<string, string> = { DEEPGRAM_API_KEY: "dg-REAL-secret-key", ELEVENLABS_API_KEY: "xi-REAL-secret-key" };

type Call = { url: string; init?: RequestInit };

function deps(opts: {
	keys?: Record<string, string>;
	provider?: DictationProviderId;
	upstream?: (call: Call) => Response | Promise<Response>;
}): { deps: SttTokenDeps; calls: Call[] } {
	const calls: Call[] = [];
	const keys = opts.keys ?? REAL_KEYS;
	return {
		calls,
		deps: {
			keyValue: (id) => keys[id],
			savedProvider: () => opts.provider,
			fetch: (async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				return opts.upstream ? opts.upstream({ url, init }) : Response.json({});
			}) as typeof fetch,
		},
	};
}

describe("mintSttToken", () => {
	it("Deepgram: today's grant, returned with its provider", async () => {
		const { deps: d, calls } = deps({
			provider: "deepgram",
			upstream: () => Response.json({ access_token: "dg-jwt" }),
		});
		const res = await mintSttToken(d);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { provider: "deepgram", token: "dg-jwt" });
		assert.equal(calls[0]!.url, "https://api.deepgram.com/v1/auth/grant");
		assert.equal(calls[0]!.init?.method, "POST");
		assert.equal((calls[0]!.init?.headers as Record<string, string>).Authorization, `Token ${REAL_KEYS.DEEPGRAM_API_KEY}`);
		assert.deepEqual(JSON.parse(calls[0]!.init?.body as string), { ttl_seconds: 300 });
	});

	it("ElevenLabs: a realtime_scribe single-use token via xi-api-key", async () => {
		const { deps: d, calls } = deps({
			provider: "elevenlabs",
			upstream: () => Response.json({ token: "sutkn_abc" }),
		});
		const res = await mintSttToken(d);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { provider: "elevenlabs", token: "sutkn_abc" });
		assert.equal(calls[0]!.url, "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe");
		assert.equal(calls[0]!.init?.method, "POST");
		assert.equal((calls[0]!.init?.headers as Record<string, string>)["xi-api-key"], REAL_KEYS.ELEVENLABS_API_KEY);
	});

	it("with no saved choice it follows the keys present (ElevenLabs only)", async () => {
		const { deps: d, calls } = deps({
			keys: { ELEVENLABS_API_KEY: REAL_KEYS.ELEVENLABS_API_KEY! },
			upstream: () => Response.json({ token: "sutkn_x" }),
		});
		assert.deepEqual(await (await mintSttToken(d)).json(), { provider: "elevenlabs", token: "sutkn_x" });
		assert.match(calls[0]!.url, /elevenlabs/);
	});

	it("with no saved choice and both keys it uses Deepgram", async () => {
		const { deps: d } = deps({ upstream: () => Response.json({ access_token: "dg" }) });
		assert.equal(((await (await mintSttToken(d)).json()) as { provider: string }).provider, "deepgram");
	});

	it("keyless: 503 naming the missing key id, with no upstream call", async () => {
		for (const [provider, keys, missing] of [
			["elevenlabs", { DEEPGRAM_API_KEY: "dg" }, "ELEVENLABS_API_KEY"],
			["deepgram", { ELEVENLABS_API_KEY: "xi" }, "DEEPGRAM_API_KEY"],
			[undefined, {}, "DEEPGRAM_API_KEY"],
		] as const) {
			const { deps: d, calls } = deps({ provider, keys });
			const res = await mintSttToken(d);
			assert.equal(res.status, 503, `${provider}`);
			const body = (await res.json()) as { message: string; keyless: string };
			assert.equal(body.keyless, missing);
			assert.match(body.message, new RegExp(missing));
			assert.equal(calls.length, 0);
		}
	});

	it("upstream failure: 502 with a short message and no key anywhere in the body", async () => {
		for (const provider of ["deepgram", "elevenlabs"] as const) {
			const key = REAL_KEYS[provider === "deepgram" ? "DEEPGRAM_API_KEY" : "ELEVENLABS_API_KEY"];
			for (const upstream of [
				() => new Response(`denied for ${key}`, { status: 401 }), // an upstream that echoes the key
				() => Response.json({}), // 200 without a token
				() => { throw new Error(`boom ${key}`); },
			]) {
				const { deps: d } = deps({ provider, upstream });
				const res = await mintSttToken(d);
				assert.equal(res.status, 502, provider);
				const text = await res.text();
				assert.ok(text.length < 400, "short");
				assert.ok(!text.includes("REAL-secret"), `no key in body: ${text}`);
			}
		}
	});

	it("never puts a key in a success body", async () => {
		const { deps: d } = deps({ provider: "elevenlabs", upstream: () => Response.json({ token: "sutkn_ok" }) });
		assert.ok(!(await (await mintSttToken(d)).text()).includes("REAL-secret"));
	});
});
