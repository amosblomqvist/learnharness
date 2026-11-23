/** Packaged shell startup reliability and the REAL main-process boot path, without a display. */
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
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	connected = true;
	kills: string[] = [];
	kill(signal: string) {
		this.kills.push(signal);
		return true;
	}
	send() {}
}

type BootOptions = {
	singleInstanceLock?: boolean;
	port?: number;
	netError?: Error;
	onSpawn?: (child: FakeChild, port: string) => void;
};

function bootPackaged(options: BootOptions = {}) {
	const windows: string[] = [];
	const exits: number[] = [];
	const logs: string[] = [];
	const children: FakeChild[] = [];
	const timers: { delay: number; unrefd: boolean; handle: ReturnType<typeof setTimeout> }[] = [];
	let chatgptClosed = 0;
	let subscriptionsClosed = 0;
	let resolveExit!: (code: number) => void;
	const exitPromise = new Promise<number>(resolve => { resolveExit = resolve; });

	const app = Object.assign(new EventEmitter(), {
		isPackaged: true,
		name: "LearnHarness",
		setName() {},
		getPath: () => "/fixture/LearnHarness",
		setPath() {},
		requestSingleInstanceLock: () => options.singleInstanceLock ?? false,
		quit() {},
		whenReady: async () => {},
		exit(code: number) {
			exits.push(code);
			resolveExit(code);
		},
	});

	class FakeWindow extends EventEmitter {
		static getAllWindows() { return []; }
		static fromWebContents() { return undefined; }
		webContents = Object.assign(new EventEmitter(), {
			setWindowOpenHandler() {},
			send() {},
			getZoomFactor: () => 1,
		});
		loadURL(url: string) { windows.push(url); }
		isDestroyed() { return false; }
		show() {}
	}

	const electron = {
		app,
		BrowserWindow: FakeWindow,
		nativeTheme: { themeSource: "system" },
		ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
		Menu: { buildFromTemplate: (value: unknown) => value, setApplicationMenu() {} },
		session: {
			defaultSession: {
				setPermissionRequestHandler() {},
				setPermissionCheckHandler() {},
				webRequest: { onBeforeSendHeaders() {} },
			},
		},
		shell: { openExternal: async () => {} },
		dialog: {},
	};

	const trackedSetTimeout = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
		const handle = setTimeout(fn, ms, ...args);
		const record = { delay: ms ?? 0, unrefd: false, handle };
		timers.push(record);
		const originalUnref = handle.unref.bind(handle);
		handle.unref = () => {
			record.unrefd = true;
			return originalUnref();
		};
		return handle;
	};

	const netOverride = options.netError
		? {
			createServer: () => {
				const srv = Object.assign(new EventEmitter(), {
					listen() { queueMicrotask(() => srv.emit("error", options.netError)); },
					close(cb?: () => void) { cb?.(); },
				});
				return srv;
			},
		}
		: options.port !== undefined
			? {
				createServer: () => Object.assign(new EventEmitter(), {
					listen(_port: number, _host: string, cb: () => void) { cb(); },
					address: () => ({ port: options.port }),
					close(cb: () => void) { cb(); },
				}),
			}
			: undefined;

	const fakeProcess = Object.assign(new EventEmitter(), {
		platform: "linux",
		argv: [],
		env: {},
		execPath: "/fixture/electron",
		resourcesPath: "/fixture/resources",
	});

	const context = {
		require: (id: string) => {
			if (id === "electron") return electron;
			if (id === "electron-updater") throw new Error("not installed in unit fixture");
			if (id === "node:fs") return { existsSync: () => false, mkdirSync() {}, appendFileSync() {} };
			if (id === "node:net" && netOverride) return netOverride;
			if (id === "node:child_process") {
				return {
					spawn: (_cmd: string, _args: string[], spawnOpts?: { env?: Record<string, string> }) => {
						const child = new FakeChild();
						children.push(child);
						options.onSpawn?.(child, spawnOpts?.env?.PORT ?? "");
						return child;
					},
				};
			}
			if (id === "./appearance-chrome.cjs") {
				return { ...mainRequire(id), readAppearance: () => ({ mode: "dark", background: "#141414" }) };
			}
			if (id === "./chatgpt.cjs") {
				return {
					fileStore: () => ({}),
					createChatGPT: () => ({
						close() { chatgptClosed++; },
						pause() {},
						resume() {},
						stamp: () => ({}),
					}),
				};
			}
			if (id === "./subscriptions.cjs") {
				return {
					loadSubscriptionSDK: async () => null,
					createSubscriptions: () => ({
						ready: Promise.resolve(),
						close() { subscriptionsClosed++; },
						pause() {},
						resume() {},
					}),
				};
			}
			if (id === "./startup-messages.cjs") {
				return {
					dismissalStore: () => ({}),
					startMessages: () => ({ take: () => null, dismiss: () => false }),
				};
			}
			return mainRequire(id);
		},
		process: fakeProcess,
		__dirname: dirname(mainFile),
		AbortController,
		URL,
		setTimeout: trackedSetTimeout,
		clearTimeout,
		setInterval: () => ({ unref() {} }),
		clearInterval,
		console: { log: (line: string) => logs.push(line) },
	};

	runInNewContext(mainSource, context, { filename: mainFile });
	const done = options.singleInstanceLock ? undefined : (runInNewContext("main()", context) as Promise<void>);
	const cleanupTimers = () => {
		for (const t of timers) clearTimeout(t.handle);
	};

	return {
		app,
		windows,
		exits,
		logs,
		children,
		timers,
		context,
		done,
		exitPromise,
		cleanupTimers,
		get chatgptClosed() { return chatgptClosed; },
		get subscriptionsClosed() { return subscriptionsClosed; },
		serverProcess: () => runInNewContext("serverProcess", context),
	};
}

