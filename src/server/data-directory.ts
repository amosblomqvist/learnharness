import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AUTH_FILE,
	DATA_CONFIG_FILE,
	getDataLocationState,
	ROOT,
	setActiveDataDir,
} from "../../config.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { isJobLive } from "../agent/subagents/aborts.ts";
import { isWithin } from "../agent/tools/file-access.ts";
import { isSensitivePath } from "../agent/tools/fs-shared.ts";
import { emit } from "../core/events.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "../store/atomic-write.ts";
import { compactionInFlight } from "./compaction.ts";
import { pluginWorkerActivities } from "./plugin-worker-activity.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

export class DataDirectoryInputError extends Error {}
export class DataDirectoryBusyError extends Error {}

export type DataMigrationMode = "copy" | "switch";

export interface DataDirectoryStatus {
	currentDir: string;
	defaultDir: string;
	isCustom: boolean;
	configuredDir: string | null;
	unavailableConfiguredDir: string | null;
}

export type DataDirectoryRequest =
	| {
			action: "change";
			path: string;
			copyMode: DataMigrationMode;
			deleteOld?: boolean;
	  }
	| {
			action: "reset";
			copyMode: DataMigrationMode;
			deleteOld?: boolean;
	  }
	| {
			action: "retry-configured";
	  }
	| {
			action: "use-default";
	  };

/** Known LearnHarness mutable items stored inside `PATHS.data`.
 *  Only these items are copied or removed during a data-directory migration;
 *  unrelated user files in the folder and machine credentials (`auth.json`)
 *  are never touched. */
export const LEARN_HARNESS_DATA_ITEMS = [
	"chats",
	"graph",
	"course-files",
	"settings.json",
	"prompts",
	"themes",
	"plugins",
	"core-plugin-data",
	"jobs",
	"debug",
] as const;

export function getDataDirectoryStatus(): DataDirectoryStatus {
	return getDataLocationState();
}

function expandHomePath(rawPath: string, home: string = os.homedir()): string {
	const trimmed = rawPath.trim();
	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/") || trimmed.startsWith(`~${path.sep}`)) {
		return path.join(home, trimmed.slice(2));
	}
	return trimmed;
}

