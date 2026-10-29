import assert from "node:assert/strict";
import { test } from "node:test";
import { createDictationLanguageStore } from "../components/dictation-preference.ts";

test("all readers immediately receive the confirmed write without another GET", async () => {
	let reads = 0;
	let notifications = 0;
	let failReads = false;
	const store = createDictationLanguageStore(async (_url, init) => {
		if (init?.method === "PUT") return Response.json({ settings: { version: 1, dictation: JSON.parse(init.body as string) } });
		reads++;
		return failReads ? Response.json({}, { status: 500 }) : Response.json({ settings: null });
	}, () => { notifications++; });
	assert.equal(await store.load(), "en");
	const observed: string[] = [];
	const off = store.subscribe(() => { observed.push(`${store.getSnapshot().language}:${store.getSnapshot().saving}`); });
	failReads = true;
	assert.equal(await store.save("multi"), true);
	assert.equal(await store.getLanguage(), "multi");
	assert.equal(reads, 1);
	assert.equal(notifications, 1);
	assert(observed.includes("multi:true"));
	assert.equal(observed.at(-1), "multi:false");
	off();
});

test("ordinary loads and repeated recordings reuse the initial confirmed value", async () => {
	let reads = 0;
	const store = createDictationLanguageStore(async () => {
		reads++;
		if (reads > 1) throw new Error("should not reread");
		return Response.json({ settings: { version: 1, dictation: { language: "fr" } } });
	});
	assert.deepEqual(await Promise.all([store.getLanguage(), store.load()]), ["fr", "fr"]);
	for (let i = 0; i < 3; i++) {
		const unsubscribe = store.subscribe(() => {});
		assert.equal(await store.getLanguage(), "fr");
		assert.equal(await store.load(), "fr");
		unsubscribe();
	}
	assert.equal(reads, 1);
});

test("a failed external refresh invalidates the cache until a successful retry", async () => {
	let fail = false;
	const store = createDictationLanguageStore(async () => fail
		? Response.json({}, { status: 500 })
		: Response.json({ settings: { version: 1, dictation: { language: "pl" } } }));
	await store.load();
	fail = true;
	await assert.rejects(store.load(true), /Could not load/);
	await assert.rejects(store.getLanguage(), /Could not load/);
	fail = false;
	assert.equal(await store.getLanguage(), "pl");
	assert.equal(store.getSnapshot().error, null);
});

test("stale reads cannot overwrite a newer write and subscribers see busy before transport runs", async () => {
	let stale!: (response: Response) => void;
	let nextRead: Promise<Response> | undefined;
	const store = createDictationLanguageStore(async (_url, init) => {
		if (init?.method === "PUT") return Response.json({ settings: { version: 1, dictation: { language: "multi" } } });
		if (nextRead) { const response = nextRead; nextRead = undefined; return response; }
		return Response.json({ settings: { version: 1, dictation: { language: "pl" } } });
	});
	await store.load();
	nextRead = new Promise((resolve) => { stale = resolve; });
	const oldRead = store.load(true);
	await Promise.resolve();
	let startedDuringPublish: Promise<string> | undefined;
	const off = store.subscribe(() => {
		if (store.getSnapshot().saving && !startedDuringPublish) startedDuringPublish = store.getLanguage();
	});
	assert.equal(await store.save("multi"), true);
	stale(Response.json({ settings: { version: 1, dictation: { language: "pl" } } }));
	assert.equal(await oldRead, "multi");
	assert.equal(await startedDuringPublish, "multi");
	assert.equal(store.getSnapshot().language, "multi");
	off();
});

for (const newestFirst of [false, true]) test(`overlapping reads keep the newest value, newest resolves first: ${newestFirst}`, async () => {
	const responses: ((response: Response) => void)[] = [];
	const store = createDictationLanguageStore(() => new Promise((resolve) => { responses.push(resolve); }));
	const first = store.load();
	await Promise.resolve();
	const second = store.load(true);
	await Promise.resolve();
	const old = Response.json({ settings: { version: 1, dictation: { language: "pl" } } });
	const fresh = Response.json({ settings: { version: 1, dictation: { language: "multi" } } });
	if (newestFirst) { responses[1]!(fresh); responses[0]!(old); }
	else { responses[0]!(old); responses[1]!(fresh); }
	assert.deepEqual(await Promise.all([first, second]), ["multi", "multi"]);
	assert.equal(await store.getLanguage(), "multi");
});

test("capture also waits for a write initiated as a pending read publishes its result", async () => {
	const store = createDictationLanguageStore(async (_url, init) => Response.json({ settings: {
		version: 1, dictation: { language: init?.method === "PUT" ? "multi" : "en" },
	} }));
	let started = false;
	const off = store.subscribe(() => {
		if (!started && store.getSnapshot().language === "en") {
			started = true;
			void store.save("multi");
		}
	});
	assert.equal(await store.getLanguage(), "multi");
	off();
});
