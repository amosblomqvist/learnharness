export const ANTIGRAVITY_PROVIDER = "antigravity";

export interface AntigravityStatus {
	state: "not-found" | "ready" | "unsupported";
	version: string | null;
}
