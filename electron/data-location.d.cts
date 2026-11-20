import type fs from "node:fs";

export interface DataLocation {
	currentDir: string;
	defaultDir: string;
	configuredDir: string | null;
	storeId: string | null;
	unavailableConfiguredDir: string | null;
	recoveryReason: string | null;
}

interface LocationOptions {
	configFile: string | null;
	defaultDir: string;
	appRoot?: string;
	authFile?: string;
	fsImpl?: typeof fs;
}

interface TargetOptions {
	source?: string | null;
	defaultDir: string;
	appRoot?: string;
	authFile?: string;
	protectedPath?: (path: string) => boolean;
	home?: string;
	disk?: typeof fs;
}

export const STORE_MARKER: string;
export const MANAGED_ITEMS: readonly string[];
export const SENSITIVE_HOME_PATHS: readonly string[];

export function isFullPath(value: string, platform?: NodeJS.Platform): boolean;
export function canonicalPath(value: string, disk?: typeof fs): string;
export function assertOrdinary(stat: fs.Stats, file: string): void;
export function validateTarget(value: string, options: TargetOptions): string;
export function validateTree(root: string, disk?: typeof fs): void;
export function readPointer(file: string | null, disk?: typeof fs): { dataDir: string; storeId: string | null } | null;
export function readStoreId(root: string, disk?: typeof fs): string | null;
export function verifyStore(root: string, storeId: string | null, disk?: typeof fs): void;
export function ensureStoreId(root: string, disk?: typeof fs): string;
export function syncDirectory(root: string, disk?: typeof fs): void;
export function writeConfiguredDataDirPath(file: string, directory: string | null, disk?: typeof fs, expectedStoreId?: string | null): string | null;
export function inspectDataLocation(options: LocationOptions): DataLocation;
