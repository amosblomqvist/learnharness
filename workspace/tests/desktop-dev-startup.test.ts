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

function boot(checkout = false, { appReady = Promise.resolve(), platform = checkout ? "win32" : "darwin", connected = checkout }: { appReady?: Promise<void>; platform?: string; connected?: boolean } = {}) {
	let ready!: () => void, fail!: (error: Error) => void;
	const readiness = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
	const windows: string[] = [], exits: number[] = [], logs: string[] = [], probes: { url: string; signal: AbortSignal }[] = [];
	const sent: unknown[] = [], signals: string[] = [], spawned: string[] = [];
	const checkoutChild = Object.assign(new EventEmitter(), {
		exitCode: null as number | null, signalCode: null, kill: (signal: string) => signals.push(signal),
	});
	let requestStop: (() => void) | undefined;
	let quitCount = 0;
	let window: FakeWindow | undefined;
	let markNavigated!: () => void;
	const navigated = new Promise<void>(resolve => { markNavigated = resolve; });
	const app = Object.assign(new EventEmitter(), {
		setName() {}, getPath: () => "/fixture/LearnHarness", setPath() {}, requestSingleInstanceLock: () => connected,
		quit() {
			this.emit("before-quit");
			let deferred = false;
			this.emit("will-quit", { preventDefault: () => { deferred = true; } });
			if (!deferred) quitCount++;
		},
		whenReady: () => appReady, exit: (code: number) => exits.push(code), isPackaged: false,
	});
	class FakeWindow extends EventEmitter {
		webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send() {}, getZoomFactor: () => 1 });
		visible = false;
		isVisible() { return this.visible; }
		show() { this.visible = true; this.emit("show"); }
		async loadURL(url: string) { window = this; windows.push(url); markNavigated(); }
	}
	const electron = {
		app, BrowserWindow: FakeWindow, nativeTheme: { themeSource: "system" }, ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
		Menu: { buildFromTemplate() {}, setApplicationMenu() {} },
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
	};
	const context = {
		require: (id: string) => id === "electron" ? electron : id === "node:fs" ? { mkdirSync() {}, appendFileSync() {} }
			: id === "./appearance-chrome.cjs" ? { ...mainRequire(id), readAppearance: () => ({ mode: "dark", background: "#141414" }) }
			: id === "./dev-server-readiness.cjs" ? { waitForDevServer: (url: string, { signal }: { signal: AbortSignal }) => {
				probes.push({ url, signal }); signal.addEventListener("abort", () => fail(signal.reason), { once: true }); return readiness;
			} } : id === "./checkout-server.cjs" ? { startCheckoutServer: (node: string) => (spawned.push(node), {
				child: checkoutChild, ready: readiness,
			}) } : id === "./checkout-restart.cjs" ? {
				pipeName: () => "fixture-pipe", listenForStop: async (_address: string, quit: () => void) => { requestStop = quit; },
			} : mainRequire(id),
		process: Object.assign(new EventEmitter(), {
			platform, argv: [], connected,
			env: { LH_DEV_URL: "http://localhost:3000", ...(checkout ? { LH_CHECKOUT_NODE: "fixture-node" } : {}) },
			send(message: unknown, callback?: () => void) { sent.push(message); callback?.(); },
		}),
		__dirname: dirname(mainFile), AbortController,
		setTimeout() {},
		console: { log: (line: string) => logs.push(line) },
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	const done = connected ? Promise.resolve() : runInNewContext("main()", context) as Promise<void>;
	return {
		app, windows, exits, logs, probes, ready, fail, done, signals, sent, spawned, checkoutChild, navigated,
		launcher: context.process, window: () => window, requestStop: () => requestStop!(), quitCount: () => quitCount,
	};
}

describe("real Electron main dev startup wiring", () => {
	it("does not create/load the window until readiness, and detaches its temporary quit listener", async () => {
		const f = boot(); await delay(0);
		assert.equal(f.probes.length, 1); assert.equal(f.probes[0]!.url, "http://localhost:3000"); assert.deepEqual(f.windows, []);
		f.ready(); await f.done;
		assert.deepEqual(f.windows, ["http://localhost:3000"]); assert.deepEqual(f.exits, []);
		assert.equal(f.app.listenerCount("before-quit"), 2, "server and Mobile Access cleanup remain; the temporary startup listener is detached");
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

for (const platform of ["win32", "linux"]) describe(`${platform} checkout desktop startup wiring`, () => {
	it("uses normal Electron shutdown and waits for the owned server before quitting for restart", async () => {
		const f = boot(true, { platform });
		f.ready(); await f.navigated;
		f.requestStop();
		assert.deepEqual(f.signals, ["SIGTERM"]);
		assert.equal(f.quitCount(), 0);
		f.checkoutChild.exitCode = 0;
		f.checkoutChild.emit("exit", 0);
		assert.equal(f.quitCount(), 1);
		assert.deepEqual(f.signals, ["SIGTERM"]);
	});

	it("uses only the owned server's readiness signal and detaches once the window loads and shows", async () => {
		const f = boot(true, { platform }); await delay(0);		assert.deepEqual(f.probes, []);
		assert.deepEqual(f.windows, []);
		f.ready(); await f.navigated;
		assert.deepEqual(f.windows, ["http://localhost:3000"]);
		const win = f.window()!;
		win.emit("ready-to-show");
		assert.equal(f.sent.length, 0);
		win.webContents.emit("did-finish-load");
		assert.equal((f.sent[0] as { type: string }).type, "checkout-window-open");
		f.launcher.emit("disconnect");
		assert.deepEqual(f.exits, []);
		f.app.emit("before-quit");
		assert.deepEqual(f.signals, ["SIGTERM"]);
	});

	it("starts the owned server before Electron is ready, still after the instance lock", async () => {
		let appReady!: () => void;
		const f = boot(true, { platform, appReady: new Promise<void>(resolve => { appReady = resolve; }) }); await delay(0);
		assert.deepEqual(f.spawned, ["fixture-node"]);
		f.ready(); await delay(0);
		assert.deepEqual(f.windows, [], "the window still waits for Electron");
		appReady();
		await f.navigated;
		assert.deepEqual(f.windows, ["http://localhost:3000"], JSON.stringify({ sent: f.sent, logs: f.logs }));
		assert.deepEqual(f.spawned, ["fixture-node"], "the server is started once");
	});

	it("reports a server failure that happens before Electron is ready", async () => {
		let appReady!: () => void;
		const f = boot(true, { platform, appReady: new Promise<void>(resolve => { appReady = resolve; }) }); await delay(0);
		f.fail(new Error("port already in use")); await delay(0);
		assert.equal(f.sent.length, 0, "the failure waits for Electron");
		appReady(); await delay(0);
		assert.deepEqual(f.windows, []);
		assert.equal((f.sent[0] as { message: string }).message, "port already in use");
		assert.deepEqual(f.exits, [1]);
	});

	it("reports owned server startup failures without navigating", async () => {
		const f = boot(true, { platform }); await delay(0);
		f.fail(new Error("port already in use")); await delay(0);
		assert.deepEqual(f.windows, []);
		assert.equal((f.sent[0] as { message: string }).message, "port already in use");
		assert.deepEqual(f.exits, [1]);
	});
});

describe("checkout mode platforms", () => {
	it("keeps macOS out of checkout mode even with a connected launcher", async () => {
		const f = boot(true, { platform: "darwin" }); await delay(0);
		assert.deepEqual(f.spawned, []);
		assert.equal(f.probes.length, 1, "macOS waits for an external dev server");
	});
});
