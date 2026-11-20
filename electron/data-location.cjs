"use strict";
/**
 * Bootstrap pointer for the mutable data directory (`data-location.json`).
 * Lives in a fixed machine-local location (`<userData>/data-location.json` in
 * packaged Electron, `<repoRoot>/data-location.json` in dev/web) outside the
 * movable data folder so the app knows where `DATA_DIR` lives before reading
 * `<DATA_DIR>/settings.json`. Credentials (`auth.json`, subscription tokens)
 * always remain in `<userData>` / repo root on the local machine.
 */
const fs = require("node:fs");
const path = require("node:path");

function parseDataLocationText(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		if (typeof parsed.dataDir !== "string") return null;
		const trimmed = parsed.dataDir.trim();
		if (!trimmed || trimmed.includes("\0") || !path.isAbsolute(trimmed)) return null;
		return path.resolve(trimmed);
	} catch {
		return null;
	}
}

function readConfiguredDataDirPath(configFile, fsImpl = fs) {
	try {
		if (typeof fsImpl?.readFileSync !== "function") return null;
		return parseDataLocationText(fsImpl.readFileSync(configFile, "utf8"));
	} catch {
		return null;
	}
}

function isAccessibleDirectory(dirPath, fsImpl = fs) {
	try {
		if (typeof fsImpl?.statSync !== "function") return false;
		const stat = fsImpl.statSync(dirPath);
		if (!stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()) return false;
		if (typeof fsImpl.accessSync === "function" && fsImpl.constants) {
			fsImpl.accessSync(dirPath, fsImpl.constants.R_OK | fsImpl.constants.W_OK | fsImpl.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

function writeConfiguredDataDirPath(configFile, dataDir, fsImpl = fs) {
	if (!dataDir) {
		try {
			fsImpl.rmSync?.(configFile, { force: true });
		} catch {
			/* ignore absent file */
		}
		return;
	}
	const resolved = path.resolve(dataDir);
	fsImpl.mkdirSync(path.dirname(configFile), { recursive: true });
	const tmp = `${configFile}.tmp-${process.pid}-${Date.now()}`;
	fsImpl.writeFileSync(tmp, `${JSON.stringify({ version: 1, dataDir: resolved }, null, "\t")}\n`, "utf8");
	fsImpl.renameSync(tmp, configFile);
}

/**
 * Inspect the bootstrap pointer file and report both the configured path and
 * whether it is currently mounted/accessible on disk.
 */
function inspectDataLocation({ configFile, defaultDir, fsImpl = fs }) {
	const fallback = path.resolve(defaultDir);
	const configuredDir = configFile ? readConfiguredDataDirPath(configFile, fsImpl) : null;
	if (!configuredDir || configuredDir === fallback) {
		return {
			currentDir: fallback,
			defaultDir: fallback,
			isCustom: false,
			configuredDir: null,
			unavailableConfiguredDir: null,
		};
	}
	if (isAccessibleDirectory(configuredDir, fsImpl)) {
		return {
			currentDir: configuredDir,
			defaultDir: fallback,
			isCustom: true,
			configuredDir,
			unavailableConfiguredDir: null,
		};
	}
	return {
		currentDir: fallback,
		defaultDir: fallback,
		isCustom: false,
		configuredDir,
		unavailableConfiguredDir: configuredDir,
	};
}

/**
 * Electron startup prompt when the configured data directory (e.g. an external
 * drive) is unplugged or inaccessible at launch. Loops until the user reconnects
 * and clicks Retry, picks a reachable folder, or chooses the default folder.
 */
async function resolveStartupDataDir({ configFile, defaultDir, dialog, fsImpl = fs, log }) {
	for (;;) {
		const status = inspectDataLocation({ configFile, defaultDir, fsImpl });
		if (!status.unavailableConfiguredDir) return status.currentDir;
		if (!dialog || typeof dialog.showMessageBox !== "function") {
			log?.(`configured data dir unavailable (${status.unavailableConfiguredDir}); falling back to ${status.defaultDir}`);
			return status.defaultDir;
		}
		const missing = status.unavailableConfiguredDir;
		const { response } = await dialog.showMessageBox({
			type: "warning",
			title: "Data Folder Unavailable",
			message: "The configured data folder is currently unavailable.",
			detail:
				`${missing}\n\n` +
				"If your data is on an external drive, reconnect the drive and click Retry, " +
				"choose a different folder where your data is stored, or use the default local data folder.",
			buttons: ["Retry", "Choose Folder…", "Use Default Folder"],
			defaultId: 0,
			cancelId: 2,
			noLink: true,
		});
		if (response === 0) {
			// Retry: loop around and re-check the configured path.
			continue;
		}
		if (response === 1 && typeof dialog.showOpenDialog === "function") {
			const picked = await dialog.showOpenDialog({
				title: "Select Data Folder",
				properties: ["openDirectory", "createDirectory"],
			});
			const chosen = !picked?.canceled && Array.isArray(picked?.filePaths) ? picked.filePaths[0] : null;
			if (chosen) {
				const resolved = path.resolve(chosen);
				try {
					fsImpl.mkdirSync?.(resolved, { recursive: true });
				} catch {
					/* checked below */
				}
				if (isAccessibleDirectory(resolved, fsImpl)) {
					try {
						writeConfiguredDataDirPath(configFile, resolved === status.defaultDir ? null : resolved, fsImpl);
					} catch (err) {
						log?.(`failed to save selected data dir: ${err?.message ?? err}`);
					}
					return resolved;
				}
			}
			continue;
		}
		// response === 2 (Use Default Folder)
		try {
			writeConfiguredDataDirPath(configFile, null, fsImpl);
		} catch (err) {
			log?.(`failed to reset data-location config: ${err?.message ?? err}`);
		}
		return status.defaultDir;
	}
}

module.exports = {
	parseDataLocationText,
	readConfiguredDataDirPath,
	isAccessibleDirectory,
	writeConfiguredDataDirPath,
	inspectDataLocation,
	resolveStartupDataDir,
};
