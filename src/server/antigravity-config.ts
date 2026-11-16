import { settingsStore } from "../store/settings.ts";

/** Fresh admission state, not a process-wide cache. */
export function antigravityEnabled(): boolean {
	return settingsStore.readSettings()?.antigravity?.enabled === true;
}

export function antigravityBinaryPath(): string | undefined {
	const value = settingsStore.readSettings()?.antigravity?.binaryPath?.trim();
	return value || undefined;
}
