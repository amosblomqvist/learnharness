/** The local transcription key's URL binding: the key is only ever sent to
 * the base URL it was saved for (the custom endpoint's binding principle). */
import { normalizeBaseUrl } from "./settings.ts";

export const LOCAL_STT_AUTH_BINDING = "__learnharness_local_stt_binding";
export interface LocalSttAuthBinding {
	version: 1;
	/** Normalized base URL the stored key was saved for. */
	baseUrl: string;
}
export function parseLocalSttAuthBinding(value: unknown): LocalSttAuthBinding | undefined {
	try {
		const b = typeof value === "string" ? JSON.parse(value) : undefined;
		if (!b || b.version !== 1 || typeof b.baseUrl !== "string" || !b.baseUrl || normalizeBaseUrl(b.baseUrl) !== b.baseUrl) return;
		return { version: 1, baseUrl: b.baseUrl };
	} catch { return; }
}