function isAccessibleDirectory(dirPath: string): boolean {
	try {
		const stat = fs.statSync(/* turbopackIgnore: true */ dirPath);
		if (!stat.isDirectory()) return false;
		fs.accessSync(/* turbopackIgnore: true */ dirPath, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function assertNotBusy(): void {
	if (extractionStatuses().length > 0) {
		throw new DataDirectoryBusyError(
			"A knowledge-graph extraction is running. Wait for it to finish before changing the data directory.",
		);
	}
	if (pluginWorkerActivities().length > 0) {
		throw new DataDirectoryBusyError(
			"A plugin task is running. Wait for it to finish before changing the data directory.",
		);
	}
	for (const chat of stores.chatStore.listChats()) {
		if (isTurnRunning(chat.id) || compactionInFlight(chat.id)) {
			throw new DataDirectoryBusyError(
				"A session turn or compaction is running. Wait for it to finish before changing the data directory.",
			);
		}
		const runningJobs = stores.jobStore
			.listJobs(chat.id)
			.filter((job) => job.status === "running" && (!job.result || isJobLive(job.id)));
		if (runningJobs.length > 0) {
			throw new DataDirectoryBusyError(
				"Background jobs are still running. Wait for them to finish before changing the data directory.",
			);
		}
	}
}

function validateAndPrepareTargetDirectory(rawPath: string, defaultDir: string, home: string = os.homedir()): string {
	if (typeof rawPath !== "string" || !rawPath.trim()) {
		throw new DataDirectoryInputError("Data directory path must be a non-empty string.");
	}
	const expanded = expandHomePath(rawPath, home);
	if (expanded.includes("\0") || !path.isAbsolute(expanded)) {
		throw new DataDirectoryInputError("Data directory path must be an absolute path.");
	}
	const normalized = path.resolve(/* turbopackIgnore: true */ expanded);
	const parsedRoot = path.parse(normalized).root;
	if (normalized === parsedRoot) {
		throw new DataDirectoryInputError("Cannot use the filesystem root as the data directory.");
	}
	const resolvedHome = path.resolve(home);
	if (normalized === resolvedHome) {
		throw new DataDirectoryInputError("Choose a dedicated subfolder rather than your home directory itself.");
	}
	if (isSensitivePath(normalized, resolvedHome)) {
		throw new DataDirectoryInputError("Data directory cannot be inside a protected or credential location.");
	}
	const authDir = path.dirname(path.resolve(AUTH_FILE));
	if (normalized === authDir && normalized !== defaultDir) {
		throw new DataDirectoryInputError("Choose a dedicated data subfolder rather than the credentials directory.");
	}
	if (normalized !== defaultDir && isWithin(normalized, ROOT) && !isWithin(normalized, defaultDir)) {
		throw new DataDirectoryInputError("Data directory cannot be inside the application source tree.");
	}

	// On macOS, /Volumes/<VolumeName>/... requires the volume itself to be mounted
	// so we never create a local stub folder under /Volumes when a drive is unplugged.
	if (process.platform === "darwin" && (normalized === "/Volumes" || normalized.startsWith("/Volumes/"))) {
		const rel = path.relative("/Volumes", normalized);
		const volumeName = rel.split(path.sep)[0];
		if (!volumeName || volumeName === "..") {
			throw new DataDirectoryInputError("Choose a folder inside a mounted volume.");
		}
		const volumeRoot = path.join("/Volumes", volumeName);
		let volumeMounted = false;
		try {
			volumeMounted = fs.statSync(/* turbopackIgnore: true */ volumeRoot).isDirectory();
		} catch {
			volumeMounted = false;
		}
		if (!volumeMounted) {
			throw new DataDirectoryInputError(
				`The volume "${volumeRoot}" is not mounted. Connect the external drive and try again.`,
			);
		}
	}

	try {
		fs.mkdirSync(/* turbopackIgnore: true */ normalized, { recursive: true });
	} catch (err) {
		throw new DataDirectoryInputError(
			`Could not create or access the folder "${normalized}": ${(err as Error).message}`,
		);
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(/* turbopackIgnore: true */ normalized);
	} catch {
		throw new DataDirectoryInputError("Folder does not exist on this machine.");
	}
	if (!stat.isDirectory()) {
		throw new DataDirectoryInputError("Path must point to a directory.");
	}
	try {
		fs.accessSync(/* turbopackIgnore: true */ normalized, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
	} catch {
		throw new DataDirectoryInputError("LearnHarness does not have read and write permission for that folder.");
	}
	let realTarget: string;
	try {
		realTarget = fs.realpathSync.native(/* turbopackIgnore: true */ normalized);
	} catch {
		throw new DataDirectoryInputError("Could not resolve the target folder path.");
	}
	if (isSensitivePath(realTarget, resolvedHome)) {
		throw new DataDirectoryInputError("Data directory cannot point to a protected or credential location.");
	}

	return normalized;
}

function writeDataConfigPointer(targetDir: string | null, defaultDir: string): void {
	const configFile = DATA_CONFIG_FILE;
	if (!targetDir || path.resolve(targetDir) === path.resolve(defaultDir)) {
		try {
			fs.rmSync(/* turbopackIgnore: true */ configFile, { force: true });
			removeLeftoverTemps(configFile);
		} catch {
			/* absent is fine */
		}
		return;
	}
	fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(configFile), { recursive: true });
	writeFileAtomicSync(
		configFile,
		`${JSON.stringify({ version: 1, dataDir: path.resolve(targetDir) }, null, "\t")}\n`,
	);
}

function copyAppDataItems(sourceDir: string, targetDir: string): void {
	if (path.resolve(sourceDir) === path.resolve(targetDir)) return;
	let realSource: string | null = null;
	let realTarget: string | null = null;
	try {
		realSource = fs.realpathSync.native(/* turbopackIgnore: true */ sourceDir);
	} catch {
		realSource = null;
	}
	try {
		realTarget = fs.realpathSync.native(/* turbopackIgnore: true */ targetDir);
	} catch {
		realTarget = null;
	}
	if (realSource && realTarget && realSource === realTarget) return;
	if (
		isWithin(targetDir, sourceDir) ||
		isWithin(sourceDir, targetDir) ||
		(realSource && realTarget && (isWithin(realTarget, realSource) || isWithin(realSource, realTarget)))
	) {
		throw new DataDirectoryInputError(
			"When copying existing data, the new folder cannot be inside or contain the current data folder.",
		);
	}

	fs.mkdirSync(/* turbopackIgnore: true */ targetDir, { recursive: true });
	for (const item of LEARN_HARNESS_DATA_ITEMS) {
		const srcPath = path.join(/* turbopackIgnore: true */ sourceDir, item);
		if (!fs.existsSync(/* turbopackIgnore: true */ srcPath)) continue;
		const destPath = path.join(/* turbopackIgnore: true */ targetDir, item);
		fs.cpSync(/* turbopackIgnore: true */ srcPath, destPath, {
			recursive: true,
			force: true,
			errorOnExist: false,
		});
	}
}

function deleteOldAppDataItems(oldDir: string, newDir: string): void {
	if (path.resolve(oldDir) === path.resolve(newDir)) return;
	try {
		const realOld = fs.realpathSync.native(/* turbopackIgnore: true */ oldDir);
		const realNew = fs.realpathSync.native(/* turbopackIgnore: true */ newDir);
		if (realOld === realNew) return;
	} catch {
		/* proceed with lexical paths */
	}
	for (const item of LEARN_HARNESS_DATA_ITEMS) {
		const itemPath = path.join(/* turbopackIgnore: true */ oldDir, item);
		try {
			fs.rmSync(/* turbopackIgnore: true */ itemPath, { recursive: true, force: true });
			if (item.endsWith(".json")) removeLeftoverTemps(itemPath);
		} catch {
			/* best effort cleanup after copy */
		}
	}
}

function broadcastDataDirSwitch(): void {
	emit("chats-changed", {});
	emit("sources-changed", {});
	emit("plugins-changed", {});
	emit("activity-changed", {});
	emit("jobs-changed", {});
}

export function parseDataDirectoryRequest(raw: unknown): DataDirectoryRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new DataDirectoryInputError("Invalid data directory request.");
	}
	const r = raw as Record<string, unknown>;
	if (r.action === "retry-configured") {
		return { action: "retry-configured" };
	}
	if (r.action === "use-default") {
		return { action: "use-default" };
	}
	if (r.action === "change" || r.action === "reset") {
		const copyMode = r.copyMode;
		if (copyMode !== "copy" && copyMode !== "switch") {
			throw new DataDirectoryInputError('copyMode must be "copy" or "switch".');
		}
		if (r.deleteOld !== undefined && typeof r.deleteOld !== "boolean") {
			throw new DataDirectoryInputError("deleteOld must be a boolean.");
		}
		const deleteOld = copyMode === "copy" ? Boolean(r.deleteOld) : false;
		if (r.action === "reset") {
			return { action: "reset", copyMode, deleteOld };
		}
		if (typeof r.path !== "string" || !r.path.trim()) {
			throw new DataDirectoryInputError("Data directory path must be a non-empty string.");
		}
		return { action: "change", path: r.path, copyMode, deleteOld };
	}
	throw new DataDirectoryInputError("Unknown data directory action.");
}

export function mutateDataDirectory(raw: unknown, home: string = os.homedir()): DataDirectoryStatus {
	const request = parseDataDirectoryRequest(raw);
	assertNotBusy();

	const state = getDataLocationState();
	const previousDir = state.currentDir;
	const defaultDir = state.defaultDir;

	if (request.action === "retry-configured") {
		const candidate = state.unavailableConfiguredDir ?? state.configuredDir;
		if (!candidate) {
			return getDataDirectoryStatus();
		}
		if (!isAccessibleDirectory(candidate)) {
			throw new DataDirectoryInputError(
				`The configured data folder "${candidate}" is still unavailable. Check that the external drive is connected and try again.`,
			);
		}
		setActiveDataDir(candidate, {
			configuredDir: candidate === defaultDir ? null : candidate,
			unavailableConfiguredDir: null,
		});
		broadcastDataDirSwitch();
		return getDataDirectoryStatus();
	}

	if (request.action === "use-default") {
		fs.mkdirSync(/* turbopackIgnore: true */ defaultDir, { recursive: true });
		writeDataConfigPointer(null, defaultDir);
		setActiveDataDir(defaultDir, {
			configuredDir: null,
			unavailableConfiguredDir: null,
		});
		broadcastDataDirSwitch();
		return getDataDirectoryStatus();
	}

	const targetDir =
		request.action === "reset"
			? validateAndPrepareTargetDirectory(defaultDir, defaultDir, home)
			: validateAndPrepareTargetDirectory(request.path, defaultDir, home);

	if (request.copyMode === "copy" && targetDir !== previousDir) {
		copyAppDataItems(previousDir, targetDir);
	}

	const isDefaultTarget = targetDir === defaultDir;
	writeDataConfigPointer(isDefaultTarget ? null : targetDir, defaultDir);
	setActiveDataDir(targetDir, {
		configuredDir: isDefaultTarget ? null : targetDir,
		unavailableConfiguredDir: null,
	});

	if (request.copyMode === "copy" && request.deleteOld && targetDir !== previousDir) {
		deleteOldAppDataItems(previousDir, targetDir);
	}

	broadcastDataDirSwitch();
	return getDataDirectoryStatus();
}
