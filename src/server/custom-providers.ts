import { noStoreJson } from "./connection-guard.ts";
/**
 * Custom provider CRUD service + request handlers.
 *
 * Exports:
 *  - CustomProviderError (status: 400 | 404 | 409 | 500, safe message)
 *  - createCustomProviderService({ store, credentials }): CustomProviderService
 *      list(): CustomProviderStatus[]
 *      put(def, apiKey?): Promise<CustomProviderStatus>
 *      remove(id): Promise<void>
 *  - customProvidersHandlers(resolveService?): { get, put, delete }  (Request -> Response)
 *      Used by app/api/connections/custom/route.ts. Does NOT call the guard;
 *      the route does (connectionGuard, via the server barrel).
 *  - MAX_CUSTOM_PROVIDER_BODY_BYTES
 *
 * Key ownership rules (a stored key is bound to the endpoint it was saved for):
 *  - New id: needs a new apiKey or keyless:true (stale orphan keys are never adopted).
 *  - Same id, same normalized baseUrl AND same api, keyless:false, apiKey omitted:
 *    the existing key is kept (and must exist).
 *  - baseUrl OR api changed: omitted key is rejected unless keyless:true.
 *  - keyless:true with apiKey is rejected; keyless:true clears any stored key.
 *  - Previously keyless -> keyless:false needs a new apiKey.
 *  - Order: the credential is replaced/cleared BEFORE metadata is written, so a
 *    failed metadata write can never leave an old key bound to a new endpoint.
 *  - Delete removes metadata, then the key.
 * - Every stored credential carries env binding fields LH_CUSTOM_PROVIDER_BASE_URL
 *   and LH_CUSTOM_PROVIDER_API (the normalized endpoint it was saved for). An
 *   omitted key is accepted only when the stored credential's binding matches the
 *   definition, and keyPresent is true only for a matching binding; the runtime
 *   must refuse a mismatched binding before sending. Unbound (legacy) keys are
 *   never adopted.
 * - All put/remove calls on a service instance run through one in-process queue.
 *   That is tested for same-provider concurrent calls; cross-process locking is
 *   NOT provided, and the credential/metadata pair is not a transaction (the
 *   binding is what keeps a failure between the two writes from leaking a key).
 * Keys are never returned, logged, or included in error messages.
 */

import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { CustomProviderDefinition, CustomProviderStatus } from "../core/provider-connections.ts";
import {
	isCustomProviderId,
	validateCustomApiKey,
	validateCustomProviderDefinition,
} from "../core/custom-provider-validation.ts";
import { CustomProviderStoreError, type CustomProviderStore } from "../store/custom-providers.ts";

export const MAX_CUSTOM_PROVIDER_BODY_BYTES = 64 * 1024;

export class CustomProviderError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 500,
		message: string,
	) {
		super(message);
		this.name = "CustomProviderError";
	}
}

export const CUSTOM_BINDING_BASE_URL = "LH_CUSTOM_PROVIDER_BASE_URL";
export const CUSTOM_BINDING_API = "LH_CUSTOM_PROVIDER_API";

export type CustomProviderCredentials = Pick<CredentialStore, "modify" | "delete"> & {
	has(id: string): boolean;
	peek(id: string): Credential | undefined;
};

/** True only for an api_key credential carrying a key whose binding env
 *  matches this definition's normalized baseUrl and api. No legacy adoption. */
export function credentialMatchesBinding(c: Credential | undefined, def: Pick<CustomProviderDefinition, "baseUrl" | "api">): boolean {
	return !!c && c.type === "api_key" && typeof c.key === "string" && c.key.length > 0 && c.env?.[CUSTOM_BINDING_BASE_URL] === def.baseUrl && c.env?.[CUSTOM_BINDING_API] === def.api;
}

export interface CustomProviderService {
	list(): CustomProviderStatus[];
	put(def: unknown, apiKey?: unknown): Promise<CustomProviderStatus>;
	remove(id: unknown): Promise<void>;
}

