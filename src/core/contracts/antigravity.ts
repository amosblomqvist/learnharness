export const ANTIGRAVITY_PROVIDER = "antigravity";

export const ANTIGRAVITY_PROFILE_DIRNAME = "antigravity-profile";

export const ANTIGRAVITY_MINIMUM_CLI_VERSION = "1.5.0";

export const ANTIGRAVITY_MANAGED_VERSION = "1.4.5";

export interface AntigravitySettings {
	enabled?: boolean;
	binaryPath?: string;
}

export type AntigravityRuntimeSource = "env" | "custom" | "managed" | "cli" | "t3-external";

export type AntigravityInstallPhase =
	| "idle"
	| "downloading"
	| "verifying"
	| "extracting"
	| "validating"
	| "installed"
	| "error";

export interface AntigravityInstallProgress {
	phase: AntigravityInstallPhase;
	downloadedBytes?: number;
	totalBytes?: number;
	error?: string | null;
}

export type AntigravityAuthPhase =
	| "idle"
	| "starting"
	| "waiting"
	| "verifying"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface AntigravityAuthState {
	signedIn: boolean;
	phase: AntigravityAuthPhase;
	attemptId: string | null;
	authUrl: string | null;
	error: string | null;
}

export interface AntigravityModelsStatus {
	count: number;
	updatedAt: string | null;
	discovering: boolean;
	error: string | null;
}

/** Client-safe runtime & installer status DTO for Settings. */
export interface AntigravityStatus {
	enabled: boolean;
	binaryPath: string | null;
	state: "not-installed" | "ready" | "update-required" | "error";
	source: AntigravityRuntimeSource | null;
	version: string | null;
	minimumCliVersion: string;
	managedInstalled: boolean;
	busy: boolean;
	install: AntigravityInstallProgress;
	auth: AntigravityAuthState;
	models?: AntigravityModelsStatus;
	error: string | null;
}
