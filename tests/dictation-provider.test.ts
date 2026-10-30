import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDictationProvider } from "../src/core/dictation-provider.ts";

describe("dictation provider resolver", () => {
	const both = { deepgram: true, elevenlabs: true };
	const none = { deepgram: false, elevenlabs: false };
	const table: [string, Parameters<typeof resolveDictationProvider>, ReturnType<typeof resolveDictationProvider>][] = [
		["explicit deepgram, both keys", ["deepgram", both], { provider: "deepgram" }],
		["explicit elevenlabs, both keys", ["elevenlabs", both], { provider: "elevenlabs" }],
		["explicit elevenlabs, only deepgram key", ["elevenlabs", { deepgram: true, elevenlabs: false }], { keyless: "ELEVENLABS_API_KEY" }],
		["explicit deepgram, only elevenlabs key", ["deepgram", { deepgram: false, elevenlabs: true }], { keyless: "DEEPGRAM_API_KEY" }],
		["explicit deepgram, no keys", ["deepgram", none], { keyless: "DEEPGRAM_API_KEY" }],
		["explicit elevenlabs, no keys", ["elevenlabs", none], { keyless: "ELEVENLABS_API_KEY" }],
		["no choice, both keys prefers deepgram", [undefined, both], { provider: "deepgram" }],
		["no choice, only deepgram", [undefined, { deepgram: true, elevenlabs: false }], { provider: "deepgram" }],
		["no choice, only elevenlabs", [undefined, { deepgram: false, elevenlabs: true }], { provider: "elevenlabs" }],
		["no choice, no keys falls to deepgram keyless", [undefined, none], { keyless: "DEEPGRAM_API_KEY" }],
	];
	for (const [name, args, expected] of table) {
		it(name, () => assert.deepEqual(resolveDictationProvider(...args), expected));
	}
});
