import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AUTH_FILE,
	activeStoreId,
	DATA_DIR_FIXED,
	DATA_CONFIG_FILE,
	getDataLocationState,
	DATA_APP_ROOT,
	setActiveDataDir,
} from "../../config.ts";
import { hasExtractionsInFlight } from "../agent/subagents/extraction.ts";
import { hasLiveJobs } from "../agent/subagents/aborts.ts";
import type { DataDirectorySource, DataDirectoryStatus, DataMigrationMode } from "../core/contracts/data-directory.ts";
import { emit } from "../core/events.ts";
import { beginDataMigration, blockDataWritesForRecovery, dataWriteRecoveryReason, DataDirectoryBusyError } from "../store/data-write-gate.ts";
import { canonicalPath, DataLocationRecoveryError, inspectDataLocation, readStoreId, validateTarget, validateTree, verifyStore, writeConfiguredDataDirPath } from "../../electron/data-location.cjs";
import { cleanOldData, createTargetDirectory, stageDataCopy } from "./data-directory-files.ts";
import { disposePluginsForDataChange } from "./plugins.ts";
import { hasRunningCompactions } from "./compaction.ts";
import { pluginWorkerActivities } from "./plugin-worker-activity.ts";
import { hasRunningTurns } from "./turn-liveness.ts";

export class DataDirectoryInputError extends Error {}
export { DataDirectoryBusyError };

export type DataDirectoryRequest =
	| {
			action: "change";
			path: string;
			copyMode: DataMigrationMode;
			deleteOld?: boolean;
			expectedSource?: DataDirectorySource;
	  }
	| {
			action: "reset";
			copyMode: DataMigrationMode;
			deleteOld?: boolean;
			expectedSource?: DataDirectorySource;
	  }
	| {
			action: "retry-configured";
	  }
	| {
			action: "use-default";
	  };

function describeCopySource(directory: string, stat: fs.BigIntStats, storeId: string | null): DataDirectorySource {
	return storeId === null
		? { path: directory, storeId, device: String(stat.dev), inode: String(stat.ino) }
		: { path: directory, storeId };
}

function copySourceForStatus(state: ReturnType<typeof getDataLocationState>): DataDirectorySource | null {
	if (state.unavailableConfiguredDir) return null;
	try {
		const stat = fs.lstatSync(/* turbopackIgnore: true */ state.currentDir, { bigint: true, throwIfNoEntry: false });
		if (!stat?.isDirectory()) return null;
		const storeId = state.configuredDir ? activeStoreId() : readStoreId(state.currentDir);
		return describeCopySource(state.currentDir, stat, storeId);
	} catch {
		return null;
	}
}

function parseCopySource(value: unknown): DataDirectorySource {
	if (value && typeof value === "object") {
		const { path: directory, storeId, device, inode } = value as Record<string, unknown>;
		if (typeof directory === "string" && directory) {
			if (typeof storeId === "string" && storeId) return { path: directory, storeId };
			if (storeId === null && typeof device === "string" && typeof inode === "string") {
				return { path: directory, storeId, device, inode };
			}
		}
	}
	throw new DataDirectoryInputError("Confirm the current source folder before copying data.");
}

function sameCopySource(confirmed: DataDirectorySource, current: DataDirectorySource): boolean {
	if (confirmed.path !== current.path || confirmed.storeId !== current.storeId) return false;
	return confirmed.storeId !== null ||
		(current.storeId === null && confirmed.device === current.device && confirmed.inode === current.inode);
}

export function getDataDirectoryStatus(): DataDirectoryStatus {
	const state = getDataLocationState();
	const recoveryReason = dataWriteRecoveryReason();
	return {
		...state, platform: process.platform, copySource: recoveryReason ? null : copySourceForStatus(state),
		...(recoveryReason ? { unavailableConfiguredDir: state.currentDir, recoveryReason } : {}),
	};
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
		const expectedSource = copyMode === "copy" ? parseCopySource(r.expectedSource) : undefined;
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
			const resolved = inspectDataLocation({ configFile: DATA_CONFIG_FILE, defaultDir, appRoot: DATA_APP_ROOT, authFile: AUTH_FILE });
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
		const expectedSource = !recovery ? request.expectedSource : undefined;
		const deleteOld = copy && request.deleteOld;
		if (copy && state.unavailableConfiguredDir) {
			throw new DataDirectoryInputError("Reconnect the configured data folder before copying.");
		}
		const sourceId = activeStoreId();
		let sourceStat: fs.BigIntStats | undefined;
		const checkSource = () => {
			if (state.configuredDir) verifyStore(previousDir, sourceId);
			const current = fs.lstatSync(/* turbopackIgnore: true */ previousDir, { bigint: true, throwIfNoEntry: false });
			if (!current?.isDirectory() || !sourceStat || current.dev !== sourceStat.dev || current.ino !== sourceStat.ino) {
				throw new Error("The source folder became unavailable or changed.");
			}
			const storeId = state.configuredDir ? sourceId : readStoreId(previousDir);
			if (!expectedSource || !sameCopySource(expectedSource, describeCopySource(previousDir, current, storeId))) {
				throw new Error("The source folder changed. Reopen the confirmation before copying data.");
			}
		};
		let targetDir: string;
		let isDefaultTarget: boolean;
		try {
			const value = request.action === "change" ? expandHomePath(request.path, home) : defaultDir;
			targetDir = validateTarget(value, {
				source: !recovery && !state.unavailableConfiguredDir ? previousDir : null,
				defaultDir, appRoot: DATA_APP_ROOT, authFile: AUTH_FILE, home,
			});
			isDefaultTarget = path.relative(canonicalPath(defaultDir), targetDir) === "";
			if (copy) {
				sourceStat = fs.lstatSync(/* turbopackIgnore: true */ previousDir, { bigint: true, throwIfNoEntry: false });
				checkSource();
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
		let durabilityWarning: string | undefined;
		try {
			staged?.checkTarget();
			storeId = writeConfiguredDataDirPath(DATA_CONFIG_FILE, isDefaultTarget ? null : targetDir, fs, staged?.storeId, warning => {
				durabilityWarning = warning;
			});
		} catch (error) {
			if (error instanceof DataLocationRecoveryError) {
				blockDataWritesForRecovery(error.message);
				throw error;
			}
			const message = `Could not save the data folder location: ${(error as Error).message}`;
			try {
				await staged?.rollback();
			} catch (rollback) {
				throw new Error(`${message} Could not restore the destination: ${(rollback as Error).message}`);
			}
			throw new Error(message);
		}
		try {
			staged?.checkTarget();
			setActiveDataDir(targetDir, { configuredDir: isDefaultTarget ? null : targetDir, storeId });
		} catch (error) {
			const message = `Restart to recover the data folder. ${(error as Error).message}`;
			blockDataWritesForRecovery(message);
			throw new DataLocationRecoveryError(message);
		}
		changed = true;
		const cleanupFailures = durabilityWarning ? [durabilityWarning] : deleteOld && staged
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
