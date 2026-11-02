import assert from "node:assert/strict";
import { test } from "node:test";
import { createDictationLanguageStore } from "../components/dictation-preference.ts";

function server(initial: unknown) {
	const state = { record: initial, bodies: [] as unknown[], failWrite: false };
	const store = createDictationLanguageStore(async (_url, init) => {
		if (init?.method === "PUT") {
			if (state.failWrite) return Response.json({}, { status: 500 });
			const body = JSON.parse(init.body as string);
			state.bodies.push(body);
			// The real route replaces the whole section.
			state.record = { version: 1, dictation: body };
			return Response.json({ settings: state.record });
		}
		return Response.json({ settings: state.record });
	});
	return { state, store };
}

test("the provider defaults to deepgram and reads the stored value", async () => {
	assert.equal(await server(null).store.getProvider(), "deepgram");
	assert.equal(await server({ version: 1, dictation: { language: "pl" } }).store.getProvider(), "deepgram");
	assert.equal(await server({ version: 1, dictation: { provider: "parakeet" } }).store.getProvider(), "parakeet");
});

test("a language save with nothing but language stored still sends exactly {language}", async () => {
	const { state, store } = server({ version: 1, dictation: { language: "en" } });
	await store.load();
	assert.equal(await store.save("pl"), true);
	assert.deepEqual(state.bodies, [{ language: "pl" }]);
});

test("a language save carries the stored provider, and a provider save carries the stored language", async () => {
	const { state, store } = server({ version: 1, dictation: { language: "pl", provider: "parakeet" } });
	await store.load();
	assert.equal(await store.save("fr"), true);
	assert.deepEqual(state.bodies.at(-1), { language: "fr", provider: "parakeet" });
	assert.equal(await store.saveProvider("deepgram"), true);
	assert.deepEqual(state.bodies.at(-1), { language: "fr", provider: "deepgram" });
	assert.equal(await store.getProvider(), "deepgram");
	assert.equal(await store.getLanguage(), "fr");
	assert.deepEqual(state.record, { version: 1, dictation: { language: "fr", provider: "deepgram" } });
});

test("a provider save with no stored language sends only the provider and keeps the resolved language", async () => {
	const { state, store } = server(null);
	await store.load();
	assert.equal(await store.saveProvider("parakeet"), true);
	assert.deepEqual(state.bodies, [{ provider: "parakeet" }]);
	assert.equal(store.getSnapshot().provider, "parakeet");
	assert.equal(await store.getLanguage(), "en");
	// Saving the language afterwards must not erase the provider.
	assert.equal(await store.save("pl"), true);
	assert.deepEqual(state.bodies.at(-1), { language: "pl", provider: "parakeet" });
});

test("a failed provider save keeps the previous provider and reports the error", async () => {
	const { state, store } = server({ version: 1, dictation: { language: "en" } });
	await store.load();
	state.failWrite = true;
	assert.equal(await store.saveProvider("parakeet"), false);
	assert.equal(store.getSnapshot().provider, "deepgram");
	assert.match(store.getSnapshot().error!, /Could not save dictation provider/);
	assert.equal(store.getSnapshot().saving, false);
});

test("a provider save is single-flight with language saves", async () => {
	const { store } = server({ version: 1, dictation: { language: "en" } });
	await store.load();
	const first = store.saveProvider("parakeet");
	assert.equal(await store.save("pl"), false);
	assert.equal(await first, true);
});
