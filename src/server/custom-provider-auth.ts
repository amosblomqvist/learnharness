/** Custom-only credential composition. File credentials and their authorization
 *  are read from the same atomic record, never a stale fill-gapped env copy.
 *  Each endpoint resolves its own pair, so one endpoint's key can never answer
 *  for another's. */
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { authEnvRecord } from "../core/auth-env.ts";
import { customBindingMatches, type CustomAuthBinding } from "../core/custom-provider-auth.ts";
import { CUSTOM_PROVIDER_ID, type CustomProviderSettings } from "../core/settings.ts";
import { readCustomAuth, writeCustomAuth } from "../store/auth.ts";

export interface CustomAuthState {
	readable: boolean;
	binding?: CustomAuthBinding;
	key?: string;
	fileKey?: string;
	source: "env" | "file" | "none";
}
/** THE environment override, kept for the endpoint the single-endpoint era
 *  wrote (`custom`) — CUSTOM_OPENAI_API_KEY has no way to name a second one. */
function envOwnsKey(providerId: string): boolean {
	return providerId === CUSTOM_PROVIDER_ID;
}
/** requiredConfig prevents even credential resolution until startup/runtime
 *  authorization matches. Explicit UI inspection/probe authorization omits it. */
export function customAuthState(providerId: string, inspectKey = false, requiredConfig?: CustomProviderSettings): CustomAuthState {
	try {
		const snapshot = readCustomAuth(providerId);
		const result: CustomAuthState = { readable: true, binding: snapshot.binding, source: "none" };
		if (!inspectKey || (requiredConfig && !customBindingMatches(requiredConfig, snapshot.binding))) return result;
		result.fileKey = snapshot.fileKey();
		const record = authEnvRecord();
		const envKey = envOwnsKey(providerId) && process.env.LH_IGNORE_ENV_KEYS !== "1" && record.realEnv.has(CUSTOM_PROVIDER.envVar) ? process.env[CUSTOM_PROVIDER.envVar] : undefined;
		result.source = envKey !== undefined ? "env" : result.fileKey !== undefined ? "file" : "none";
		result.key = (envKey ?? result.fileKey)?.trim() || undefined;
		return result;
	} catch { return { readable: false, source: "none" }; }
}
export function customKeyAuthorized(cp: CustomProviderSettings | undefined, state: CustomAuthState): boolean {
	return cp?.authMode === "apiKey" && state.readable && customBindingMatches(cp, state.binding) && Boolean(state.key) && (state.source === "env" || state.binding?.fileKeyBaseUrl === cp?.baseUrl);
}
/** Reflect only after the atomic pair is committed. Runtime file resolution
 *  does not rely on this compatibility mirror, including after a failed write. */
export function persistCustomAuth(providerId: string, binding: CustomAuthBinding | undefined, fileKey: string | undefined): void {
	writeCustomAuth(providerId, binding, fileKey);
	if (!envOwnsKey(providerId)) return;
	const record = authEnvRecord();
	if (!record.realEnv.has(CUSTOM_PROVIDER.envVar)) {
		if (fileKey === undefined) { delete process.env[CUSTOM_PROVIDER.envVar]; record.fillGap.delete(CUSTOM_PROVIDER.envVar); }
		else { process.env[CUSTOM_PROVIDER.envVar] = fileKey; record.fillGap.add(CUSTOM_PROVIDER.envVar); }
	}
}
