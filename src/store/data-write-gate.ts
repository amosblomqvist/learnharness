import fs from "node:fs";

/** Shared across the separately bundled Next route modules in this process. */
interface Gate {
	migrating: boolean;
	activities: number;
	filesystem?: {
		verify(file?: string): void;
		mkdir(directory: string, mode?: number): void;
	};
}
const globals = globalThis as typeof globalThis & { __lhDataWriteGate?: Gate };
const gate: Gate = (globals.__lhDataWriteGate ??= { migrating: false, activities: 0 });

export class DataDirectoryBusyError extends Error {
	override name = "DataDirectoryBusyError";
}

export function dataMigrationInProgress(): boolean {
	return gate.migrating;
}

export function assertDataWritesAdmitted(): void {
	if (gate.migrating) throw new DataDirectoryBusyError("A data folder change is in progress. Try again when it finishes.");
}

export function beginDataActivity(): () => void {
	assertDataWritesAdmitted();
	gate.activities++;
	return () => { gate.activities--; };
}

export function beginDataMigration(): () => void {
	assertDataWritesAdmitted();
	if (gate.activities) throw new DataDirectoryBusyError("A turn, conversation, plugin operation, or background job is running. Wait for it to finish before changing the data folder.");
	gate.migrating = true;
	return () => { gate.migrating = false; };
}

// Low-level adapters can be used independently of the app configuration.
// The application installs the managed-root policy when config.ts loads.
export function configureDataWriteAccess(filesystem: NonNullable<Gate["filesystem"]>): void {
	gate.filesystem = filesystem;
}

export function assertDataStoreWritable(file?: string): void {
	gate.filesystem?.verify(file);
}

export function mkdirDataDirectory(directory: string, mode?: number): void {
	if (gate.filesystem) gate.filesystem.mkdir(directory, mode);
	else fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true, mode });
}
