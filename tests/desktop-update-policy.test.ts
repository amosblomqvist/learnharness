/**
 * ISSUE #104 — the Auto-update setting must gate the AUTOMATIC checks.
 *
 * The toggle shipped on 2026-09-19 as a placeholder ("mechanism ships in a
 * later wave"). Wave C (2026-10-10) then wired electron-updater with a silent
 * download and a restart banner, but never read the setting: `autoDownload`
 * was hardcoded `true`, so turning the toggle off changed nothing and the app
 * kept downloading. This pins the decision against the REAL shell code —
 * main.cjs is loaded into a VM with a stub Electron API and a fake
 * electron-updater, and the production `setupAutoUpdater` / `checkForUpdates`
 * are the ones that run. No rewritten copy of the logic (same approach as
 * tests/desktop-platform.test.ts).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

const temps: string[] = [];
after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** What sits in the settings record before boot. `"missing"` writes no file at
 *  all (first run); `"corrupt"` writes unparseable bytes. */
type Seed = string | Record<string, unknown>;

/**
 * Boot the real main.cjs against a stub Electron + a fake updater, then hand
 * back the two production functions. The single-instance lock is declined so
 * normal boot never spawns a server child.
 */
function harness(seed: Seed) {
	const userData = mkdtempSync(join(tmpdir(), "lh-update-policy-"));
	temps.push(userData);
	const dataDir = join(userData, "data");
	mkdirSync(dataDir, { recursive: true });
	if (seed !== "missing") {
		const text = typeof seed === "string" ? seed : JSON.stringify(seed);
		writeFileSync(join(dataDir, "settings.json"), text, "utf8");
	}

	// Every call the updater receives, in order — the gate is synchronous, so
	// the count right after checkForUpdates() is the verdict.
	const updaterCalls: string[] = [];
	const updater = {
		autoDownload: false,
		autoInstallOnAppQuit: false,
		logger: undefined as unknown,
		setFeedURL() {},
		on() {},
		quitAndInstall() {},
		checkForUpdates() {
			updaterCalls.push("check");
			return Promise.resolve({ updateInfo: { version: "9.9.9" } });
		},
	};

	class FakeWindow {
		webContents = { on() {}, setWindowOpenHandler() {}, send() {} };
		loadURL() {}
		once() {}
		static getAllWindows() {
			return [];
		}
		static fromWebContents() {
			return null;
		}
	}

	const electron = {
		app: {
			setName() {},
			requestSingleInstanceLock: () => false,
			quit() {},
			on() {},
			isPackaged: true,
			getPath: () => userData,
			getVersion: () => "0.3.7",
		},
		BrowserWindow: FakeWindow,
		Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
		ipcMain: { handle() {}, on() {} },
		session: {
			defaultSession: {
				setPermissionRequestHandler() {},
				setPermissionCheckHandler() {},
				webRequest: { onBeforeSendHeaders() {} },
			},
		},
		shell: { openExternal() {} },
		dialog: { showMessageBox() {} },
	};

	const context = {
		require: (id: string) =>
			id === "electron" ? electron : id === "electron-updater" ? { autoUpdater: updater } : mainRequire(id),
		process: { platform: "darwin", argv: [], env: {}, on() {} },
		__dirname: dirname(mainFile),
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
	};

	runInNewContext(mainSource, context, { filename: mainFile });
	runInNewContext("setupAutoUpdater()", context);

	return {
		/** The startup check and the 24h timer both call this with no argument. */
		automaticCheck: () => runInNewContext("checkForUpdates()", context) as void,
		/** The menu's "Check for Updates…". */
		manualCheck: () => runInNewContext("checkForUpdates({ manual: true })", context) as void,
		updaterCalls,
		updater,
	};
}

describe("#104 auto-update honours the setting", () => {
	it("autoUpdate: false stops the automatic check before it reaches the updater", () => {
		const h = harness({ general: { autoUpdate: false } });
		h.automaticCheck();
		assert.deepEqual(h.updaterCalls, [], "the updater was never contacted");
	});

	it("autoUpdate: true still checks", () => {
		const h = harness({ general: { autoUpdate: true } });
		h.automaticCheck();
		assert.deepEqual(h.updaterCalls, ["check"]);
	});

	it("an absent general section means ON (factory default), so it checks", () => {
		const h = harness({});
		h.automaticCheck();
		assert.deepEqual(h.updaterCalls, ["check"]);
	});

	it("a missing settings file means ON (first run), so it checks", () => {
		const h = harness("missing");
		h.automaticCheck();
		assert.deepEqual(h.updaterCalls, ["check"]);
	});

	it("a corrupt settings file means ON and never throws (the updater cannot take the app down)", () => {
		const h = harness("{ this is not json");
		assert.doesNotThrow(() => h.automaticCheck());
		assert.deepEqual(h.updaterCalls, ["check"]);
	});

	it("the menu item still checks when automatic updates are off — an explicit request", () => {
		const h = harness({ general: { autoUpdate: false } });
		h.manualCheck();
		assert.deepEqual(h.updaterCalls, ["check"]);
	});

	it("the download is still armed for a MANUAL check, so the explicit path behaves as before", () => {
		const h = harness({ general: { autoUpdate: false } });
		h.manualCheck();
		// autoDownload stays true: the gate is at CHECK time, so a manual check
		// downloads exactly as it always did.
		assert.equal(h.updater.autoDownload, true);
	});
});
