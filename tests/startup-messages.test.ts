import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const require = createRequire(import.meta.url);
const { dismissalStore, selectMessage, startMessages } = require("../electron/startup-messages.cjs");
const first = { id: "a", title: "First", publishedAt: "2026-11-01T00:00:00Z", bodyMarkdown: "**First**" };
const newest = { ...first, id: "b", title: "Newest", publishedAt: "2026-11-02T00:00:00Z" };
const feed = (...messages: unknown[]) => ({ schemaVersion: 1, messages });
const fakeWindow = () => Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isFocused: (): boolean => true, isDestroyed: () => false });
const emptyStore = () => ({ read: async () => new Set(), write: async () => assert.fail("unexpected dismissal write") });

it("considers only the newest message by timestamp then ID, independent of array order", () => {
	const tie = { ...newest, id: "c", publishedAt: "2026-11-02T00:00:00.0Z" };
	assert.deepEqual(selectMessage(feed(tie, first, newest), new Set()), tie);
	assert.deepEqual(selectMessage(feed(newest, first, tie), new Set(["b"])), tie);
	assert.equal(selectMessage(feed(newest, first, tie), new Set(["c"])), null, "no fallback even on a timestamp tie");
	assert.equal(selectMessage(feed(newest, first), new Set(["b"])), null);
	assert.equal(selectMessage(feed(), new Set()), null);
});

it("validates the whole v1 feed including byte lengths, IDs and actual UTC dates", () => {
	for (const invalid of [
		{ ...newest, publishedAt: "2026-02-29T00:00:00Z" },
		{ ...newest, publishedAt: "2026-12-01T24:00:00Z" },
		{ ...newest, publishedAt: "2026-11-01T00:00:00+00:00" },
		{ ...newest, title: "é".repeat(129) },
		{ ...newest, bodyMarkdown: "😀".repeat(8193) },
		{ ...newest, bodyMarkdown: " \n " },
		{ ...newest, id: "x".repeat(97) },
		{ ...newest, id: "x\n" },
		{ ...newest, id: "a" },
		null,
	]) assert.equal(selectMessage(feed(first, invalid), new Set()), null);
	assert.equal(selectMessage({ ...feed(newest), schemaVersion: 2 }, new Set()), null);
	assert.ok(selectMessage(feed({ ...newest, title: "é".repeat(128), bodyMarkdown: "😀".repeat(8192), id: "x".repeat(96) }), new Set()));
});

it("fetches once without credentials and offers only the latest message across launches", async t => {
	const profile = await mkdtemp(join(tmpdir(), "lh-startup-message-"));
	t.after(() => rm(profile, { recursive: true, force: true }));
	let requests = 0;
	let messages = [first, newest];
	const fetchImpl = async (url: string, init: RequestInit) => {
		requests++;
		assert.equal(url, "https://learnharness.ai/startup-messages.json");
		assert.equal(init.redirect, "error");
		assert.equal(init.credentials, "omit");
		assert.equal(init.referrerPolicy, "no-referrer");
		return Response.json(feed(...messages));
	};
	const launch = () => {
		const win = fakeWindow();
		const service = startMessages(win, dismissalStore(profile), { fetchImpl });
		win.emit("ready-to-show");
		return service;
	};
	const initial = launch();
	await Promise.resolve();
	assert.equal(requests, 1, "starts without waiting for the renderer");
	assert.deepEqual((await initial.take())?.message, newest);
	assert.equal(await initial.take(), null);
	assert.equal(await initial.dismiss(first.id), false);
	assert.deepEqual([...(await dismissalStore(profile).read())], []);
	assert.equal(await initial.dismiss(newest.id), true);
	assert.equal(await launch().take(), null, "dismissing the newest does not reveal older entries");
	assert.equal(requests, 2);
	const later = { ...newest, id: "later", title: "A later announcement", publishedAt: "2026-11-03T00:00:00Z" };
	messages = [newest, later, first];
	assert.deepEqual((await launch().take())?.message, later, "a new publication can still appear");
	await writeFile(join(profile, "startup-message-dismissals.json"), "corrupt profile fixture");
	assert.equal(await launch().take(), null, "skip when dismissal state cannot be read");
});

