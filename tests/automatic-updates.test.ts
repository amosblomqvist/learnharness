/** Actual shell functions with fake Electron/updater/filesystem. No app,
 * profile, network, timer or updater download/install operation is run. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

function fixture({ packaged = true, updaterMissing = false } = {}) {
	let settings: string | Error = JSON.stringify({ version: 1, general: { autoUpdate: true } });
	const settingsReads: string[] = [];
	const order: string[] = [];
	const intervals: { callback: () => void; delay: number }[] = [];
	const handles = new Map<string, (event: unknown) => unknown>();
	const windows: FakeWindow[] = [];
	let enumerationFails = false;
	let userData = "/fixture/custom-user-data";
	let menu: { submenu?: { label?: string; click?: () => void }[] }[] = [];
	class FakeUpdater extends EventEmitter {
		checks = 0;
		autoDownload = false;
		autoInstallOnAppQuit = false;
		result: object | null = { updateInfo: { version: "0.3.7" } };
		failure: Error | null = null;
		checkForUpdates() {
			this.checks++;
			this.emit("checking-for-update");
			if (this.failure) return Promise.reject(this.failure);
			if (this.result) this.emit("update-not-available", { version: "0.3.7" });
			return Promise.resolve(this.result);
		}
		quitAndInstall() { order.push("install"); }
	}
	const updater = new FakeUpdater();
	class FakeWebContents extends EventEmitter {
		mainFrame = { url: "http://127.0.0.1:9000/" };
		messages: { channel: string; value: unknown }[] = [];
		loading = false;
		fails = false;
		send(channel: string, value: unknown) {
			if (this.fails) throw new Error("window destroyed");
			this.messages.push({ channel, value: JSON.parse(JSON.stringify(value)) });
		}
		isLoadingMainFrame() { return this.loading; }
		setWindowOpenHandler() {}
		getZoomFactor() { return 1; }
	}
	class FakeWindow extends EventEmitter {
		webContents = new FakeWebContents();
		minimized = false;
		focused = false;
		constructor() { super(); windows.push(this); }
		loadURL() { this.webContents.loading = true; }
		isMinimized() { return this.minimized; }
		restore() { this.minimized = false; }
		focus() { this.focused = true; }
		show() {}
		static getAllWindows() {
			if (enumerationFails) throw new Error("window enumeration failed");
			return windows;
		}
		static fromWebContents(contents: FakeWebContents) { return windows.find(win => win.webContents === contents); }
	}
	const app = Object.assign(new EventEmitter(), {
		isPackaged: packaged,
		name: "LearnHarness",
		setName() {},
		getPath: () => userData,
		setPath: (_: string, value: string) => { userData = value; },
		requestSingleInstanceLock: () => false,
		quit() {},
		whenReady: async () => {},
	});
	const electron = {
		app, BrowserWindow: FakeWindow,
		Menu: { buildFromTemplate: (value: typeof menu) => value, setApplicationMenu: (value: typeof menu) => { menu = value; } },
		ipcMain: { on() {}, handle: (channel: string, fn: (event: unknown) => unknown) => handles.set(channel, fn) },
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
	};
	const context = createContext({
		require: (id: string) => {
			if (id === "electron") return electron;
			if (id === "electron-updater") {
				if (updaterMissing) throw new Error("missing updater");
				return { autoUpdater: updater };
			}
			if (id === "node:fs") return {
				readFileSync: (file: string) => {
					settingsReads.push(file);
					if (settings instanceof Error) throw settings;
					return settings;
				}, mkdirSync() {}, appendFileSync() {},
			};
			return mainRequire(id);
		},
		process: { argv: [], env: { LH_DEV_URL: "http://127.0.0.1:9000" }, platform: "darwin", on() {} },
		__dirname: path.dirname(mainFile), URL,
		setInterval: (callback: () => void, delay: number) => intervals.push({ callback, delay }),
		setTimeout() {},
		fixtureChild: { kill: (signal: string) => order.push(signal) },
	});
	runInContext(mainSource, context, { filename: mainFile });
	const run = (code: string) => runInContext(code, context);
	return {
		run, updater, windows, intervals, handles, settingsReads, order, app,
		setSettings: (value: unknown) => { settings = JSON.stringify(value); },
		setSettingsFailure: (value: string | Error) => { settings = value; },
		setEnumerationFailure: (value: boolean) => { enumerationFails = value; },
		window: () => new FakeWindow(),
		state: () => JSON.parse(JSON.stringify(run("updateState"))),
		check: async (manual = false) => { run(`checkForUpdates({ manual: ${manual} })`); await Promise.resolve(); await Promise.resolve(); },
		menuCheck: () => menu[0]!.submenu!.find(item => item.label === "Check for Updates…")!.click!(),
	};
}

describe("automatic-update preference gate", () => {
	it("explicit OFF skips automatic checks, but manual checks still run without reading the preference", async () => {
		const f = fixture();
		f.setSettings({ general: { autoUpdate: false } });
		f.run("setupAutoUpdater()");
		await f.check();
		assert.equal(f.updater.checks, 0);
		assert.deepEqual(f.settingsReads, ["/fixture/custom-user-data-dev/data/settings.json"]);
		await f.check(true);
		assert.equal(f.updater.checks, 1);
		assert.equal(f.settingsReads.length, 1);
		assert.equal(f.updater.autoDownload, true);
		assert.equal(f.updater.autoInstallOnAppQuit, true);
	});

	for (const [label, setting] of [
		["ON", { general: { autoUpdate: true } }], ["absent field", { general: {} }],
		["absent section", { version: 1 }], ["null", null], ["non-boolean", { general: { autoUpdate: "false" } }],
	] as const) {
		it(`${label} keeps automatic checks enabled`, async () => {
			const f = fixture(); f.setSettings(setting); f.run("setupAutoUpdater()"); await f.check();
			assert.equal(f.updater.checks, 1);
		});
	}
	for (const [label, failure] of [["missing", new Error("ENOENT")], ["unreadable", new Error("EACCES")], ["corrupt", "{nope"]] as const) {
		it(`${label} settings keep automatic checks enabled`, async () => {
			const f = fixture(); f.setSettingsFailure(failure); f.run("setupAutoUpdater()"); await f.check();
			assert.equal(f.updater.checks, 1);
		});
	}

	it("re-reads the setting on each check, without triggering a check merely when saved", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.setSettings({ general: { autoUpdate: false } }); await f.check();
		f.setSettings({ general: { autoUpdate: true } });
		assert.equal(f.updater.checks, 0);
		await f.check();
		f.setSettings({ general: { autoUpdate: false } }); await f.check();
		assert.equal(f.updater.checks, 1);
		assert.equal(f.settingsReads.length, 3);
	});

	for (const label of ["unpackaged", "missing updater"] as const) {
		it(`${label} stays unavailable, not a saved OFF preference`, async () => {
			const f = fixture({ packaged: label !== "unpackaged", updaterMissing: label === "missing updater" });
			f.run("setupAutoUpdater()"); await f.check(true); await f.check();
			assert.equal(f.updater.checks, 0);
			assert.equal(f.settingsReads.length, 0);
			assert.equal(f.state().status, "disabled");
		});
	}
});

describe("status observation never controls the updater", () => {
	it("reports events, but a staged update stays visible without suppressing future checks", async () => {
		const f = fixture(); const win = f.window(); f.run("setupAutoUpdater()");
		f.updater.emit("checking-for-update"); assert.equal(f.state().status, "checking");
		f.updater.emit("update-available", { version: "0.3.8" });
		assert.equal(f.state().status, "downloading"); assert.equal(f.state().version, "0.3.8");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		const ready = f.state();
		await f.check();
		f.updater.emit("error", new Error("failure with sensitive diagnostic details"));
		assert.equal(f.updater.checks, 1);
		assert.deepEqual(f.state(), ready);
		f.updater.emit("update-downloaded", { version: "0.3.9" });
		assert.equal(f.state().version, "0.3.9");
		assert.ok(f.state().revision > ready.revision);
		assert.equal(win.webContents.messages.at(-1)!.channel, "lh:update-status");
	});

	for (const status of ["checking", "downloading", "error", "disabled", "downloaded"]) {
		it(`a ${status} display state does not block a future automatic check`, async () => {
			const f = fixture(); f.run(`setupAutoUpdater(); reportUpdateStatus("${status}")`); await f.check();
			assert.equal(f.updater.checks, 1);
		});
	}

	it("check failures settle to a generic error and later checks still run", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.failure = new Error("private endpoint/diagnostic detail"); await f.check();
		assert.equal(f.state().status, "error");
		assert.ok(!JSON.stringify(f.state()).includes("private"));
		f.updater.failure = null; await f.check();
		assert.equal(f.updater.checks, 2); assert.equal(f.state().status, "up-to-date");
	});

	it("a declined check makes no up-to-date claim", async () => {
		const f = fixture(); f.updater.result = null; f.run("setupAutoUpdater()"); await f.check(true);
		assert.equal(f.state().status, "idle");
	});

	it("window enumeration/send failures do not break checks or the next window's notification", async () => {
		const f = fixture(); const bad = f.window(); bad.webContents.fails = true; const good = f.window();
		f.run("setupAutoUpdater()"); await f.check();
		assert.equal(good.webContents.messages.at(-1)!.channel, "lh:update-status");
		f.setEnumerationFailure(true); await f.check();
		f.setEnumerationFailure(false); await f.check();
		assert.equal(f.updater.checks, 3);
	});

	it("OFF does not cancel in-flight events or alter staging/install-on-quit; Restart kills server first", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.setSettings({ general: { autoUpdate: false } });
		f.updater.emit("update-downloaded", { version: "0.3.8" }); await f.check();
		assert.equal(f.state().status, "downloaded"); assert.equal(f.updater.checks, 0);
		assert.equal(f.updater.autoDownload, true); assert.equal(f.updater.autoInstallOnAppQuit, true);
		f.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.deepEqual(f.order, ["SIGTERM", "install"]);
	});
});

describe("startup, timer, trusted IPC and menu wiring", () => {
	it("starts and retains the 24h timer without any Settings subscription, checking current preference each time", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } });
		await f.run("main()");
		assert.equal(f.updater.checks, 0);
		assert.equal(f.intervals.length, 1); assert.equal(f.intervals[0]!.delay, 24 * 60 * 60 * 1000);
		f.setSettings({ general: { autoUpdate: true } }); f.intervals[0]!.callback(); await Promise.resolve();
		assert.equal(f.updater.checks, 1);
		f.windows.length = 0; f.intervals[0]!.callback(); await Promise.resolve();
		assert.equal(f.updater.checks, 2, "checks also work with every window closed");
	});

	it("ON/default boot checks immediately and status never disables the scheduled check", async () => {
		const f = fixture(); f.setSettings({ version: 1 }); await f.run("main()");
		assert.equal(f.updater.checks, 1);
		f.run('reportUpdateStatus("downloading", "0.3.8")'); f.intervals[0]!.callback(); await Promise.resolve();
		assert.equal(f.updater.checks, 2);
	});

	it("snapshot/manual IPC accepts only an owned main frame and snapshot reads never check", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		const sender = f.windows[0]!.webContents;
		const event = { sender, senderFrame: sender.mainFrame };
		const get = f.handles.get("lh:update:get")!; const check = f.handles.get("lh:update:check")!;
		assert.equal((get(event) as { status: string }).status, "idle"); assert.equal(f.updater.checks, 0);
		check(event); assert.equal(f.updater.checks, 1);
		for (const bad of [
			{ sender: {}, senderFrame: sender.mainFrame },
			{ sender, senderFrame: { url: sender.mainFrame.url } },
		]) {
			assert.throws(() => get(bad), /Untrusted/); assert.throws(() => check(bad), /Untrusted/);
		}
		sender.mainFrame.url = "https://untrusted.invalid/";
		assert.throws(() => check(event), /Untrusted/);
		assert.equal(f.updater.checks, 1);
	});

	it("menu restores/focuses a minimized window, opens General, and manually checks while OFF", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		const win = f.windows[0]!; win.webContents.loading = false; win.minimized = true;
		f.menuCheck();
		assert.equal(win.minimized, false); assert.equal(win.focused, true);
		assert.ok(win.webContents.messages.some(message => message.channel === "lh:open-settings" && message.value === "general"));
		assert.equal(f.updater.checks, 1);
	});

	it("menu reopens a window and delivers General after load; loading existing windows are covered too", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		f.windows.length = 0; f.menuCheck();
		assert.equal(f.windows.length, 1); assert.equal(f.updater.checks, 1);
		const win = f.windows[0]!;
		assert.ok(!win.webContents.messages.some(message => message.channel === "lh:open-settings"));
		win.webContents.emit("did-finish-load");
		assert.ok(win.webContents.messages.some(message => message.channel === "lh:open-settings"));
		f.menuCheck(); win.webContents.emit("did-finish-load");
		assert.equal(win.webContents.messages.filter(message => message.channel === "lh:open-settings").length, 2);
	});

	it("menu navigation failure does not prevent its manual check", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		f.windows[0]!.webContents.fails = true; f.windows[0]!.webContents.loading = false;
		f.menuCheck(); assert.equal(f.updater.checks, 1);
	});
});
