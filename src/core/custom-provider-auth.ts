/** Private custom credential authorization; no credential-derived public value. */
import { CUSTOM_PROVIDER, isCustomProviderId } from "./auth-keys.ts";
import { normalizeBaseUrl, type CustomProviderSettings } from "./settings.ts";

export const CUSTOM_AUTH_BINDING = "__learnharness_custom_provider_binding";
/** Auth.json key prefix for additional endpoints' file credentials. The
 *  legacy endpoint keeps CUSTOM_PROVIDER.envVar for compatibility. */
export const CUSTOM_CREDENTIAL_PREFIX = "__learnharness_custom_provider_key__";
/** Binding records for additional endpoints: legacy keeps the unsuffixed
 *  name, every other endpoint appends `__<provider id>`. */
const CUSTOM_BINDING_PREFIX = `${CUSTOM_AUTH_BINDING}__`;

export function customBindingAuthKey(id: string): string {
	return id === CUSTOM_PROVIDER.id ? CUSTOM_AUTH_BINDING : `${CUSTOM_BINDING_PREFIX}${id}`;
}

export function customCredentialAuthKey(id: string): string {
	return id === CUSTOM_PROVIDER.id ? CUSTOM_PROVIDER.envVar : `${CUSTOM_CREDENTIAL_PREFIX}${id}`;
}

/** Every auth.json name owned by the custom-endpoint editor. Generic key
 *  writes must never touch these. */
export function isReservedCustomAuthKey(name: string): boolean {
	return name === CUSTOM_AUTH_BINDING || name.startsWith(CUSTOM_BINDING_PREFIX)
		|| name === CUSTOM_PROVIDER.envVar || name.startsWith(CUSTOM_CREDENTIAL_PREFIX);
}

/** Provider id carried by a stored section; absent = the legacy endpoint. */
export function customProviderId(provider: CustomProviderSettings | undefined): string {
	return provider?.id && isCustomProviderId(provider.id) ? provider.id : CUSTOM_PROVIDER.id;
}

export interface CustomAuthBinding {
	version: 1;
	id: string;
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
		if (b.authMode !== "disabled" && b.baseUrl === undefined) return;
		if (b.baseUrl !== undefined && (typeof b.baseUrl !== "string" || !b.baseUrl || normalizeBaseUrl(b.baseUrl) !== b.baseUrl)) return;
		if (b.fileKeyBaseUrl !== undefined && (typeof b.fileKeyBaseUrl !== "string" || !b.fileKeyBaseUrl || normalizeBaseUrl(b.fileKeyBaseUrl) !== b.fileKeyBaseUrl)) return;
		return { version: 1, id: b.id, authMode: b.authMode, ...(b.baseUrl !== undefined ? { baseUrl: b.baseUrl } : {}), ...(b.fileKeyBaseUrl !== undefined ? { fileKeyBaseUrl: b.fileKeyBaseUrl } : {}) };
	} catch { return; }
}
export function customBindingMatches(cp: CustomProviderSettings | undefined, binding: CustomAuthBinding | undefined): boolean {
	return Boolean(cp?.baseUrl && binding && binding.authMode !== "disabled" && cp.credentialBindingId === binding.id && cp.baseUrl === binding.baseUrl && cp.authMode === binding.authMode);
}
