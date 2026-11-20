export type DataMigrationMode = "copy" | "switch";

export type DataDirectorySource = { path: string } & (
	| { storeId: string }
	| { storeId: null; device: string; inode: string }
);

export interface DataDirectoryStatus {
	currentDir: string;
	copySource: DataDirectorySource | null;
	defaultDir: string;
	isCustom: boolean;
	configuredDir: string | null;
	unavailableConfiguredDir: string | null;
	recoveryReason: string | null;
	fixed: boolean;
	platform: NodeJS.Platform;
	cleanupFailures?: string[];
}
