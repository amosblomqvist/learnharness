/*
 * The shell's update state (in-app update controls, owner 2026-10-25).
 * main.cjs folds electron-updater's events through nextUpdateState and
 * pushes every change on "lh:update-status"; Settings → General renders
 * it, and "lh:update:get" covers a Settings opened long after the startup
 * check. Pure — no Electron — so tests/update-state.test.ts can pin it.
 *
 *   status: idle | checking | downloading | up-to-date | downloaded |
 *           error | disabled
 *   manual: the current check was asked for by the user — only a manual
 *           check that finds nothing says "up to date"; the automatic
 *           ones stay quiet.
 *
 * Two terminal-ish rules: "disabled" (dev / unpackaged — no updater) never
 * changes, and "downloaded" is sticky — a staged update installs on quit
 * whatever later checks report, so the Restart offer must not vanish.
 */
const fs = require("node:fs");
const path = require("node:path");

const INITIAL_UPDATE_STATE = Object.freeze({ status: "idle", version: null, error: null, manual: false });

function nextUpdateState(state, event) {
	if (state.status === "disabled") return state;
	if (event.type === "disabled") return { ...INITIAL_UPDATE_STATE, status: "disabled" };
	if (state.status === "downloaded" && event.type !== "downloaded") return state;
	switch (event.type) {
		case "checking":
			return { status: "checking", version: null, error: null, manual: Boolean(event.manual) };
		case "available":
			return { ...state, status: "downloading", version: event.version ?? null, error: null };
		case "not-available":
			return { ...state, status: state.manual ? "up-to-date" : "idle", version: null, error: null };
		case "downloaded":
			return { ...state, status: "downloaded", version: event.version ?? null, error: null };
		case "error":
			return { ...state, status: "error", error: String(event.message ?? "Unknown error") };
		default:
			return state;
	}
}

/** Settings → General → Automatic updates, read straight from the server's
 *  settings file (src/store/settings.ts owns the format; the shell only
 *  reads). Anything but an explicit false — no file, corrupt JSON, a
 *  non-boolean — means on: the factory default. */
function readAutoUpdateSetting(dataDir) {
	try {
		const record = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8"));
		return record?.general?.autoUpdate !== false;
	} catch {
		return true;
	}
}

module.exports = { INITIAL_UPDATE_STATE, nextUpdateState, readAutoUpdateSetting };