async function endpoint(
	reply: http.RequestListener,
	test: (port: number, url: string, idle: () => Promise<void>) => Promise<void>,
) {
	const server = http.createServer(reply);
	const sockets = new Set<Socket>();
	server.on("connection", socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const url = `http://127.0.0.1:${port}`;
	try {
		await test(port, url, async () => {
			const deadline = Date.now() + 1000;
			while (sockets.size && Date.now() < deadline) await delay(10);
			assert.equal(sockets.size, 0, "packaged startup left an HTTP connection open");
		});
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

describe("packaged Electron startup reliability", () => {
	it("fails fast on immediate server exit (code 1), logs failure, exits 1, and detaches temporary quit listener", async () => {
		const start = Date.now();
		const f = bootPackaged({
			onSpawn(child) {
				queueMicrotask(() => {
					child.exitCode = 1;
					child.emit("exit", 1, null);
				});
			},
		});
		try {
			await f.done;
			const elapsed = Date.now() - start;
			assert.ok(elapsed < 500, `expected fast fail <500ms, took ${elapsed}ms`);
			assert.deepEqual(f.windows, []);
			assert.deepEqual(f.exits, [1]);
			assert.equal(f.serverProcess(), null);
			assert.ok(f.chatgptClosed >= 1);
			assert.ok(f.subscriptionsClosed >= 1);
			assert.ok(f.logs.some(line => /packaged server startup failed:.*code=1/.test(line)));
			assert.ok(!f.logs.some(line => line.includes("uncaught:")));
			assert.equal(f.app.listenerCount("before-quit"), 1, "only the persistent killServer listener should remain");
			assert.equal(f.children[0]!.listenerCount("exit"), 1);
			assert.equal(f.children[0]!.listenerCount("error"), 1);
		} finally {
			f.cleanupTimers();
		}
	});

	it("fails fast on server exit occurring while waitUntilUp is polling", async () => {
		const start = Date.now();
		const f = bootPackaged({
			onSpawn(child) {
				setTimeout(() => {
					child.exitCode = 1;
					child.emit("exit", 1, null);
				}, 15);
			},
		});
		try {
			await f.done;
			const elapsed = Date.now() - start;
			assert.ok(elapsed < 500, `expected fast fail <500ms, took ${elapsed}ms`);
			assert.deepEqual(f.windows, []);
			assert.deepEqual(f.exits, [1]);
			assert.ok(f.logs.some(line => /packaged server startup failed:.*code=1/.test(line)));
			assert.equal(f.app.listenerCount("before-quit"), 1);
			assert.equal(f.children[0]!.listenerCount("exit"), 1);
			assert.equal(f.children[0]!.listenerCount("error"), 1);
		} finally {
			f.cleanupTimers();
		}
	});

	for (const timing of ["immediate", "delayed"] as const) {
		it(`fails fast with no unhandled error on ${timing} child spawn error (ENOENT)`, async () => {
			const start = Date.now();
			const err = Object.assign(new Error("spawn /fixture/electron ENOENT"), { code: "ENOENT" });
			const f = bootPackaged({
				onSpawn(child) {
					const emitError = () => child.emit("error", err);
					if (timing === "immediate") queueMicrotask(emitError);
					else setTimeout(emitError, 15);
				},
			});
			try {
				await f.done;
				const elapsed = Date.now() - start;
				assert.ok(elapsed < 500, `expected fast fail <500ms, took ${elapsed}ms`);
				assert.deepEqual(f.windows, []);
				assert.deepEqual(f.exits, [1]);
				assert.equal(f.serverProcess(), null);
				assert.deepEqual(f.children[0]!.kills, []);
				assert.ok(f.logs.some(line => /server spawn error:.*ENOENT/.test(line)));
				assert.ok(f.logs.some(line => /packaged server startup failed:.*ENOENT/.test(line)));
				assert.ok(!f.logs.some(line => line.includes("uncaught:")));
				assert.equal(f.app.listenerCount("before-quit"), 1);
				assert.equal(f.children[0]!.listenerCount("exit"), 1);
				assert.equal(f.children[0]!.listenerCount("error"), 1);
			} finally {
				f.cleanupTimers();
			}
		});
	}

	it("aborts cleanly when before-quit fires during packaged startup without calling app.exit(1)", async () => {
		let requestStarted!: () => void;
		const received = new Promise<void>(resolve => { requestStarted = resolve; });
		await endpoint(() => { requestStarted(); }, async (port, _url, idle) => {
			const start = Date.now();
			const f = bootPackaged({ port });
			try {
				await received;
				f.app.emit("before-quit");
				await f.done;
				const elapsed = Date.now() - start;
				assert.ok(elapsed < 500, `expected abort <500ms, took ${elapsed}ms`);
				assert.deepEqual(f.windows, []);
				assert.deepEqual(f.exits, []);
				assert.deepEqual(f.children[0]!.kills, ["SIGTERM"]);
				assert.ok(f.timers.some(t => t.delay === 3000 && t.unrefd), "SIGKILL fallback timer must be unref'd");
				assert.equal(f.app.listenerCount("before-quit"), 1);
				await idle();
			} finally {
				f.cleanupTimers();
			}
		});
	});

	it("catches pre-server startup failures via main().catch(...) when holding the single-instance lock", async () => {
		const f = bootPackaged({
			singleInstanceLock: true,
			netError: Object.assign(new Error("listen EACCES: permission denied 127.0.0.1"), { code: "EACCES" }),
		});
		try {
			const code = await Promise.race([
				f.exitPromise,
				delay(500).then(() => { throw new Error("timed out waiting for app.exit(1)"); }),
			]);
			assert.equal(code, 1);
			assert.deepEqual(f.exits, [1]);
			assert.deepEqual(f.windows, []);
			assert.deepEqual(f.children, []);
			assert.ok(f.logs.some(line => /startup failed:.*EACCES/.test(line)));
			assert.ok(!f.logs.some(line => line.includes("uncaught:")));
		} finally {
			f.cleanupTimers();
		}
	});

	it("opens the window once the packaged server responds and cleans up temporary listeners", async () => {
		await endpoint((_req, res) => { res.writeHead(200); res.end("ok"); }, async (port, url) => {
			const f = bootPackaged({ port });
			try {
				await f.done;
				assert.deepEqual(f.windows, [url]);
				assert.deepEqual(f.exits, []);
				assert.equal(f.app.listenerCount("before-quit"), 1);
				assert.equal(f.children[0]!.listenerCount("exit"), 1);
				assert.equal(f.children[0]!.listenerCount("error"), 1);
				// Backwards-compatible waitUntilUp(url) and waitUntilUp(url, tries) signatures still work.
				const ok = await (runInNewContext(`waitUntilUp(${JSON.stringify(url)})`, f.context) as Promise<boolean>);
				assert.equal(ok, true);
			} finally {
				f.cleanupTimers();
			}
		});
	});
});
