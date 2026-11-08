export const CODEX_PROVIDER = "codex";
export interface CodexStatus {
	enabled: boolean;
	state: "disabled" | "not-found" | "signed-out" | "signing-in" | "connected" | "error";
	modelCount: number;
	error?: string;
	/** Public authorization action, never an access/refresh token. */
	authUrl?: string;
}
