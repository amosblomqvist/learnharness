import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AUTH_FILE,
	activeStoreId,
	DATA_DIR_FIXED,
	DATA_CONFIG_FILE,
	getDataLocationState,
	ROOT,
	setActiveDataDir,
} from "../../config.ts";
import { hasExtractionsInFlight } from "../agent/subagents/extraction.ts";
import { hasLiveJobs } from "../agent/subagents/aborts.ts";
import { isSensitivePath } from "../agent/tools/fs-shared.ts";
import { emit } from "../core/events.ts";
import { beginDataMigration, DataDirectoryBusyError } from "../store/data-write-gate.ts";
import { assertOrdinary, canonicalPath, inspectDataLocation, readPointer, readStoreId, validateTarget, validateTree, verifyStore, writeConfiguredDataDirPath } from "../../electron/data-location.cjs";
import { cleanOldData, createTargetDirectory, stageDataCopy } from "./data-directory-files.ts";
import { disposePluginsForDataChange } from "./plugins.ts";
import { hasRunningCompactions } from "./compaction.ts";
import { pluginWorkerActivities } from "./plugin-worker-activity.ts";
import { hasRunningTurns } from "./turn-liveness.ts";

export class DataDirectoryInputError extends Error {}
export { DataDirectoryBusyError };

export type DataMigrationMode = "copy" | "switch";

export interface DataDirectoryStatus {
	currentDir: string;
	defaultDir: string;
	isCustom: boolean;
	configuredDir: string | null;
	unavailableConfiguredDir: string | null;
	recoveryReason: string | null;
	fixed: boolean;
	platform: NodeJS.Platform;
	cleanupFailures?: string[];
}

export type DataDirectoryRequest =
	| {
			action: "change";
			path: string;
			copyMode: DataMigrationMode;
			deleteOld?: boolean;
			expectedSource?: string;
	  }
	| {
			action: "reset";
			copyMode: DataMigrationMode;
			deleteOld?: boolean;
			expectedSource?: string;
	  }
	| {
			action: "retry-configured";
	  }
	| {
			action: "use-default";
	  };

export function getDataDirectoryStatus(): DataDirectoryStatus {
	return { ...getDataLocationState(), platform: process.platform };
}

function expandHomePath(rawPath: string, home: string): string {
	const trimmed = rawPath.trim();
	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/") || trimmed.startsWith(`~${path.sep}`)) {
		return path.join(home, trimmed.slice(2));
	}
	return trimmed;
}

function assertNotBusy(): void {
	if (hasExtractionsInFlight()) {
		throw new DataDirectoryBusyError(
			"A knowledge-graph extraction is running. Wait for it to finish before changing the data directory.",
		);
	}
	if (pluginWorkerActivities().length > 0) {
		throw new DataDirectoryBusyError(
			"A plugin task is running. Wait for it to finish before changing the data directory.",
		);
	}
	if (hasRunningTurns() || hasRunningCompactions()) {
		throw new DataDirectoryBusyError("A session turn or compaction is running. Wait for it to finish before changing the data directory.");
	}
	if (hasLiveJobs()) throw new DataDirectoryBusyError("Background jobs are still running. Wait for them to finish before changing the data directory.");
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
		const deleteOld = copyMode === "copy" && r.deleteOld === true;
		const expectedSource = typeof r.expectedSource === "string" ? r.expectedSource : undefined;
		if (deleteOld && !expectedSource) throw new DataDirectoryInputError("Confirm the current source folder before deleting old data.");
		if (r.action === "reset") {
			return { action: "reset", copyMode, deleteOld, expectedSource };
		}
		if (typeof r.path !== "string" || !r.path.trim()) {
			throw new DataDirectoryInputError("Data directory path must be a non-empty string.");
		}
		return { action: "change", path: r.path, copyMode, deleteOld, expectedSource };
	}
	throw new DataDirectoryInputError("Unknown data directory action.");
}

