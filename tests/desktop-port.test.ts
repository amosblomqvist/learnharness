/** Stable desktop localhost port selection and Electron main wiring. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

type DesktopPortModule = {
	DEFAULT_DESKTOP_PORT: number;
	parsePreferredPort: (env?: Record<string, string | undefined>) => number;
	pickDesktopPort: (options?: {
		preferredPort?: number;
		env?: Record<string, string | undefined>;
		host?: string;
	}) => Promise<number>;
};

const loadDesktopPort = (): DesktopPortModule => mainRequire("./desktop-port.cjs");

async function holdPort(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const boundPort = (server.address() as AddressInfo).port;
	return {
		port: boundPort,
		close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
	};
}

async function allocateFreePort(): Promise<number> {
	const held = await holdPort(0);
	await held.close();
	return held.port;
}

describe("desktop localhost port selection", () => {
	it("parses valid LH_PORT overrides and falls back to DEFAULT_DESKTOP_PORT on invalid values", () => {
		const { DEFAULT_DESKTOP_PORT, parsePreferredPort } = loadDesktopPort();
		assert.equal(Number.isInteger(DEFAULT_DESKTOP_PORT), true);
		assert.ok(DEFAULT_DESKTOP_PORT >= 1024 && DEFAULT_DESKTOP_PORT <= 65535);
		assert.equal(parsePreferredPort({}), DEFAULT_DESKTOP_PORT);
		assert.equal(parsePreferredPort({ LH_PORT: "45123" }), 45123);
		assert.equal(parsePreferredPort({ LH_PORT: " 45123 " }), 45123);
		assert.equal(parsePreferredPort({ LH_PORT: "1" }), 1);
		assert.equal(parsePreferredPort({ LH_PORT: "65535" }), 65535);
		for (const invalid of ["", "   ", "abc", "0", "-1", "65536", "99999", "43127.5", "43127px", "0x100"]) {
			assert.equal(parsePreferredPort({ LH_PORT: invalid }), DEFAULT_DESKTOP_PORT, `invalid LH_PORT=${JSON.stringify(invalid)}`);
		}
	});

	it("returns the same preferred port across consecutive launches and leaves no socket open", async () => {
		const { pickDesktopPort } = loadDesktopPort();
		const preferred = await allocateFreePort();

		const first = await pickDesktopPort({ preferredPort: preferred });
		const second = await pickDesktopPort({ preferredPort: preferred });
		assert.equal(first, preferred);
		assert.equal(second, preferred);

		// Proves no listening socket was leaked by pickDesktopPort.
		const probe = await holdPort(preferred);
		await probe.close();
	});

	it("falls back to an ephemeral free port when the preferred port is in use", async () => {
		const { pickDesktopPort } = loadDesktopPort();
		const occupied = await holdPort(0);
		try {
			const picked = await pickDesktopPort({ preferredPort: occupied.port });
			assert.notEqual(picked, occupied.port);
			assert.ok(Number.isInteger(picked) && picked > 0 && picked <= 65535);

			// Proves the fallback probe closed its temporary socket cleanly.
			const probe = await holdPort(picked);
			await probe.close();
		} finally {
			await occupied.close();
		}
	});

	it("honors LH_PORT when free and falls back cleanly when LH_PORT is occupied", async () => {
		const { pickDesktopPort } = loadDesktopPort();
		const free = await allocateFreePort();
		assert.equal(await pickDesktopPort({ env: { LH_PORT: String(free) } }), free);

		const occupied = await holdPort(0);
		try {
			const fallback = await pickDesktopPort({ env: { LH_PORT: String(occupied.port) } });
			assert.notEqual(fallback, occupied.port);
			assert.ok(Number.isInteger(fallback) && fallback > 0 && fallback <= 65535);
		} finally {
			await occupied.close();
		}
	});
});

describe("Electron main packaged server port wiring", () => {
	it("passes the stable picked port to both the spawned server and the window origin", async () => {
		const preferred = await allocateFreePort();
		const spawnedPorts: (string | undefined)[] = [];
		const loadedUrls: string[] = [];
		const app = Object.assign(new EventEmitter(), {
			setName() {},
			getPath: () => "/fixture/LearnHarness",
			setPath() {},
			requestSingleInstanceLock: () => false,
			quit() {},
			whenReady: async () => {},
			isPackaged: false,
		});
		class FakeWindow extends EventEmitter {
			static getAllWindows() { return []; }
			webContents = Object.assign(new EventEmitter(), {
				id: 1,
				mainFrame: { url: "" },
				setWindowOpenHandler() {},
				send() {},
				getZoomFactor: () => 1,
				isDestroyed: () => false,
			});
			isDestroyed() { return false; }
			loadURL(url: string) { loadedUrls.push(url); }
			setBackgroundColor() {}
			setTitleBarOverlay() {}
		}
		const electron = {
			app,
			BrowserWindow: FakeWindow,
			nativeTheme: { themeSource: "system", shouldUseDarkColors: true, on() {} },
			ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
			Menu: { buildFromTemplate() {}, setApplicationMenu() {} },
			session: {
				defaultSession: {
					setPermissionRequestHandler() {},
					setPermissionCheckHandler() {},
					webRequest: { onBeforeSendHeaders() {} },
				},
			},
			shell: { openExternal() {} },
			dialog: {},
		};
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			connected: true,
			kill() {},
		});
		const context = {
			require: (id: string) => {
				if (id === "electron") return electron;
				if (id === "node:fs") return { existsSync: () => false, mkdirSync() {}, appendFileSync() {} };
				if (id === "node:child_process") {
					return {
						spawn(_bin: string, _args: string[], options: { env: Record<string, string> }) {
							spawnedPorts.push(options.env.PORT);
							return child;
						},
					};
				}
				if (id === "node:http") {
					return {
						get(_url: string, cb: (res: { statusCode: number; resume: () => void }) => void) {
							queueMicrotask(() => cb({ statusCode: 200, resume() {} }));
							return new EventEmitter();
						},
					};
				}
				if (id === "./appearance-chrome.cjs") {
					return { ...mainRequire(id), readAppearance: () => ({ mode: "dark", background: "#141414" }) };
				}
				if (id === "./chatgpt.cjs") {
					return { createChatGPT: () => ({ pause() {}, resume() {}, close() {} }), fileStore: () => ({}) };
				}
				if (id === "./chatgpt-ipc.cjs") {
					return { ...mainRequire(id), attachChatGPTChild: () => ({ dispose() {} }) };
				}
				if (id === "./subscriptions.cjs") {
					return {
						createSubscriptions: () => ({ ready: Promise.resolve(), pause() {}, resume() {}, close() {} }),
						loadSubscriptionSDK: () => null,
					};
				}
				if (id === "./subscription-ipc.cjs") {
					return { ...mainRequire(id), attachSubscriptionChild: () => ({ dispose() {} }) };
				}
				return mainRequire(id);
			},
			process: Object.assign(new EventEmitter(), {
				platform: "linux",
				argv: [],
				execPath: "/fixture/electron",
				resourcesPath: "/fixture/resources",
				env: { LH_PORT: String(preferred) },
			}),
			__dirname: dirname(mainFile),
			AbortController,
			URL,
			console: { log() {} },
			setTimeout,
			clearTimeout,
			setInterval: () => 0,
		};

		runInNewContext(mainSource, context, { filename: mainFile });
		await (runInNewContext("main()", context) as Promise<void>);

		assert.deepEqual(spawnedPorts, [String(preferred)]);
		assert.deepEqual(loadedUrls, [`http://127.0.0.1:${preferred}`]);
	});
});
