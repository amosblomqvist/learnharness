/** Dev shell readiness and the REAL main-process boot path, without a display. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8"), mainRequire = createRequire(mainFile);
type Options = { signal?: AbortSignal; timeoutMs?: number; retryMs?: number };
const waitForDevServer = (url: string, options?: Options): Promise<void> => mainRequire("./dev-server-readiness.cjs").waitForDevServer(url, options);
const short = { timeoutMs: 200, retryMs: 10 };
async function endpoint(reply: http.RequestListener, test: (url: string, idle: () => Promise<void>) => Promise<void>) {
	const server = http.createServer(reply), sockets = new Set<Socket>();
	server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	try {
		await test(url, async () => {
			const deadline = Date.now() + 1000;
			while (sockets.size && Date.now() < deadline) await delay(10);
			assert.equal(sockets.size, 0, "readiness left an HTTP connection open");
		});
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe("development server readiness", () => {
	it("accepts a running server and stops probing after success", async () => {
		let requests = 0;
		await endpoint((_req, res) => { requests++; res.end("ready"); }, async (url, idle) => {
			await waitForDevServer(url, { ...short, timeoutMs: 2000 }); await idle(); await delay(40);
			assert.equal(requests, 1);
		});
	});
	it("waits for a server that starts after the shell (the cold core-build race)", async () => {
		const server = http.createServer((_req, res) => res.end("ready"));
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		await new Promise<void>(resolve => server.close(() => resolve()));
		let ready = false;
		const waiting = waitForDevServer(`http://127.0.0.1:${port}/`, { timeoutMs: 2000, retryMs: 10 }).then(() => { ready = true; });
		try {
			await delay(40); assert.equal(ready, false);
			await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve)); await waiting;
		} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
	});
	it("allows a cold route to compile without repeated requests, and accepts its development error page", async () => {
		let respond!: () => void, started!: () => void, requests = 0;
		const received = new Promise<void>(resolve => { started = resolve; });
		await endpoint((_req, res) => { requests++; respond = () => { res.writeHead(500); res.end("Next development error overlay"); }; started(); }, async (url, idle) => {
			let ready = false;
			const waiting = waitForDevServer(url, { timeoutMs: 2000, retryMs: 10 }).then(() => { ready = true; });
			await received; await delay(40); assert.equal(ready, false); assert.equal(requests, 1);
			respond(); await waiting; await idle();
		});
	});
	it("bounds hung connections by the TOTAL deadline and cleans up without further retries", async () => {
		let requests = 0;
		await endpoint(() => { requests++; }, async (url, idle) => {
			const start = Date.now();
			await assert.rejects(waitForDevServer(url, short), /Development server .* did not respond within 200ms/);
			assert.ok(Date.now() - start < 2000); await idle(); await delay(40); assert.equal(requests, 1);
		});
	});
	it("times out a refused connection with an actionable endpoint and last cause", async () => {
		await endpoint((_req, res) => res.end(), async url => {
			// Use an unbound local port, without assuming any fixed port is free.
			const reserve = http.createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
			const absent = url.replace(new URL(url).port, String((reserve.address() as AddressInfo).port));
			await new Promise<void>(resolve => reserve.close(() => resolve()));
			await assert.rejects(waitForDevServer(absent, short), (error: Error) => {
				assert.ok(error.message.includes(absent)); assert.match(String(error.cause), /ECONNREFUSED/); return true;
			});
		});
	});
	it("cancels active requests and retry timers when the application quits", async () => {
		const controller = new AbortController(); let started!: () => void, requests = 0;
		const received = new Promise<void>(resolve => { started = resolve; });
		await endpoint(() => { requests++; started(); }, async (url, idle) => {
			const waiting = waitForDevServer(url, { signal: controller.signal, ...short, timeoutMs: 2000 });
			await received; controller.abort(new Error("application quit"));
			await assert.rejects(waiting, /application quit/); await idle(); await delay(40); assert.equal(requests, 1);
		});
	});
	it("cancels a scheduled retry after a connection reset", async () => {
		const controller = new AbortController(); let started!: () => void, requests = 0;
		const received = new Promise<void>(resolve => { started = resolve; });
		await endpoint((_req, res) => { requests++; res.destroy(); started(); }, async (url, idle) => {
			const waiting = waitForDevServer(url, { signal: controller.signal, timeoutMs: 2000, retryMs: 200 });
			await received; await delay(30); controller.abort(new Error("quit during retry"));
			await assert.rejects(waiting, /quit during retry/); await idle(); await delay(250); assert.equal(requests, 1);
		});
	});
	it("does not contact the endpoint after an already-cancelled startup", async () => {
		const controller = new AbortController(); controller.abort(new Error("already quit")); let requests = 0;
		await endpoint(() => { requests++; }, async url => {
			await assert.rejects(waitForDevServer(url, { signal: controller.signal }), /already quit/); await delay(40); assert.equal(requests, 0);
		});
	});
});

function boot() {
	let ready!: () => void, fail!: (error: Error) => void;
	const readiness = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
	const windows: string[] = [], exits: number[] = [], logs: string[] = [], probes: { url: string; signal: AbortSignal }[] = [];
	const app = Object.assign(new EventEmitter(), {
		setName() {}, getPath: () => "/fixture/LearnHarness", setPath() {}, requestSingleInstanceLock: () => false,
		quit() {}, whenReady: async () => {}, exit: (code: number) => exits.push(code), isPackaged: false,
	});
	class FakeWindow extends EventEmitter {
		webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send() {}, getZoomFactor: () => 1 });
		loadURL(url: string) { windows.push(url); }
	}
	const electron = {
		app, BrowserWindow: FakeWindow, ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
		Menu: { buildFromTemplate() {}, setApplicationMenu() {} },
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
	};
	const context = {
		require: (id: string) => id === "electron" ? electron : id === "node:fs" ? { mkdirSync() {}, appendFileSync() {} }
			: id === "./dev-server-readiness.cjs" ? { waitForDevServer: (url: string, { signal }: { signal: AbortSignal }) => {
				probes.push({ url, signal }); signal.addEventListener("abort", () => fail(signal.reason), { once: true }); return readiness;
			} } : mainRequire(id),
		process: Object.assign(new EventEmitter(), { platform: "darwin", argv: [], env: { LH_DEV_URL: "http://localhost:3000" } }),
		__dirname: dirname(mainFile), AbortController,
		console: { log: (line: string) => logs.push(line) },
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	const done = runInNewContext("main()", context) as Promise<void>;
	return { app, windows, exits, logs, probes, ready, fail, done };
}

describe("real Electron main dev startup wiring", () => {
	it("does not create/load the window until readiness, and detaches its temporary quit listener", async () => {
		const f = boot(); await delay(0);
		assert.equal(f.probes.length, 1); assert.equal(f.probes[0]!.url, "http://localhost:3000"); assert.deepEqual(f.windows, []);
		f.ready(); await f.done;
		assert.deepEqual(f.windows, ["http://localhost:3000"]); assert.deepEqual(f.exits, []);
		assert.equal(f.app.listenerCount("before-quit"), 1, "only the existing server cleanup listener should remain");
	});
	it("logs and exits unsuccessfully on readiness failure instead of creating an empty window", async () => {
		const f = boot(); await delay(0); assert.equal(f.probes.length, 1);
		f.fail(new Error("Development server http://localhost:3000 did not respond within 30000ms")); await f.done;
		assert.deepEqual(f.windows, []); assert.deepEqual(f.exits, [1]);
		assert.ok(f.logs.some(line => /dev server startup failed:.*did not respond within 30000ms/.test(line)));
		assert.equal(f.app.listenerCount("before-quit"), 1);
	});
	it("user quit aborts startup without a new window or failure exit", async () => {
		const f = boot(); await delay(0); assert.equal(f.probes.length, 1);
		f.app.emit("before-quit"); await f.done;
		assert.equal(f.probes[0]!.signal.aborted, true); assert.deepEqual(f.windows, []); assert.deepEqual(f.exits, []);
		assert.equal(f.app.listenerCount("before-quit"), 1);
	});
	it("does not open a window if quit races the successful response", async () => {
		const f = boot(); await delay(0); assert.equal(f.probes.length, 1);
		f.ready(); f.app.emit("before-quit"); await f.done;
		assert.deepEqual(f.windows, []); assert.deepEqual(f.exits, []);
	});
});
