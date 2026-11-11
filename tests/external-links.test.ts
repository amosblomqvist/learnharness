/** The app window's real will-navigate and window-open handlers, run against
 * fake Electron: links may leave the app only for a browser or mail client.
 * Other schemes reach OS protocol handlers (smb: can leak credentials,
 * search-ms:/ms-msdt: have been abused, file: launches local apps). */
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
const appUrl = "http://127.0.0.1:9000";

type OpenHandler = (details: { url: string }) => { action: string };

function appWindow() {
	const opened: string[] = [];
	const logged: string[] = [];
	let openHandler: OpenHandler | undefined;
	class FakeWebContents extends EventEmitter {
		setWindowOpenHandler(handler: OpenHandler) { openHandler = handler; }
		send() {}
		getZoomFactor() { return 1; }
	}
	class FakeWindow extends EventEmitter {
		webContents = new FakeWebContents();
		loadURL() {}
		show() {}
		static getAllWindows() { return []; }
	}
	const app = Object.assign(new EventEmitter(), {
		isPackaged: true, name: "LearnHarness", setName() {},
		getPath: () => "/fixture/user-data", setPath() {},
		requestSingleInstanceLock: () => false, quit() {}, whenReady: async () => {},
	});
	const electron = {
		app, BrowserWindow: FakeWindow,
		Menu: { buildFromTemplate: (value: unknown) => value, setApplicationMenu() {} },
		ipcMain: { on() {}, handle() {} },
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
		shell: { openExternal: async (target: string) => { opened.push(target); } },
	};
	const context = createContext({
		require: (id: string) => {
			if (id === "electron") return electron;
			if (id === "node:fs") return { readFileSync: () => "{}", mkdirSync() {}, appendFileSync: (_: string, line: string) => logged.push(line) };
			return mainRequire(id);
		},
		process: { argv: [], env: {}, platform: "darwin", on() {}, stdout: { write() {} } },
		__dirname: path.dirname(mainFile), URL,
		setInterval() {}, setTimeout() {},
	});
	runInContext(mainSource, context, { filename: mainFile });
	const win = runInContext(`createWindow(${JSON.stringify(appUrl)})`, context) as FakeWindow;
	const navigate = (target: string) => {
		let prevented = false;
		win.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, target);
		return prevented;
	};
	return { opened, logged, navigate, openWindow: (target: string) => openHandler!({ url: target }) };
}

const allowed = ["https://en.wikipedia.org/wiki/Entropy", "http://example.com/paper", "mailto:teacher@example.com"];
const blocked = [
	"smb://attacker.example/share",
	"file:///System/Applications/Calculator.app",
	"search-ms://attacker.example/?query=x",
	"ms-msdt:/id PCWDiagnostic",
	"javascript:alert(1)",
	"vscode://file/etc/passwd",
	"not a url",
];

describe("links leaving the app window", () => {
	it("window.open hands only http, https and mailto to the OS, and always denies the window", () => {
		const w = appWindow();
		for (const target of [...allowed, ...blocked]) assert.equal(w.openWindow(target).action, "deny", target);
		assert.deepEqual(w.opened, allowed);
	});

	it("navigating away from the app is cancelled; only http, https and mailto then open outside", () => {
		const w = appWindow();
		for (const target of [...allowed, ...blocked.filter((target) => target !== "not a url")]) {
			assert.equal(w.navigate(target), true, target);
		}
		assert.deepEqual(w.opened, allowed);
	});

	it("navigation inside the app stays in the app", () => {
		const w = appWindow();
		assert.equal(w.navigate(`${appUrl}/chat/new`), false);
		assert.deepEqual(w.opened, []);
	});

	it("logs the blocked scheme, never the URL", () => {
		const w = appWindow();
		w.openWindow("smb://attacker.example/share?token=secret");
		const lines = w.logged.filter((line) => line.includes("external link blocked"));
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /scheme smb:/);
		assert.ok(!lines[0]!.includes("attacker.example"));
	});
});
