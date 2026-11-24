const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const FEED_URL = "https://learnharness.ai/startup-messages.json";
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const STARTUP_WINDOW_MS = 3000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const UTC_TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/;
const text = (value, limit) => typeof value === "string" && value.trim() && Buffer.byteLength(value, "utf8") <= limit;
const validId = value => typeof value === "string" && ID.test(value);

function timestamp(value) {
	const match = typeof value === "string" && UTC_TIMESTAMP.exec(value);
	if (!match) return NaN;
	const millis = Date.parse(value);
	return Number.isFinite(millis) && new Date(millis).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z` ? millis : NaN;
}

function selectMessage(feed, dismissed) {
	if (feed?.schemaVersion !== 1 || !Array.isArray(feed.messages)) return null;
	const seen = new Set();
	let newest = null;
	let newestTime = -Infinity;
	for (const entry of feed.messages) {
		const { id, title, publishedAt, bodyMarkdown } = entry ?? {};
		const time = timestamp(publishedAt);
		if (!validId(id) || seen.has(id) || !text(title, 256) || !text(bodyMarkdown, 32 * 1024) || !Number.isFinite(time)) return null;
		seen.add(id);
		if (time > newestTime || (time === newestTime && id > newest.id)) {
			newest = { id, title, publishedAt, bodyMarkdown };
			newestTime = time;
		}
	}
	// Dismissing the latest announcement never reveals older entries.
	return newest && !dismissed.has(newest.id) ? newest : null;
}

async function fetchFeed(signal, fetchImpl) {
	const response = await fetchImpl(FEED_URL, {
		credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal,
		headers: { Accept: "application/json" },
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		return null;
	}
	// The actual byte limit is on the decoded stream, not Content-Length.
	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	try {
		if (!response.headers.has("content-encoding") && Number(response.headers.get("content-length")) > MAX_FEED_BYTES) return null;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_FEED_BYTES) return null;
			chunks.push(value);
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
	} finally {
		await reader.cancel().catch(() => {});
	}
}

function dismissalStore(profileDir) {
	// The renderer's loopback origin/port is different on each app launch.
	// Store only dismissed IDs in the stable desktop profile, never in localStorage.
	const file = path.join(profileDir, "startup-message-dismissals.json");
	return {
		async read() {
			let handle;
			try {
				handle = await fs.open(file, "r");
			} catch (error) {
				if (error.code === "ENOENT") return new Set();
				throw error;
			}
			try {
				const stat = await handle.stat();
				if (stat.size > MAX_FEED_BYTES || !stat.isFile()) throw new Error("Invalid startup message dismissal file");
				const ids = JSON.parse(await handle.readFile("utf8"));
				if (!Array.isArray(ids) || !ids.every(validId)) throw new Error("Invalid startup message dismissals");
				return new Set(ids);
			} finally { await handle.close(); }
		},
		async write(ids) {
			const body = JSON.stringify([...ids]);
			if (Buffer.byteLength(body, "utf8") > MAX_FEED_BYTES) throw new Error("Too many startup message dismissals");
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				await fs.writeFile(temporary, body, { mode: 0o600, flag: "wx", flush: true });
				await fs.rename(temporary, file);
			} finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
		},
	};
}

// Own just the first desktop window in this launch. Observations never prevent
// any native or web input. Closing/reopening the window is not another launch.
function startMessages(win, store, { fetchImpl = globalThis.fetch, windowMs = STARTUP_WINDOW_MS } = {}) {
	const { webContents } = win;
	const lifetime = new AbortController();
	const stop = () => lifetime.abort();
	const deadline = performance.now() + windowMs;
	const deadlineAt = Date.now() + windowMs;
	const timer = setTimeout(stop, windowMs);
	let resolveReady;
	const ready = new Promise(resolve => { resolveReady = resolve; });
	let didPaint = false;
	const onFocus = () => { if (didPaint && win.isFocused()) resolveReady(true); };
	const painted = () => { didPaint = true; onFocus(); };
	const onKey = (_event, input) => { if (input.type === "keyDown") stop(); };
	const onPointer = (_event, input) => { if (input.type === "mouseDown" || input.type === "mouseWheel") stop(); };
	let initialUrl;
	const onNavigate = details => {
		if (!details.isMainFrame) return;
		if (initialUrl === undefined) initialUrl = details.url;
		// Next.js hydration replaces history at the same URL. It is not a
		// route change; a reload or a different URL still cancels the offer.
		else if (!details.isSameDocument || details.url !== initialUrl) stop();
	};
	win.once("ready-to-show", painted);
	win.on("focus", onFocus);
	win.once("blur", stop);
	win.once("closed", stop);
	webContents.on("before-input-event", onKey);
	webContents.on("before-mouse-event", onPointer);
	webContents.on("did-start-navigation", onNavigate);
	let cancelOffer;
	const cancelled = new Promise(resolve => { cancelOffer = resolve; });
	lifetime.signal.addEventListener("abort", () => {
		cancelOffer(null);
		clearTimeout(timer);
		resolveReady(false);
		win.removeListener("ready-to-show", painted);
		win.removeListener("focus", onFocus);
		win.removeListener("blur", stop);
		win.removeListener("closed", stop);
		webContents.removeListener("before-input-event", onKey);
		webContents.removeListener("before-mouse-event", onPointer);
		webContents.removeListener("did-start-navigation", onNavigate);
	}, { once: true });
	// Let createWindow initiate the local navigation before doing any feed work.
	const candidate = Promise.resolve().then(() => lifetime.signal.aborted ? [] : Promise.all([fetchFeed(lifetime.signal, fetchImpl), store.read(), ready]))
		.then(([feed, ids, shown]) => shown && { message: selectMessage(feed, ids), ids })
		.catch(() => null);
	let requested = false;
	let offered = null;
	let dismissing;
	return {
		async take() {
			if (requested) return null;
			requested = true;
			const result = await Promise.race([candidate, cancelled]);
			if (result?.message && !lifetime.signal.aborted && performance.now() < deadline && !win.isDestroyed() && win.isFocused()) {
				offered = result;
			}
			stop();
			return offered ? { message: offered.message, deadlineAt } : null;
		},
		dismiss(id) {
			if (!offered || id !== offered.message.id) return false;
			return dismissing ??= store.write(new Set([...offered.ids, id])).then(() => true, () => {
				dismissing = undefined;
				return false;
			});
		},
	};
}

module.exports = { dismissalStore, selectMessage, startMessages };
