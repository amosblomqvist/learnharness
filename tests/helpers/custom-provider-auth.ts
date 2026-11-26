/** Synthetic authorized records, imported only after each test's isolated env. */
import { randomBytes } from "node:crypto";
import type { CustomProviderSettings } from "../../src/core/settings.ts";
import { persistCustomAuth } from "../../src/server/custom-provider-auth.ts";

/** Authorize ONE endpoint: its own binding nonce, its own key. */
export function authorizeFixture(cp: CustomProviderSettings, fileKey?: string): CustomProviderSettings {
	const id = randomBytes(16).toString("hex");
	persistCustomAuth(cp.id, { version: 1, id, providerId: cp.id, baseUrl: cp.baseUrl, authMode: cp.authMode ?? "keyless", ...(fileKey ? { fileKeyBaseUrl: cp.baseUrl } : {}) }, fileKey);
	return { ...cp, credentialBindingId: id };
}
