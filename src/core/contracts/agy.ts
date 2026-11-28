export const AGY_PROVIDER = "agy";

export const AGY_MINIMUM_VERSION = "1.5.0";

export interface AgyStatus {
	state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
}
