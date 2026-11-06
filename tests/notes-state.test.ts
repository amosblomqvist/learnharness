import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { NOTES_MAX_WIDTH } from "../components/notes-layout";
import { NOTES_OPEN_KEY, NotesController } from "../components/notes-state";

interface Call { url: string; method: string; body: string; keepalive: boolean | undefined }
let calls: Call[] = [];
let failNext = false;
let throwNext = false;
let gate: Promise<void> | null = null;
let serverText = "";
const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = (async (url: string, init: RequestInit) => {
	if (throwNext) {
		throwNext = false;
		throw new Error("sync boom");
	}
	calls.push({ url, method: init.method ?? "GET", body: String(init.body), keepalive: init.keepalive });
	if (gate) {
		const g = gate;
		gate = null;
		await g;
	}
	if (failNext) {
		failNext = false;
		return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
	}
	if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify({ text: serverText }), { status: 200 });
	return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as typeof fetch;

function resetSpy() {
	const resets: string[] = [];
	const port = { replace() {}, append() {}, reset: (t: string) => void resets.push(t) };
	return { port, resets };
}

after(() => {
	globalThis.fetch = realFetch;
});

function memoryStorage() {
	const store = new Map<string, string>();
	return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
}

describe("NotesController", () => {
	beforeEach(() => {
		calls = [];
		failNext = false;
		throwNext = false;
		gate = null;
		serverText = "";
	});

	it("debounces edits into one PUT of the latest text", async () => {
		const c = new NotesController("c1", "", { saveDelayMs: 5 });
		c.onEdit("a"); c.onEdit("ab");
		await sleep(20);
		assert.deepEqual(calls.map((x) => [x.url, x.method, JSON.parse(x.body).text]), [["/api/chats/c1/notes", "PUT", "ab"]]);
	});
	it("flush saves now; nothing dirty → no request", async () => {
		const c = new NotesController("c1", "x", { saveDelayMs: 10_000 });
		assert.equal(await c.flush(), true); assert.equal(calls.length, 0);
		c.onEdit("y"); assert.equal(await c.flush(), true); assert.equal(calls.length, 1);
		c.dispose();
	});
	it("dispose sends the pending text with keepalive", () => {
		const c = new NotesController("c1", "", { saveDelayMs: 10_000 });
		c.onEdit("last words"); c.dispose();
		assert.equal(calls[0]!.keepalive, true); assert.equal(JSON.parse(calls[0]!.body).text, "last words");
	});
	it("keepalive only for bodies a browser accepts (under 60,000 bytes)", () => {
		const c = new NotesController("c1", "", { saveDelayMs: 10_000 });
		c.onEdit("x".repeat(59_000)); c.dispose();
		const wide = new NotesController("c2", "", { saveDelayMs: 10_000 });
		wide.onEdit("€".repeat(25_000)); wide.dispose(); // 25,000 chars, 75,000 bytes
		assert.deepEqual(calls.map((x) => x.keepalive), [true, false]);
		assert.equal(JSON.parse(calls[1]!.body).text, "€".repeat(25_000), "the large body is still sent");
	});
	it("failed save keeps text dirty and retries", async () => {
		failNext = true;
		const c = new NotesController("c1", "", { saveDelayMs: 10_000 });
		c.onEdit("z");
		assert.equal(await c.flush(), false);
		assert.equal(c.getSnapshot().saveError, "Notes not saved");
		assert.equal(await c.flush(), true);
		assert.equal(c.getSnapshot().saveError, null);
		c.dispose();
	});
	it("open flag persists", () => {
		const store = new Map<string, string>();
		const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
		new NotesController("c1", "", { storage }).setOpen(true);
		assert.equal(new NotesController("c2", "", { storage }).getSnapshot().open, true);
	});
	it("snapshot identity is stable until something changes", () => {
		const c = new NotesController("c1", "");
		const s = c.getSnapshot();
		assert.equal(c.getSnapshot(), s);
		c.setOpen(true);
		assert.notEqual(c.getSnapshot(), s);
	});
	it("a synchronously throwing fetch fails the save and does not wedge later flushes", async () => {
		throwNext = true;
		const c = new NotesController("c1", "", { saveDelayMs: 10_000 });
		c.onEdit("q");
		assert.equal(await c.flush(), false);
		assert.equal(c.getSnapshot().saveError, "Notes not saved");
		assert.equal(await c.flush(), true);
		assert.equal(c.getSnapshot().saveError, null);
		assert.equal(calls.length, 1);
		c.dispose();
	});
	it("flush during an in-flight save waits, then saves the newer text", async () => {
		let release!: () => void;
		gate = new Promise<void>((r) => (release = r));
		const c = new NotesController("c1", "", { saveDelayMs: 10_000 });
		c.onEdit("one");
		const f1 = c.flush();
		c.onEdit("two");
		const f2 = c.flush();
		c.onEdit("three");
		const f3 = c.flush();
		release();
		assert.deepEqual(await Promise.all([f1, f2, f3]), [true, true, true]);
		assert.deepEqual(calls.map((x) => JSON.parse(x.body).text), ["one", "three"]);
		c.dispose();
	});
	it("refresh adopts newer server text when clean, without saving it back", async () => {
		const c = new NotesController("c1", "stale", { saveDelayMs: 5 });
		const { port, resets } = resetSpy();
		c.attach(port);
		serverText = "newer";
		await c.refresh();
		assert.equal(c.text(), "newer");
		assert.deepEqual(resets, ["newer"]);
		await sleep(20);
		assert.deepEqual(calls.map((x) => [x.url, x.method]), [["/api/chats/c1/notes", "GET"]]);
	});
	it("refresh keeps local text when an edit happened before or during the fetch", async () => {
		const before = new NotesController("c1", "stale", { saveDelayMs: 10_000 });
		const spy1 = resetSpy();
		before.attach(spy1.port);
		before.onEdit("mine");
		serverText = "newer";
		await before.refresh();
		assert.equal(before.text(), "mine");
		assert.deepEqual(spy1.resets, []);
		before.dispose();

		let release!: () => void;
		gate = new Promise<void>((r) => (release = r));
		const during = new NotesController("c2", "stale", { saveDelayMs: 10_000 });
		const spy2 = resetSpy();
		during.attach(spy2.port);
		const refreshing = during.refresh();
		during.onEdit("mine");
		assert.equal(await during.flush(), true); // saved, so clean again before the fetch ends
		release();
		await refreshing;
		assert.equal(during.text(), "mine");
		assert.deepEqual(spy2.resets, []);
	});
	it("refresh failure changes nothing", async () => {
		failNext = true;
		const c = new NotesController("c1", "kept", { saveDelayMs: 10_000 });
		await c.refresh();
		assert.equal(c.text(), "kept");
	});

	it("width persists, clamped", () => {
		const storage = memoryStorage();
		new NotesController("c1", "", { storage }).setWidth(5000);
		assert.equal(new NotesController("c2", "", { storage }).getSnapshot().width, NOTES_MAX_WIDTH);
	});

	it("auto-folds when narrow without touching the preference; explicit open wins until the next shrink", () => {
		const storage = memoryStorage();
		const c = new NotesController("c1", "", { storage });
		c.setOpen(true); c.setNarrow(true);
		assert.deepEqual([c.getSnapshot().open, c.getSnapshot().visible], [true, false]);
		assert.equal(storage.getItem(NOTES_OPEN_KEY), "1");
		c.setOpen(true); assert.equal(c.getSnapshot().visible, true);
		c.setNarrow(false); c.setNarrow(true); assert.equal(c.getSnapshot().visible, false);
		c.setNarrow(false); assert.equal(c.getSnapshot().visible, true);
	});

	it("setNarrow with the same value is a no-op", () => {
		const c = new NotesController("c1", "", { storage: memoryStorage() });
		c.setOpen(true); c.setNarrow(true); c.setOpen(true);
		const snap = c.getSnapshot();
		c.setNarrow(true);
		assert.equal(c.getSnapshot(), snap);
		assert.equal(snap.visible, true);
	});
	it("appendQuote with the panel closed opens it and saves the quoted text", async () => {
		const c = new NotesController("c1", "mine", { saveDelayMs: 0, storage: memoryStorage() });
		c.appendQuote("the pull acts on $A^\\tau$");
		assert.equal(c.getSnapshot().open, true);
		assert.equal(c.text(), "mine\n\n> the pull acts on $A^\\tau$\n");
		await c.flush();
		assert.equal(JSON.parse(calls.at(-1)!.body).text, c.text());
	});
	it("appendQuote with an editor attached delegates to the port; blank quotes do nothing", () => {
		const c = new NotesController("c1", "mine", { saveDelayMs: 60_000, storage: memoryStorage() });
		const blocks: string[] = [];
		c.attach({ replace() {}, append: (b) => void blocks.push(b), reset() {} });
		c.appendQuote("  \n ");
		assert.deepEqual(blocks, []);
		assert.equal(c.getSnapshot().open, false);
		c.appendQuote("a\nb");
		assert.deepEqual(blocks, ["> a\n> b"]);
		assert.equal(c.getSnapshot().open, true);
		assert.equal(c.text(), "mine");
		c.dispose();
	});
	it("replaceHighlight without an editor edits the nearest occurrence and saves it", async () => {
		const c = new NotesController("c1", "x ok? y ok? z", { saveDelayMs: 0, storage: memoryStorage() });
		const undo = c.replaceHighlight("ok?", 7, "fine");
		assert.deepEqual(undo, { from: 8, before: "ok?", after: "fine" });
		assert.equal(c.text(), "x ok? y fine z");
		await c.flush();
		assert.equal(JSON.parse(calls.at(-1)!.body).text, "x ok? y fine z");
		c.onEdit("typed first x ok? y fine z");
		assert.equal(c.undoRewrite(undo!), true, "found again after text moved");
		assert.equal(c.text(), "typed first x ok? y ok? z");
		assert.equal(c.undoRewrite(undo!), false, "the replacement is gone");
		c.dispose();
	});
	it("undoRewrite after the editor already undid it changes nothing", () => {
		const c = new NotesController("c1", "x ok? y fine z", { saveDelayMs: 60_000, storage: memoryStorage() });
		const undo = c.replaceHighlight("ok?", 0, "fine")!;
		assert.equal(c.text(), "x fine y fine z");
		c.onEdit("x ok? y fine z"); // Cmd+Z in the editor
		assert.equal(c.undoRewrite(undo), true);
		assert.equal(c.text(), "x ok? y fine z", "the other copy of the replacement is untouched");
		c.dispose();
	});
	it("undoRewrite of a rewrite that extends the highlight still restores it", () => {
		const c = new NotesController("c1", "A fixed? end", { saveDelayMs: 60_000, storage: memoryStorage() });
		const grow = c.replaceHighlight("A fixed?", 0, "A fixed? No, A moves")!;
		assert.equal(c.undoRewrite(grow), true);
		assert.equal(c.text(), "A fixed? end");
		const shrink = c.replaceHighlight("A fixed? end", 0, "A fixed?")!;
		c.onEdit("A fixed? end"); // Cmd+Z in the editor
		assert.equal(c.undoRewrite(shrink), true);
		assert.equal(c.text(), "A fixed? end");
		c.dispose();
	});
	it("replaceHighlight with an editor attached goes through the port", () => {
		const c = new NotesController("c1", "keep A? keep", { saveDelayMs: 60_000, storage: memoryStorage() });
		const edits: [number, number, string][] = [];
		c.attach({ replace: (from, to, insert) => void edits.push([from, to, insert]), append() {}, reset() {} });
		assert.deepEqual(c.replaceHighlight("A?", 0, "A moves"), { from: 5, before: "A?", after: "A moves" });
		assert.deepEqual(edits, [[5, 7, "A moves"]]);
		assert.equal(c.text(), "keep A? keep", "the editor reports the edit back");
		c.dispose();
	});
});