export function createCustomProviderService(deps: {
	store: CustomProviderStore;
	credentials: CustomProviderCredentials;
}): CustomProviderService {
	const { store, credentials } = deps;
	let chain: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = chain.then(fn, fn);
		chain = run.catch(() => undefined);
		return run;
	};
	const status = (p: CustomProviderDefinition): CustomProviderStatus => ({
		...p,
		keyPresent: !p.keyless && credentialMatchesBinding(credentials.peek(p.id), p),
	});
	const wrap = async <T>(fn: () => Promise<T> | T): Promise<T> => {
		try {
			return await fn();
		} catch (e) {
			if (e instanceof CustomProviderError) throw e;
			if (e instanceof CustomProviderStoreError) throw new CustomProviderError(409, e.message);
			throw new CustomProviderError(500, "custom provider operation failed");
		}
	};

	return {
		list() {
			try {
				return store.readTolerant().map(status);
			} catch {
				throw new CustomProviderError(500, "custom providers could not be read");
			}
		},
		put(rawDef, rawKey) {
			return serial(() =>
				wrap(async () => {
					const v = validateCustomProviderDefinition(rawDef);
					if (!v.ok) throw new CustomProviderError(400, v.error);
					const def = v.value;
					let key: string | undefined;
					if (rawKey !== undefined) {
						const k = validateCustomApiKey(rawKey);
						if (!k.ok) throw new CustomProviderError(400, k.error);
						key = k.value;
					}
					if (def.keyless && key !== undefined) throw new CustomProviderError(400, "a keyless provider cannot have an apiKey");
					const existing = store.read().find((p) => p.id === def.id);
					const endpointChanged = !!existing && (existing.baseUrl !== def.baseUrl || existing.api !== def.api);
					if (!def.keyless && key === undefined) {
						if (!existing) throw new CustomProviderError(400, "an apiKey is required unless the provider is explicitly keyless");
						if (endpointChanged) throw new CustomProviderError(400, "changing baseUrl or api requires a new apiKey or keyless: true");
						if (existing.keyless) throw new CustomProviderError(400, "switching from keyless requires an apiKey");
						if (!credentialMatchesBinding(credentials.peek(def.id), def)) throw new CustomProviderError(400, "no stored apiKey bound to this endpoint; provide one");
					}
					// Credential first, metadata second (see header).
					if (def.keyless) await credentials.delete(def.id);
					else if (key !== undefined) await credentials.modify(def.id, async () => ({
							type: "api_key",
							key,
							env: { [CUSTOM_BINDING_BASE_URL]: def.baseUrl, [CUSTOM_BINDING_API]: def.api },
						}));
					store.save(def);
					return status(def);
				}),
			);
		},
		remove(rawId) {
			return serial(() =>
				wrap(async () => {
					if (!isCustomProviderId(rawId)) throw new CustomProviderError(400, "invalid provider id");
					const existed = store.remove(rawId);
					await credentials.delete(rawId);
					if (!existed) throw new CustomProviderError(404, "custom provider not found");
				}),
			);
		},
	};
}

let defaultService: Promise<CustomProviderService> | null = null;
/** Production service, lazily bound to the real store and providerCredentials. */
export function defaultCustomProviderService(): Promise<CustomProviderService> {
	return (defaultService ??= (async () => {
		const [{ customProviderStore }, { providerCredentials }] = await Promise.all([
			import("../store/custom-providers.ts"),
			import("../store/provider-credentials.ts"),
		]);
		return createCustomProviderService({ store: customProviderStore(), credentials: providerCredentials });
	})());
}

async function readBoundedJson(request: Request): Promise<unknown> {
	const ct = request.headers.get("content-type") ?? "";
	if (!/^application\/json\b/i.test(ct)) throw new CustomProviderError(400, "content-type must be application/json");
	const declared = request.headers.get("content-length");
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_CUSTOM_PROVIDER_BODY_BYTES)) {
		throw new CustomProviderError(400, "request body too large");
	}
	const reader = request.body?.getReader();
	if (!reader) throw new CustomProviderError(400, "invalid JSON body");
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_CUSTOM_PROVIDER_BODY_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw new CustomProviderError(400, "request body too large");
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
	} catch {
		throw new CustomProviderError(400, "invalid JSON body");
	}
}

function errorResponse(e: unknown): Response {
	const err = e instanceof CustomProviderError ? e : new CustomProviderError(500, "custom provider operation failed");
	return noStoreJson({ error: err.message }, { status: err.status });
}

export function customProvidersHandlers(resolve: () => Promise<CustomProviderService> = defaultCustomProviderService) {
	return {
		async get(): Promise<Response> {
			try {
				return noStoreJson({ providers: (await resolve()).list() });
			} catch (e) {
				return errorResponse(e);
			}
		},
		async put(request: Request): Promise<Response> {
			try {
				const body = await readBoundedJson(request);
				if (!body || typeof body !== "object" || Array.isArray(body)) throw new CustomProviderError(400, "invalid JSON body");
				const b = body as Record<string, unknown>;
				for (const k of Object.keys(b)) if (k !== "provider" && k !== "apiKey") throw new CustomProviderError(400, "unknown body field");
				const provider = await (await resolve()).put(b.provider, b.apiKey);
				return noStoreJson({ provider });
			} catch (e) {
				return errorResponse(e);
			}
		},
		async delete(request: Request): Promise<Response> {
			try {
				const body = await readBoundedJson(request);
				if (!body || typeof body !== "object" || Array.isArray(body)) throw new CustomProviderError(400, "invalid JSON body");
				const b = body as Record<string, unknown>;
				for (const k of Object.keys(b)) if (k !== "id") throw new CustomProviderError(400, "unknown body field");
				await (await resolve()).remove(b.id);
				return noStoreJson({ deleted: true });
			} catch (e) {
				return errorResponse(e);
			}
		},
	};
}
