/** Custom-only credential composition. File credentials and their authorization
 * are read from the same atomic record, never a stale fill-gapped env copy. */
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
export function customAuthState(inspectKey = false, requiredConfig?: CustomProviderSettings): CustomAuthState {
	try {
		const snapshot = readCustomAuth();
		const result: CustomAuthState = { readable: true, binding: snapshot.binding, source: "none" };
		if (!inspectKey || (requiredConfig && !customBindingMatches(requiredConfig, snapshot.binding))) return result;
		result.fileKey = snapshot.fileKey();
		const record = authEnvRecord();
		const envKey = process.env.LH_IGNORE_ENV_KEYS !== "1" && record.realEnv.has(CUSTOM_PROVIDER.envVar) ? process.env[CUSTOM_PROVIDER.envVar] : undefined;
		result.source = envKey !== undefined ? "env" : result.fileKey !== undefined ? "file" : "none";
		result.key = (envKey ?? result.fileKey)?.trim() || undefined;
		return result;
	} catch { return { readable: false, source: "none" }; }
}
export function customKeyAuthorized(cp: CustomProviderSettings | undefined, state: CustomAuthState): boolean {
	return cp?.authMode === "apiKey" && state.readable && customBindingMatches(cp, state.binding) && Boolean(state.key) && (state.source === "env" || state.binding?.fileKeyBaseUrl === cp?.baseUrl);
}
/** Reflect only after the atomic pair is committed. Runtime file resolution
 * does not rely on this compatibility mirror, including after a failed write. */
export function persistCustomAuth(binding: CustomAuthBinding | undefined, fileKey: string | undefined): void {
	writeCustomAuth(binding, fileKey);
	const record = authEnvRecord();
	if (!record.realEnv.has(CUSTOM_PROVIDER.envVar)) {
		if (fileKey === undefined) { delete process.env[CUSTOM_PROVIDER.envVar]; record.fillGap.delete(CUSTOM_PROVIDER.envVar); }
		else { process.env[CUSTOM_PROVIDER.envVar] = fileKey; record.fillGap.add(CUSTOM_PROVIDER.envVar); }
	}
}
