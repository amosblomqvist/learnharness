import assert from "node:assert/strict";
import { test } from "node:test";
import { createDictationLanguageStore } from "../components/dictation-preference.ts";
import { checkGroqReady, GROQ_DICTATION_KEYLESS, transcribeGroq } from "../components/dictation-groq.ts";
import type { UserSettings } from "../src/core/index.ts";

/** A fake settings endpoint: GET returns the record, PUT replaces the dictation section whole (as the route does). */
function server(initial: UserSettings["dictation"] | undefined) {
	const state = { dictation: initial, puts: [] as unknown[], failPut: false, reads: 0 };
	const request = (async (_url: string, init?: RequestInit) => {
		if (init?.method === "PUT") {
			state.puts.push(JSON.parse(init.body as string));
			if (state.failPut) return Response.json({}, { status: 500 });
			state.dictation = JSON.parse(init.body as string);
			return Response.json({ settings: { version: 1, dictation: state.dictation } });
		}
		state.reads++;
		return Response.json({ settings: state.dictation ? { version: 1, dictation: state.dictation } : null });
	}) as typeof fetch;
	return { state, request };
}

test("old records load as Deepgram + turbo; saved engine choices load as written", async () => {
	for (const [dictation, provider, groqModel] of [
		[undefined, "deepgram", "whisper-large-v3-turbo"],
		[{ language: "pl" }, "deepgram", "whisper-large-v3-turbo"],
		[{ language: "pl", provider: "groq", groqModel: "whisper-large-v3" }, "groq", "whisper-large-v3"],
	] as const) {
		const { request } = server(dictation as UserSettings["dictation"]);
		const store = createDictationLanguageStore(request);
		await store.load();
		assert.equal(store.getSnapshot().provider, provider);
		assert.equal(store.getSnapshot().groqModel, groqModel);
		const language = dictation?.language ?? "en";
		// The Local engine's settings ride along, at their defaults here.
		assert.deepEqual(await store.getPreference(), {
			language, provider, groqModel,
			localModel: "", localPreferredLanguages: [language], localLanguage: "auto", localChineseOutput: "simplified",
		});
	}
});

test("choosing Groq writes the whole section, so a later language change cannot reset the engine", async () => {
	const { state, request } = server({ language: "pl" });
	const store = createDictationLanguageStore(request);
	await store.load();
	assert.equal(await store.saveEngine({ provider: "groq" }), true);
	assert.deepEqual(state.puts.at(-1), { language: "pl", provider: "groq" });
	assert.equal(await store.save("fr"), true);
	assert.deepEqual(state.puts.at(-1), { language: "fr", provider: "groq" }, "the language PUT carries the engine");
	assert.equal(await store.saveEngine({ groqModel: "whisper-large-v3" }), true);
	assert.deepEqual(state.puts.at(-1), { language: "fr", provider: "groq", groqModel: "whisper-large-v3" });
	assert.deepEqual(await store.getPreference(), {
		language: "fr", provider: "groq", groqModel: "whisper-large-v3",
		localModel: "", localPreferredLanguages: ["fr"], localLanguage: "auto", localChineseOutput: "simplified",
	});
});

test("every write carries the Local settings, so choosing Groq or a language cannot erase them", async () => {
	const local = { localModel: "whisper-large-v3-turbo", localPreferredLanguages: ["en", "de"], localLanguage: "de", localChineseOutput: "traditional" as const };
	const { state, request } = server({ language: "en", provider: "local", ...local });
	const store = createDictationLanguageStore(request);
	await store.load();
	assert.equal(store.getSnapshot().provider, "local");
	assert.deepEqual(await store.getPreference(), { language: "en", provider: "local", groqModel: "whisper-large-v3-turbo", ...local });
	assert.equal(await store.saveEngine({ provider: "groq" }), true);
	assert.deepEqual(state.puts.at(-1), { language: "en", provider: "groq", ...local });
	assert.equal(await store.save("fr"), true);
	assert.deepEqual(state.puts.at(-1), { language: "fr", provider: "groq", ...local });
	assert.equal(await store.saveEngine({ localModel: "parakeet-tdt-0.6b-v3", localLanguage: "auto" }), true);
	const { localLanguage: _auto, ...rest } = local;
	assert.deepEqual(state.puts.at(-1), { language: "fr", provider: "groq", ...rest, localModel: "parakeet-tdt-0.6b-v3" }, "Auto is the default, so it is not written");
	assert.equal((await store.getPreference()).localModel, "parakeet-tdt-0.6b-v3");
});