export async function mutateDataDirectory(raw: unknown, home: string = os.homedir()): Promise<DataDirectoryStatus> {
	const request = parseDataDirectoryRequest(raw);
	if (DATA_DIR_FIXED) throw new DataDirectoryInputError("LH_DATA_DIR fixes the data folder for this session. Relaunch with a location pointer to change it in Settings.");
	const release = beginDataMigration();
	let changed = false;
	try {
		assertNotBusy();
		const state = getDataLocationState();
		const { currentDir: previousDir, defaultDir } = state;
		if (request.action === "retry-configured") {
			const resolved = inspectDataLocation({ configFile: DATA_CONFIG_FILE, defaultDir, appRoot: ROOT, authFile: AUTH_FILE });
			if (resolved.unavailableConfiguredDir || (state.configuredDir &&
				(resolved.configuredDir !== state.configuredDir || resolved.storeId !== activeStoreId()))) {
				throw new DataDirectoryInputError(resolved.recoveryReason ?? "The configured folder changed. Choose a folder explicitly.");
			}
			await disposePluginsForDataChange();
			setActiveDataDir(resolved.currentDir, resolved);
			changed = true;
			return getDataDirectoryStatus();
		}

		const recovery = request.action === "use-default";
		const copy = !recovery && request.copyMode === "copy";
		const deleteOld = copy && request.deleteOld;
		if (deleteOld && request.expectedSource !== previousDir) {
			throw new DataDirectoryInputError("The source folder changed. Reopen the confirmation before deleting old data.");
		}
		if (copy && state.unavailableConfiguredDir) {
			throw new DataDirectoryInputError("Reconnect the configured data folder before copying.");
		}
		const sourceId = activeStoreId();
		const sourceStat = copy ? fs.lstatSync(/* turbopackIgnore: true */ previousDir, { throwIfNoEntry: false }) : undefined;
		const checkSource = () => {
			if (state.configuredDir) verifyStore(previousDir, sourceId);
			const current = fs.lstatSync(/* turbopackIgnore: true */ previousDir, { throwIfNoEntry: false });
			if (!current?.isDirectory() || !sourceStat || current.dev !== sourceStat.dev || current.ino !== sourceStat.ino) {
				throw new Error("The source folder became unavailable or changed.");
			}
		};
		let targetDir: string;
		let isDefaultTarget: boolean;
		try {
			const value = request.action === "change" ? expandHomePath(request.path, home) : defaultDir;
			targetDir = validateTarget(value, {
				source: !recovery && (!state.unavailableConfiguredDir || (state.configuredDir && path.relative(previousDir, value) !== ""))
					? previousDir : null,
				defaultDir, appRoot: ROOT, authFile: AUTH_FILE, home,
				protectedPath: (candidate: string) => isSensitivePath(candidate, home),
			});
			isDefaultTarget = path.relative(canonicalPath(defaultDir), targetDir) === "";
			if (copy) {
				if (sourceStat) assertOrdinary(sourceStat, previousDir);
				checkSource();
				readStoreId(previousDir);
			}
			if (request.action === "change" && state.unavailableConfiguredDir) validateTree(targetDir);
		} catch (error) {
			throw new DataDirectoryInputError((error as Error).message);
		}
		let staged: Awaited<ReturnType<typeof stageDataCopy>> | undefined;
		try {
			if (copy) {
				staged = await stageDataCopy(previousDir, targetDir, checkSource, !isDefaultTarget, disposePluginsForDataChange);
			} else {
				await createTargetDirectory(targetDir);
				await disposePluginsForDataChange();
			}
			validateTree(targetDir);
		} catch (error) {
			throw new DataDirectoryInputError(`Could not prepare "${targetDir}": ${(error as Error).message}`);
		}
		let storeId: string | null;
		try {
			storeId = writeConfiguredDataDirPath(DATA_CONFIG_FILE, isDefaultTarget ? null : targetDir, fs, staged?.storeId);
		} catch (error) {
			const message = `Could not save the data folder location: ${(error as Error).message}`;
			if (staged) {
				try {
					const persisted = readPointer(DATA_CONFIG_FILE)?.dataDir ?? defaultDir;
					if (path.relative(persisted, targetDir) !== "") await staged.rollback();
				} catch (rollback) {
					throw new Error(`${message} Could not restore the destination: ${(rollback as Error).message}`);
				}
			}
			throw new Error(message);
		}
		setActiveDataDir(targetDir, { configuredDir: isDefaultTarget ? null : targetDir, storeId });
		changed = true;
		const cleanupFailures = deleteOld && staged
			? process.platform === "win32"
				? ["Old data was kept because directory durability cannot be verified on Windows."]
				: await cleanOldData(previousDir, targetDir, staged.expected, () => {
					checkSource();
					staged.checkTarget();
				})
			: [];
		return { ...getDataDirectoryStatus(), cleanupFailures };
	} finally {
		release();
		if (changed) broadcastDataDirSwitch();
	}
}