it("returns silently for HTTP, JSON, UTF-8, and streamed oversize failures", async () => {
	let cancelled = false;
	const oversized = new Response(new ReadableStream({
		pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
		cancel() { cancelled = true; },
	}), { headers: { "Content-Length": "100", "Content-Encoding": "gzip" } });
	for (const response of [new Response("", { status: 404 }), new Response("{"), new Response(Uint8Array.of(0xff)), oversized]) {
		const win = fakeWindow();
		const service = startMessages(win, emptyStore(), { fetchImpl: async () => response });
		win.emit("ready-to-show");
		assert.equal(await service.take(), null);
	}
	assert.equal(cancelled, true);
});

it("skips and aborts when the first window is no longer quiet or the deadline elapses", async () => {
	for (const interrupt of [
		(win: ReturnType<typeof fakeWindow>) => win.webContents.emit("before-input-event", {}, { type: "keyDown" }),
		(win: ReturnType<typeof fakeWindow>) => win.webContents.emit("before-mouse-event", {}, { type: "mouseDown" }),
		(win: ReturnType<typeof fakeWindow>) => win.emit("blur"),
		(win: ReturnType<typeof fakeWindow>) => win.emit("closed"),
		(win: ReturnType<typeof fakeWindow>) => {
			const url = "http://127.0.0.1:9000/";
			win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url });
			win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url });
		},
		(win: ReturnType<typeof fakeWindow>) => {
			const url = "http://127.0.0.1:9000/";
			win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url });
			win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true, url: `${url}settings` });
		},
		() => {},
	]) {
		const win = fakeWindow();
		let aborted = false;
		const service = startMessages(win, emptyStore(), {
			windowMs: 15,
			fetchImpl: (_url: string, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); })),
		});
		win.emit("ready-to-show");
		const result = service.take();
		await Promise.resolve();
		interrupt(win);
		assert.equal(await result, null);
		assert.equal(aborted, true);
		assert.equal(await service.take(), null);
	}
});

it("allows the same-URL history update during hydration without cancelling startup", async () => {
	const win = fakeWindow();
	const service = startMessages(win, emptyStore(), { fetchImpl: async () => Response.json(feed(newest)) });
	const url = "http://127.0.0.1:9000/";
	win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url });
	win.emit("ready-to-show");
	win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true, url });
	assert.deepEqual((await service.take())?.message, newest);
});

it("waits for paint and first focus within the startup window without focusing the window itself", async () => {
	const win = fakeWindow();
	win.isFocused = () => false;
	const service = startMessages(win, emptyStore(), { fetchImpl: async () => Response.json(feed(newest)) });
	let settled = false;
	const result = service.take().then((offer: unknown) => { settled = true; return offer; });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(settled, false);
	win.emit("ready-to-show");
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(settled, false);
	win.isFocused = () => true;
	win.emit("focus");
	assert.deepEqual((await result as { message: unknown }).message, newest);
});

it("has a separate publication-only, tag-only notifier", () => {
	const { load } = require("js-yaml");
	const file = (name: string) => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
	const { on, permissions, jobs } = load(file("notify-website-announcement"));
	assert.deepEqual(on, { release: { types: ["published"] } });
	assert.deepEqual(permissions, {});
	const job = jobs["notify-website-announcement"];
	assert.match(job.if, /github\.repository == 'amosblomqvist\/learnharness'/);
	assert.match(job.if, /!github\.event\.release\.draft && !github\.event\.release\.prerelease/);
	assert.equal(job.steps.length, 1);
	assert.deepEqual(job.steps[0].env, { WEBSITE_DISPATCH_TOKEN: "${{ secrets.WEBSITE_DISPATCH_TOKEN }}", RELEASE_TAG: "${{ github.event.release.tag_name }}" });
	assert.match(job.steps[0].run, /event_type:"desktop-announcement-published",client_payload:\{tag:\$tag\}/);
	assert.match(file("notify-website"), /event_type:"desktop-release-published",client_payload:\{tag:\$tag\}/);
});
