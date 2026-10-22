/** Execute the real helper entry with fake Electron; no display or user profile. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { stopBrowserService } from "../scripts/smoke-demo-runtime.mjs";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const requireMain = createRequire(mainFile);

function helperFixture(connected = true, channel = true) {
	let allowAppReady!: () => void;
	const appReady = new Promise<void>((resolve) => { allowAppReady = resolve; });
	let allowReadiness!: () => void;
	const readiness = new Promise<void>((resolve) => { allowReadiness = resolve; });
	const state = { quits: 0, exits: [] as number[], windows: 0, readinessCalls: 0, stdinReads: 0, signal: undefined as AbortSignal | undefined };
	const logs: string[] = [];
	const errors: string[] = [];
	// Match Electron 44's Windows override, not a native pipe.
	const stdin = new Readable({ read() {} });
	stdin.push(null);
	const process = Object.assign(new EventEmitter(), {
		platform: "win32", argv: ["electron", "--browser-service"], env: {},
		connected, channel: channel ? {} : undefined,
	});
	Object.defineProperty(process, "stdin", { get() { state.stdinReads++; return stdin; } });
	const app = {
		setName() {}, commandLine: { appendSwitch() {} }, whenReady: () => appReady,
		quit() { state.quits++; }, exit(code: number) { state.exits.push(code); },
	};
	class FakeWindow {
		constructor() { state.windows++; }
		async loadURL(url: string) { assert.equal(url, "about:blank"); }
	}
	const net = {
		createServer: () => Object.assign(new EventEmitter(), {
			listen(_port: number, _host: string, callback: () => void) { callback(); },
			address: () => ({ port: 54321 }), close(callback: () => void) { callback(); },
		}),
	};
	const waitForBrowserService = (_port: number, { signal }: { signal: AbortSignal }) => {
		state.readinessCalls++;
		state.signal = signal;
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			readiness.then(resolve);
		});
	};
	runInNewContext(mainSource, {
		require: (id: string) => id === "electron" ? { app, BrowserWindow: FakeWindow }
			: id === "node:net" ? net
			: id === "./browser-service-readiness.cjs" ? { waitForBrowserService }
			: requireMain(id),
		process, __dirname: dirname(mainFile), AbortController,
		console: { log: (line: string) => logs.push(line), error: (...parts: unknown[]) => errors.push(parts.join(" ")) },
	}, { filename: mainFile });
	return {
		state, logs, errors, stdin, process, allowAppReady, allowReadiness,
		disconnect() { process.connected = false; process.emit("disconnect"); },
	};
}

describe("browser-service IPC-owned lifetime", () => {
	it("ignores synthetic Windows stdin EOF while IPC remains connected", async () => {
		const helper = helperFixture();
		helper.stdin.resume();
		await turn();
		assert.equal(helper.stdin.readableEnded, true);
		assert.equal(helper.state.stdinReads, 0);
		assert.equal(helper.state.quits, 0);
		helper.allowAppReady();
		await turn();
		assert.equal(helper.state.readinessCalls, 1);
		assert.equal(helper.state.signal?.aborted, false);
		helper.allowReadiness();
		await turn();
		assert.deepEqual(helper.logs, ["BROWSER_SERVICE_CDP 54321"]);
		assert.deepEqual(helper.state.exits, []);
		helper.disconnect();
		assert.equal(helper.state.quits, 1);
	});

	it("disconnect during readiness aborts it, quits once, and never announces", async () => {
		const helper = helperFixture();
		helper.allowAppReady();
		await turn();
		assert.equal(helper.state.readinessCalls, 1);
		helper.disconnect();
		helper.disconnect();
		await turn();
		assert.equal(helper.state.signal?.aborted, true);
		assert.equal(helper.state.quits, 1);
		assert.deepEqual(helper.logs, []);
		assert.deepEqual(helper.errors, []);
		assert.deepEqual(helper.state.exits, []);
		assert.equal(helper.state.stdinReads, 0);
	});

	it("owns disconnect before app.whenReady resolves", async () => {
		const helper = helperFixture();
		helper.disconnect();
		await turn();
		assert.equal(helper.state.quits, 1);
		assert.equal(helper.state.windows, 0);
		assert.deepEqual(helper.logs, []);
	});

	it("fails closed without both a connected IPC channel and connection state", async () => {
		for (const [connected, channel] of [[false, false], [true, false], [false, true]]) {
			const helper = helperFixture(connected, channel);
			await turn();
			assert.deepEqual(helper.state.exits, [1]);
			assert.match(helper.errors.join("\n"), /requires connected parent IPC/);
			assert.equal(helper.state.windows, 0);
			assert.equal(helper.state.readinessCalls, 0);
			assert.equal(helper.state.stdinReads, 0);
			assert.equal(helper.process.listenerCount("disconnect"), 0);
		}
	});
});

describe("browser-service probe cleanup", () => {
	it("requests IPC disconnect and accepts actual exit without a close event", async () => {
		const helper = Object.assign(new EventEmitter(), {
			pid: 123, connected: true, exitCode: null as number | null, signalCode: null,
			disconnect() {
				helper.connected = false;
				queueMicrotask(() => { helper.exitCode = 0; helper.emit("exit", 0, null); });
			},
		});
		assert.deepEqual(await stopBrowserService(helper), { code: 0, signal: null, requested: true });
		assert.equal(helper.listenerCount("exit"), 0);
		assert.equal(helper.listenerCount("error"), 0);
	});

	it("does not label an already-exited helper as parent-requested shutdown", async () => {
		const helper = { pid: 123, connected: false, exitCode: 0, signalCode: null,
			disconnect() { assert.fail("must not request shutdown after early exit"); } };
		assert.deepEqual(await stopBrowserService(helper), { code: 0, signal: null, requested: false });
	});
});
