"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const { isSensitivePath } = require("./sensitive-paths.cjs");

const STORE_MARKER = ".learnharness-store-id";
const MANAGED_ITEMS = [
	"chats", "graph", "course-files", "settings.json", "prompts", "themes",
	"plugins", "plugins-state.json", "core-plugin-data", "jobs", "debug",
];
const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isFullPath(value, platform = process.platform) {
	if (!value || value.includes("\0")) return false;
	if (platform !== "win32") return path.posix.isAbsolute(value);
	return /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+(?:[\\/]|$)/.test(value);
}

function canonicalPath(value, disk = fs) {
	let ancestor = value;
	const rest = [];
	for (;;) {
		const stat = disk.lstatSync(ancestor, { throwIfNoEntry: false });
		if (stat) {
			if (rest.length && !disk.statSync(ancestor).isDirectory()) throw new Error(`Not a directory: ${ancestor}`);
			return path.join(disk.realpathSync.native(ancestor), ...rest);
		}
		const parent = path.dirname(ancestor);
		if (ancestor === parent) throw new Error(`Filesystem or volume is unavailable: ${ancestor}`);
		rest.unshift(path.basename(ancestor));
		ancestor = parent;
	}
}

function within(candidate, root) {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertOrdinary(stat, file) {
	if (stat.isSymbolicLink()) throw new Error(`Symbolic links and junctions are unsupported in data folders: ${file}`);
	if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Unsupported entry in data folder: ${file}`);
}

function validateTree(root, disk = fs) {
	const visit = file => {
		const stat = disk.lstatSync(file);
		assertOrdinary(stat, file);
		if (stat.isDirectory()) for (const name of disk.readdirSync(file)) visit(path.join(file, name));
	};
	const stat = disk.lstatSync(root);
	assertOrdinary(stat, root);
	if (!stat.isDirectory()) throw new Error(`Expected a directory: ${root}`);
	disk.accessSync(root, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
	for (const name of MANAGED_ITEMS) {
		const file = path.join(root, name);
		if (disk.lstatSync(file, { throwIfNoEntry: false })) visit(file);
	}
	readStoreId(root, disk);
}

function validateTarget(value, { source, defaultDir, appRoot, authFile, home = os.homedir(), disk = fs }) {
	if (!isFullPath(value)) throw new Error("Data directory path must be an absolute path with a drive letter or share on Windows.");
	const normalized = path.resolve(value);
	const original = disk.lstatSync(normalized, { throwIfNoEntry: false });
	if (original) assertOrdinary(original, normalized);
	if (process.platform === "darwin" && within(normalized, "/Volumes")) {
		const volume = path.relative("/Volumes", normalized).split(path.sep)[0];
		const volumeRoot = path.join("/Volumes", volume);
		const device = volume && disk.statSync(volumeRoot, { throwIfNoEntry: false });
		if (!device?.isDirectory() || device.dev === disk.statSync("/Volumes").dev) {
			throw new Error(`Choose a folder inside a mounted volume. The volume at "${volumeRoot}" is unavailable.`);
		}
	}
	const target = canonicalPath(normalized, disk);
	const fallback = canonicalPath(defaultDir, disk);
	const homeRoot = canonicalPath(path.resolve(home), disk);
	if (target === path.parse(target).root || path.relative(homeRoot, target) === "") {
		throw new Error("Choose a dedicated subfolder for LearnHarness data.");
	}
	const authRoot = authFile && canonicalPath(path.dirname(authFile), disk);
	if (isSensitivePath(normalized, home, authFile) || isSensitivePath(target, homeRoot, authFile) ||
		(homeRoot !== path.resolve(home) && isSensitivePath(normalized, homeRoot, authFile)) ||
		(authRoot && within(authRoot, target))) {
		throw new Error("Data directory cannot be in or contain a protected or credential location.");
	}
	if (appRoot && within(target, canonicalPath(appRoot, disk)) && path.relative(fallback, target) !== "") {
		throw new Error("Data directory cannot be inside the application source tree.");
	}
	if (source) {
		const origin = canonicalPath(source, disk);
		if (within(target, origin) || within(origin, target)) {
			throw new Error("The new folder must be separate from the current data folder. It cannot be the same folder, contain it, or be inside it.");
		}
	}
	if (original) validateTree(target, disk);
	return target;
}

function parseDataLocationText(raw) {
	const pointer = JSON.parse(raw);
	if (typeof pointer?.dataDir !== "string" || !isFullPath(pointer.dataDir)) throw new Error("Invalid data-location.json path.");
	return { dataDir: path.resolve(pointer.dataDir), storeId: typeof pointer.storeId === "string" && STORE_ID.test(pointer.storeId) ? pointer.storeId : null };
}

function readPointer(configFile, disk = fs) {
	if (!configFile) return null;
	const stat = disk.lstatSync(configFile, { throwIfNoEntry: false });
	if (!stat) return null;
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe data-location.json pointer.");
	try {
		return parseDataLocationText(disk.readFileSync(configFile, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

function readStoreId(root, disk = fs) {
	const file = path.join(root, STORE_MARKER);
	const stat = disk.lstatSync(file, { throwIfNoEntry: false });
	if (!stat) return null;
	assertOrdinary(stat, file);
	if (!stat.isFile() || stat.size > 128) throw new Error(`Invalid store identity: ${file}`);
	const id = disk.readFileSync(file, "utf8").trim();
	if (!STORE_ID.test(id)) throw new Error(`Invalid store identity: ${file}`);
	return id;
}

function verifyStore(root, id, disk = fs) {
	const stat = disk.lstatSync(root, { throwIfNoEntry: false });
	if (!id || !stat?.isDirectory() || stat.isSymbolicLink() || path.relative(canonicalPath(root, disk), root) !== "" || readStoreId(root, disk) !== id) {
		throw new Error(`The configured data folder "${root}" is unavailable or its identity changed. Reconnect the drive and retry.`);
	}
}

function syncDirectory(dir, disk = fs) {
	// Node cannot open directory handles for flushing on Windows.
	if (process.platform === "win32") return;
	const handle = disk.openSync(dir, "r");
	try { disk.fsyncSync(handle); } finally { disk.closeSync(handle); }
}

function replaceFile(file, contents, disk, afterRename = () => {}) {
	const temp = `${file}.tmp-${randomUUID()}`;
	const fd = disk.openSync(temp, "wx", 0o600);
	try {
		try {
			disk.writeFileSync(fd, contents, "utf8");
			disk.fsyncSync(fd);
		} finally { disk.closeSync(fd); }
		disk.renameSync(temp, file);
		afterRename();
		syncDirectory(path.dirname(file), disk);
	} finally {
		try { disk.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
	}
}

function ensureStoreId(root, disk = fs) {
	const existing = readStoreId(root, disk);
	if (existing) return existing;
	const id = randomUUID();
	replaceFile(path.join(root, STORE_MARKER), `${id}\n`, disk);
	return id;
}

class DataLocationRecoveryError extends Error {
	name = "DataLocationRecoveryError";
}

/**
 * @param {string | null} [expectedStoreId]
 * @param {(warning: string) => void} [onUnflushed]
 */
function writeConfiguredDataDirPath(configFile, dataDir, disk = fs, expectedStoreId = null, onUnflushed) {
	const parent = path.dirname(configFile);
	const prior = disk.lstatSync(configFile, { throwIfNoEntry: false });
	if (prior && (!prior.isFile() || prior.isSymbolicLink())) throw new Error("Unsafe data-location.json pointer.");
	const previous = prior ? disk.readFileSync(configFile) : null;
	let changed = false;
	let storeId = null;
	try {
		if (!dataDir) {
			if (!prior) return null;
			disk.unlinkSync(configFile);
			changed = true;
			syncDirectory(parent, disk);
			return null;
		}
		const resolved = path.resolve(dataDir);
		if (path.relative(canonicalPath(resolved, disk), resolved) !== "") throw new Error("The selected data folder changed.");
		storeId = expectedStoreId ?? ensureStoreId(resolved, disk);
		verifyStore(resolved, storeId, disk);
		disk.mkdirSync(parent, { recursive: true });
		// Flush a newly created pointer directory's entry as well.
		syncDirectory(path.dirname(parent), disk);
		replaceFile(configFile, `${JSON.stringify({ version: 2, dataDir: resolved, storeId }, null, "\t")}\n`, disk, () => { changed = true; });
		return storeId;
	} catch (error) {
		if (changed) {
			try {
				if (previous) replaceFile(configFile, previous, disk);
				else { disk.unlinkSync(configFile); syncDirectory(parent, disk); }
			} catch (rollback) {
				const detail = `${error.message} Restoring the previous location also failed: ${rollback.message}`;
				let persisted;
				try {
					const stat = disk.lstatSync(configFile, { throwIfNoEntry: false });
					if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("Unsafe data-location.json pointer.");
					persisted = stat ? disk.readFileSync(configFile) : null;
				} catch (readError) {
					throw new DataLocationRecoveryError(`${detail} Restart to recover the data folder: ${readError.message}`);
				}
				if (persisted === previous || (persisted && previous && persisted.equals(previous))) throw error;
				try {
					const pointer = persisted && parseDataLocationText(persisted.toString("utf8"));
					if ((!pointer && !dataDir) || (pointer && dataDir &&
						path.relative(pointer.dataDir, dataDir) === "" && pointer.storeId === storeId)) {
						if (pointer) verifyStore(pointer.dataDir, storeId, disk);
						onUnflushed?.(`The folder was switched, but its saved location could not be flushed. ${detail}`);
						return storeId;
					}
				} catch (reconcileError) {
					throw new DataLocationRecoveryError(`${detail} Restart to recover the data folder: ${reconcileError.message}`);
				}
				throw new DataLocationRecoveryError(`${detail} Restart to recover the data folder.`);
			}
		}
		throw error;
	}
}

function inspectDataLocation({ configFile, defaultDir, fsImpl = fs, appRoot, authFile }) {
	const fallback = path.resolve(defaultDir);
	let pointer;
	let reason;
	try { pointer = readPointer(configFile, fsImpl); } catch (error) { reason = error.message; }
	if (!pointer) {
		if (!reason && configFile) {
			try {
				if (fsImpl.lstatSync(fallback, { throwIfNoEntry: false })) validateTree(fallback, fsImpl);
			} catch (error) { reason = error.message; }
		}
		return { currentDir: fallback, defaultDir: fallback, configuredDir: null, storeId: null,
			unavailableConfiguredDir: reason ? fallback : null, recoveryReason: reason ?? null };
	}
	const { dataDir, storeId } = pointer;
	try {
		verifyStore(dataDir, storeId, fsImpl);
		validateTarget(dataDir, { defaultDir, appRoot, authFile, disk: fsImpl });
	} catch (error) { reason = error.message; }
	return { currentDir: dataDir, defaultDir: fallback, configuredDir: dataDir, storeId,
		unavailableConfiguredDir: reason ? dataDir : null, recoveryReason: reason ?? null };
}

async function resolveStartupDataLocation({ configFile, defaultDir, dialog, fsImpl = fs, log, appRoot, authFile }) {
	let failure;
	for (;;) {
		const status = inspectDataLocation({ configFile, defaultDir, fsImpl, appRoot, authFile });
		if (!status.unavailableConfiguredDir) return status;
		if (!dialog) throw new Error(status.recoveryReason);
		const { response } = await dialog.showMessageBox({
			type: "warning", title: "Data Folder Unavailable",
			message: "The configured data folder is currently unavailable.",
			detail: `${status.unavailableConfiguredDir}\n\n${failure ?? status.recoveryReason}`,
			buttons: ["Retry", "Choose Folder…", "Use Default Folder", "Quit"],
			defaultId: 0, cancelId: 3, noLink: true,
		});
		failure = undefined;
		if (response === 0) continue;
		if (response !== 1 && response !== 2) return null;
		try {
			if (response === 2) {
				const target = validateTarget(status.defaultDir, { defaultDir, appRoot, authFile, disk: fsImpl });
				writeConfiguredDataDirPath(configFile, null, fsImpl, null, log);
				return { ...status, currentDir: target, configuredDir: null, storeId: null, unavailableConfiguredDir: null, recoveryReason: null };
			}
			const picked = await dialog.showOpenDialog({ title: "Select Data Folder", properties: ["openDirectory"] });
			if (picked.canceled || !picked.filePaths[0]) continue;
			const target = validateTarget(picked.filePaths[0], {
				defaultDir, appRoot, authFile, disk: fsImpl,
			});
			validateTree(target, fsImpl);
			const configuredDir = path.relative(target, canonicalPath(defaultDir, fsImpl)) ? target : null;
			const storeId = writeConfiguredDataDirPath(configFile, configuredDir, fsImpl, null, log);
			return { ...status, currentDir: target, configuredDir, storeId, unavailableConfiguredDir: null, recoveryReason: null };
		} catch (error) {
			failure = `Could not select the data folder: ${error.message}`;
			log?.(failure);
		}
	}
}

async function resolveStartupDataDir(options) {
	return (await resolveStartupDataLocation(options))?.currentDir ?? null;
}

module.exports = {
	STORE_MARKER, MANAGED_ITEMS, isFullPath, canonicalPath, assertOrdinary, validateTarget, validateTree,
	readPointer, readStoreId, verifyStore, ensureStoreId, syncDirectory, writeConfiguredDataDirPath, DataLocationRecoveryError,
	inspectDataLocation, resolveStartupDataDir, resolveStartupDataLocation,
};
