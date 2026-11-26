/** Private custom credential authorization; no credential-derived public value. */
import { CUSTOM_PROVIDER_ID, isCustomProviderId, normalizeBaseUrl, type CustomProviderSettings } from "./settings.ts";

/** The record that authorized the (now migrated) single-endpoint era. Still
 *  READ as the fallback for the `custom` endpoint and mirrored on write, so a
 *  downgrade keeps working. */
export const CUSTOM_AUTH_BINDING = "__learnharness_custom_provider_binding";

/** THE per-endpoint record: one entry per custom endpoint, each holding its
 *  authorization binding and its key. One JSON string in the same atomic auth
 *  record, so a key and its authorization can never drift apart. */
export const CUSTOM_AUTH_ENTRIES = "__learnharness_custom_provider_entries";

/** Is this auth-file name one of the custom endpoints' own records? */
export function isCustomAuthRecord(name: string): boolean {
	return name === CUSTOM_AUTH_BINDING || name === CUSTOM_AUTH_ENTRIES;
}

export interface CustomAuthBinding {
	version: 1;
	/** Server-owned random nonce; never a credential hash. */
	id: string;
	/** WHICH endpoint this authorization belongs to. A binding written by the
	 *  single-endpoint era carries no provider id and is read as `custom`. */
	providerId: string;
	baseUrl?: string;
	authMode: "apiKey" | "keyless" | "disabled";
	/** A shadowed file key keeps its own destination when an env key moves. */
	fileKeyBaseUrl?: string;
}
export function parseCustomAuthBinding(value: unknown): CustomAuthBinding | undefined {
	try {
		const b = typeof value === "string" ? JSON.parse(value) : undefined;
		if (!b || b.version !== 1 || typeof b.id !== "string" || !/^[a-f0-9]{32}$/.test(b.id)) return;
		if (!["apiKey", "keyless", "disabled"].includes(b.authMode)) return;
		// Absent (the single-endpoint era) reads as the endpoint that era wrote.
		const providerId = b.providerId === undefined ? CUSTOM_PROVIDER_ID : b.providerId;
		if (typeof providerId !== "string" || !isCustomProviderId(providerId)) return;
		if (b.authMode !== "disabled" && b.baseUrl === undefined) return;
		if (b.baseUrl !== undefined && (typeof b.baseUrl !== "string" || !b.baseUrl || normalizeBaseUrl(b.baseUrl) !== b.baseUrl)) return;
		if (b.fileKeyBaseUrl !== undefined && (typeof b.fileKeyBaseUrl !== "string" || !b.fileKeyBaseUrl || normalizeBaseUrl(b.fileKeyBaseUrl) !== b.fileKeyBaseUrl)) return;
		return { version: 1, id: b.id, providerId, authMode: b.authMode, ...(b.baseUrl !== undefined ? { baseUrl: b.baseUrl } : {}), ...(b.fileKeyBaseUrl !== undefined ? { fileKeyBaseUrl: b.fileKeyBaseUrl } : {}) };
	} catch { return; }
}
export function customBindingMatches(cp: CustomProviderSettings | undefined, binding: CustomAuthBinding | undefined): boolean {
	return Boolean(cp?.baseUrl && binding && binding.authMode !== "disabled" && cp.id === binding.providerId && cp.credentialBindingId === binding.id && cp.baseUrl === binding.baseUrl && cp.authMode === binding.authMode);
}