test("preferred languages that follow the dictation language keep following it, explicit ones stay", async () => {
	const unset = server({ language: "en" });
	const following = createDictationLanguageStore(unset.request);
	await following.load();
	assert.deepEqual(following.getSnapshot().localPreferredLanguages, ["en"]);
	await following.save("de");
	assert.deepEqual(unset.state.puts.at(-1), { language: "de" }, "not frozen to the old language's default");
	assert.deepEqual((await following.getPreference()).localPreferredLanguages, ["de"]);

	const explicit = server({ language: "en", localPreferredLanguages: ["en", "fr"] });
	const chosen = createDictationLanguageStore(explicit.request);
	await chosen.load();
	await chosen.save("de");
	assert.deepEqual(explicit.state.puts.at(-1), { language: "de", localPreferredLanguages: ["en", "fr"] });
});

test("a Deepgram user's record stays exactly { language }, including after switching back", async () => {
	const { state, request } = server({ language: "en" });
	const store = createDictationLanguageStore(request);
	await store.load();
	await store.save("multi");
	assert.deepEqual(state.puts.at(-1), { language: "multi" }, "byte-for-byte the pre-Groq body");
	await store.saveEngine({ provider: "groq" });
	await store.saveEngine({ provider: "deepgram" });
	assert.deepEqual(state.puts.at(-1), { language: "multi" }, "the default engine is not written");
	assert.equal(store.getSnapshot().provider, "deepgram");
});

test("a failed engine save keeps the confirmed engine and says which save failed", async () => {
	const { state, request } = server({ language: "en" });
	const store = createDictationLanguageStore(request);
	await store.load();
	state.failPut = true;
	assert.equal(await store.saveEngine({ provider: "groq" }), false);
	assert.equal(store.getSnapshot().provider, "deepgram");
	assert.match(store.getSnapshot().error!, /Could not save dictation engine/);
	assert.equal((await store.getPreference()).provider, "deepgram");
	state.failPut = false;
	assert.equal(await store.save("pl"), true);
	assert.equal(store.getSnapshot().error, null);
});

test("a run that starts during an engine save waits for it and sees the new engine", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const store = createDictationLanguageStore((async (_url: string, init?: RequestInit) => {
		if (init?.method === "PUT") {
			await gate;
			return Response.json({ settings: { version: 1, dictation: JSON.parse(init.body as string) } });
		}
		return Response.json({ settings: { version: 1, dictation: { language: "en" } } });
	}) as typeof fetch);
	await store.load();
	const saved = store.saveEngine({ provider: "groq" });
	const preference = store.getPreference();
	assert.equal(await store.saveEngine({ provider: "deepgram" }), false, "a competing write cannot inherit the first one's success");
	release();
	assert.equal(await saved, true);
	assert.equal((await preference).provider, "groq");
});

test("the transport helpers map the route's answers", async () => {
	const respond = (response: () => Response) => (async () => response()) as typeof fetch;
	const wav = new Uint8Array(100) as Uint8Array<ArrayBuffer>;
	const args = { wav, model: "whisper-large-v3-turbo", language: "en-GB" } as const;

	// The key check reads the masked key list; absent provider keys are not listed at all.
	const asked: string[] = [];
	const keyList = (...keys: { id: string; present: boolean }[]) => (async (url: string) => { asked.push(url); return Response.json({ keys }); }) as typeof fetch;
	await checkGroqReady(keyList({ id: "DEEPGRAM_API_KEY", present: false }, { id: "GROQ_API_KEY", present: true }));
	assert.deepEqual(asked, ["/api/keys"]);
	await assert.rejects(checkGroqReady(keyList({ id: "GROQ_API_KEY", present: false })), { message: GROQ_DICTATION_KEYLESS });
	await assert.rejects(checkGroqReady(keyList({ id: "DEEPGRAM_API_KEY", present: true })), { message: GROQ_DICTATION_KEYLESS });
	await assert.rejects(checkGroqReady(respond(() => Response.json({ message: "keys unavailable" }, { status: 500 }))), /keys unavailable/);
	await assert.rejects(checkGroqReady((async () => { throw new TypeError("offline"); }) as typeof fetch), /Could not reach/);

	assert.equal(await transcribeGroq(respond(() => Response.json({ text: "  hi  " })), args), "hi");
	await assert.rejects(transcribeGroq(respond(() => Response.json({}, { status: 503 })), args), { message: GROQ_DICTATION_KEYLESS });
	await assert.rejects(transcribeGroq(respond(() => Response.json({ message: "The recording is too large for Groq." }, { status: 413 })), args), /too large/);
	await assert.rejects(transcribeGroq(respond(() => new Response("<html>", { status: 500 })), args), /Groq dictation failed \(500\)/);
	await assert.rejects(transcribeGroq(respond(() => Response.json({ nope: 1 })), args), /no transcript/);
	await assert.rejects(transcribeGroq((async () => { throw new TypeError("offline"); }) as typeof fetch, args), /Could not send the recording/);
});
