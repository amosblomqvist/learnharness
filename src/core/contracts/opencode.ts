export const OPENCODE_PROVIDER = "opencode-cli";

export interface OpenCodeStatus {
	state: "not-found" | "meets-minimum" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
}

export const OPENCODE_MINIMUM_VERSION = "2.3.2";
