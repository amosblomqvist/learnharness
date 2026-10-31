/** Custom-only credential composition. File credentials and their authorization
 * are read from the same atomic record, never a stale fill-gapped env copy.
 * The legacy endpoint may also be keyed by CUSTOM_OPENAI_API_KEY; additional
 * endpoints keep their credential in auth.json only. */
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { authEnvRecord } from "../core/auth-env.ts";
import { customBindingMatches, type CustomAuthBinding } from "../core/custom-provider-auth.ts";
import type { CustomProviderSettings } from "../core/settings.ts";
import { readCustomAuth, writeCustomAuth } from "../store/auth.ts";

export interface CustomAuthState {
	readable: boolean;
	binding?: CustomAuthBinding;
	key?: string;
	fileKey?: string;
	source: "env" | "file" | "none";
}
/** requiredConfig prevents even credential resolution until startup/runtime
 * authorization matches. Explicit UI inspection/probe authorization omits it. */
export function customAuthState(id: string = CUSTOM_PROVIDER.id, inspectKey = false, requiredConfig?: CustomProviderSettings): CustomAuthState {
	try {
		const snapshot = readCustomAuth(id);
		const result: CustomAuthState = { readable: true, binding: snapshot.binding, source: "none" };
		if (!inspectKey || (requiredConfig && !customBindingMatches(requiredConfig, snapshot.binding))) return result;
		result.fileKey = snapshot.fileKey();
		const record = authEnvRecord();
		// Only the legacy endpoint has an environment override. A new endpoint's
		// credential is file-only, so a stale CUSTOM_OPENAI_API_KEY can never be
		// forwarded to a server the user did not enter it for.
		const envKey = id === CUSTOM_PROVIDER.id && process.env.LH_IGNORE_ENV_KEYS !== "1" && record.realEnv.has(CUSTOM_PROVIDER.envVar) ? process.env[CUSTOM_PROVIDER.envVar] : undefined;
		result.source = envKey !== undefined ? "env" : result.fileKey !== undefined ? "file" : "none";
		result.key = (envKey ?? result.fileKey)?.trim() || undefined;
		return result;
	} catch { return { readable: false, source: "none" }; }
}
export function customKeyAuthorized(cp: CustomProviderSettings | undefined, state: CustomAuthState): boolean {
	return cp?.authMode === "apiKey" && state.readable && customBindingMatches(cp, state.binding) && Boolean(state.key) && (state.source === "env" || state.binding?.fileKeyBaseUrl === cp?.baseUrl);
}
/** Reflect only after the atomic pair is committed. Runtime file resolution
 * does not rely on this compatibility mirror, including after a failed write.
 * Additional endpoints have no environment mirror. */
export function persistCustomAuth(id: string, binding: CustomAuthBinding | undefined, fileKey: string | undefined): void {
	writeCustomAuth(id, binding, fileKey);
	if (id !== CUSTOM_PROVIDER.id) return;
	const record = authEnvRecord();
	if (!record.realEnv.has(CUSTOM_PROVIDER.envVar)) {
		if (fileKey === undefined) { delete process.env[CUSTOM_PROVIDER.envVar]; record.fillGap.delete(CUSTOM_PROVIDER.envVar); }
		else { process.env[CUSTOM_PROVIDER.envVar] = fileKey; record.fillGap.add(CUSTOM_PROVIDER.envVar); }
	}
}
