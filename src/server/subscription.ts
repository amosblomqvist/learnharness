import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { subscriptionStore } from "./stores.ts";
import { createModels, type Credential, type CredentialStore, type AuthEvent } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { SubscriptionStore, OAuthCredential, SubscriptionAttempt } from "../store/subscription-credentials.ts";
import { SubscriptionError, SUBSCRIPTION_PROVIDER, subscriptionFailure, type SubscriptionMethod, type SubscriptionStatus, type SubscriptionErrorCode } from "../core/subscription.ts";
import { browserOAuthLogin, validateBrowserCallback } from "./subscription-browser.ts";
import { createSubscriptionEngine } from "./subscription-engine.ts";
import type { PiEngine, ResolvedModelSpec } from "../agent/models.ts";

interface LocalAttempt {
	record: SubscriptionAttempt;
	controller: AbortController;
	view: NonNullable<SubscriptionStatus["attempt"]>;
	completion?: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
	ready: Promise<void>;
	markReady(): void;
	prompt?: { id: string; resolve(value: string): void };
}
function credential(value: Credential | undefined): OAuthCredential {
	if (value?.type !== "oauth" || typeof value.accountId !== "string" || !value.accountId) throw new SubscriptionError("subscription_unknown");
	return { type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires, accountId: value.accountId };
}
export { subscriptionErrorCode } from "./subscription-errors.ts";
import { subscriptionErrorCode as safeCode } from "./subscription-errors.ts";

/** Exact-version adapter: parse only the known refresh endpoint envelope. */
function invalidRefreshGrant(error: unknown): boolean {
	for (let depth = 0; depth < 5 && error instanceof Error; depth++, error = error.cause) {
		const match = /^OpenAI Codex token refresh failed \((400|401)\): ([\s\S]{1,8192})$/.exec(error.message);
		if (!match) continue;
		try {
			const body: unknown = JSON.parse(match[2]!);
			if (!body || typeof body !== "object") return false;
			const code = (body as { error?: unknown }).error;
			return code === "invalid_grant" || (typeof code === "object" && code !== null && (code as { code?: unknown }).code === "invalid_grant");
		} catch { return false; }
	}
	return false;
}

export function createSubscriptionService(store: SubscriptionStore) {
	const attempts = new Map<string, LocalAttempt>();
	const leases = new Set<AbortController>();
	let closing = false;
	let lastError: SubscriptionErrorCode | undefined;
	function checkState(state: { generation: string; credential?: OAuthCredential }, generation?: string) {
		if (closing || !state.credential || (generation !== undefined && state.generation !== generation)) throw new SubscriptionError("subscription_needs_login");
	}
	async function expireAbandonedAttempt() {
		await store.transaction(async (tx) => {
			const a = tx.state.attempt;
			if (!a) return;
			if (a.expiresAt <= Date.now() || store.isOwnerAlive(a.owner) === false) {
				attempts.get(a.id)?.controller.abort(new SubscriptionError("subscription_expired"));
				await tx.save({ version: 1, generation: randomUUID() });
			}
		});
	}
	const service = {
		store,
		async status(): Promise<SubscriptionStatus> {
			try {
				await expireAbandonedAttempt();
				const { state, journal } = await store.snapshot();
				if (journal && journal.generation === state.generation) return { state: "reconnect_required", error: subscriptionFailure("subscription_recovery_required") };
				if (closing) return { state: "error", error: subscriptionFailure("subscription_storage_error") };
				if (state.credential) return { state: "connected", account: `…${state.credential.accountId.slice(-4)}` };
				if (state.attempt) {
					const local = attempts.get(state.attempt.id);
					return { state: "authorizing", attempt: local?.view ?? { id: state.attempt.id, method: state.attempt.method, expiresAt: state.attempt.expiresAt, ownedHere: false } };
				}
				return { state: "disconnected", ...(lastError ? { error: subscriptionFailure(lastError) } : {}) };
			} catch {
				return { state: "error", error: subscriptionFailure("subscription_storage_error") };
			}
		},
		async assertAvailable(generation?: string): Promise<string> {
			return store.transaction(async (tx) => {
				checkState(tx.state, generation);
				if (await tx.journal()) throw new SubscriptionError("subscription_recovery_required");
				return tx.state.generation;
			});
		},
		credentials(generation: string): CredentialStore {
			return {
				read: async (provider, options) => {
					if (provider !== SUBSCRIPTION_PROVIDER) return undefined;
					return store.transaction(async (tx) => {
						options?.signal?.throwIfAborted();
						checkState(tx.state, generation);
						if (await tx.journal()) throw new SubscriptionError("subscription_recovery_required");
						return { ...tx.state.credential! };
					}, options?.signal);
				},
				list: async () => [],
				delete: async () => { throw new SubscriptionError("subscription_invalid_input"); },
				modify: async (provider, fn, options) => store.transaction(async (tx) => {
					options?.signal?.throwIfAborted();
					if (provider !== SUBSCRIPTION_PROVIDER) throw new SubscriptionError("subscription_invalid_input");
					checkState(tx.state, generation);
					if (await tx.journal()) throw new SubscriptionError("subscription_recovery_required");
					const journal = await tx.beginRefresh();
					try {
						const next = await fn({ ...tx.state.credential! });
						options?.signal?.throwIfAborted();
						if (closing) throw new SubscriptionError("subscription_needs_login");
						// Undefined is the SDK's double-check no-change result, not deletion.
						const saved = next === undefined ? tx.state.credential! : credential(next);
						await tx.commitRefresh(saved, journal);
						return { ...saved };
					} catch (error) {
						if (invalidRefreshGrant(error)) {
							await tx.save({ version: 1, generation: randomUUID() });
							await tx.clearJournalAfterDisconnect();
							throw new SubscriptionError("subscription_needs_login");
						}
						// The SDK erases structured transport failures. An uncertain rotation
						// cannot safely retry the old refresh token, even after restart.
						throw new SubscriptionError("subscription_recovery_required");
					}
				}, options?.signal),
			};
		},
		async acquireLease(generation: string, signal?: AbortSignal) {
			const controller = new AbortController();
			const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			await store.transaction(async (tx) => {
				combined.throwIfAborted();
				checkState(tx.state, generation);
				if (await tx.journal()) throw new SubscriptionError("subscription_recovery_required");
				leases.add(controller);
			}, combined);
			return {
				signal: combined,
				release: () => { leases.delete(controller); },
				fetch: (async (input, init) => {
					let response: Promise<Response> | undefined;
					await store.transaction(async (tx) => {
						combined.throwIfAborted();
						checkState(tx.state, generation);
						if (await tx.journal()) throw new SubscriptionError("subscription_recovery_required");
						if (String(input) !== "https://chatgpt.com/backend-api/codex/responses" || init?.method !== "POST") throw new SubscriptionError("subscription_unknown");
						// Send linearization: invoke under the lock, await OUTSIDE it.
						response = globalThis.fetch(input, { ...init, signal: combined, redirect: "error" });
						// Avoid an unhandled rejection while releasing the filesystem lock.
						void response.catch(() => {});
					}, combined);
					return response!;
				}) satisfies typeof fetch,
			};
		},
		async start(method: SubscriptionMethod): Promise<SubscriptionStatus> {
			if (method !== "browser" && method !== "device_code") throw new SubscriptionError("subscription_invalid_input");
			await expireAbandonedAttempt();
			const record = await store.transaction(async (tx) => {
				if (closing || tx.state.credential || tx.state.attempt || await tx.journal()) throw new SubscriptionError("subscription_conflict");
				const a: SubscriptionAttempt = { id: randomUUID(), generation: tx.state.generation, owner: store.owner, expiresAt: Date.now() + 15 * 60_000, method };
				await tx.save({ ...tx.state, attempt: a });
				return a;
			});
			let markReady = () => {};
			const ready = new Promise<void>((resolve) => { markReady = resolve; });
			const local: LocalAttempt = { record, controller: new AbortController(), view: { id: record.id, method, expiresAt: record.expiresAt, ownedHere: true }, ready, markReady };
			attempts.set(record.id, local);
			lastError = undefined;
			local.timer = setTimeout(() => { void service.cancel(record.id, "subscription_expired").catch(() => {}); }, Math.max(0, record.expiresAt - Date.now()));
			local.timer.unref();
			const loginStore: CredentialStore = {
				read: async () => undefined,
				list: async () => [],
				delete: async () => { throw new SubscriptionError("subscription_invalid_input"); },
				modify: async (provider, fn, options) => store.transaction(async (tx) => {
					options?.signal?.throwIfAborted();
					if (provider !== SUBSCRIPTION_PROVIDER || closing || tx.state.generation !== record.generation || tx.state.attempt?.id !== record.id || record.expiresAt <= Date.now()) throw new SubscriptionError("subscription_cancelled");
					const next = credential(await fn(undefined));
					options?.signal?.throwIfAborted();
					await tx.save({ version: 1, generation: record.generation, credential: next });
					return { ...next };
				}, options?.signal),
			};
			const models = createModels({ credentials: loginStore });
			const provider = openaiCodexProvider();
			if (method === "browser") {
				provider.auth.oauth!.login = (interaction) => browserOAuthLogin(interaction, (listening) => { local.view.callbackListening = listening; });
			}
			models.setProvider(provider);
			local.completion = (async () => {
				try {
					await models.login(SUBSCRIPTION_PROVIDER, "oauth", {
						signal: local.controller.signal,
						prompt: async (prompt) => {
							local.controller.signal.throwIfAborted();
							if (prompt.type === "select") return method;
							if (prompt.type !== "manual_code" || method !== "browser") throw new SubscriptionError("subscription_invalid_input");
							const id = randomUUID();
							const signal = prompt.signal ? AbortSignal.any([prompt.signal, local.controller.signal]) : local.controller.signal;
							return new Promise<string>((resolve, reject) => {
								const cleanup = () => {
									signal.removeEventListener("abort", abort);
									local.prompt = undefined;
									local.view.promptId = undefined;
									local.view.manualAvailable = false;
								};
								const abort = () => { cleanup(); reject(new SubscriptionError("subscription_cancelled")); };
								local.prompt = { id, resolve: (value) => { cleanup(); resolve(value); } };
								local.view.promptId = id;
								local.view.manualAvailable = true;
								signal.addEventListener("abort", abort, { once: true });
								if (signal.aborted) abort();
								local.markReady();
							});
						},
						notify: (event: AuthEvent) => {
							if (local.controller.signal.aborted) return;
							if (event.type === "auth_url") {
								const url = new URL(event.url);
								if (url.origin !== "https://auth.openai.com" || url.pathname !== "/oauth/authorize" || !url.searchParams.get("state")) throw new SubscriptionError("subscription_unknown");
								local.view.authorizationUrl = url.toString();
							}
							if (event.type === "device_code" && event.verificationUri === "https://auth.openai.com/codex/device") {
								if (!/^[A-Za-z0-9-]{1,64}$/.test(event.userCode)) throw new SubscriptionError("subscription_unknown");
								local.view.userCode = event.userCode;
								local.view.verificationUri = event.verificationUri;
								local.markReady();
							}
						},
					});
				} catch (error) {
					const code = local.controller.signal.aborted ? safeCode(local.controller.signal.reason) : safeCode(error);
					await store.transaction(async (tx) => {
						if (tx.state.attempt?.id === record.id && tx.state.generation === record.generation) {
							await tx.save({ version: 1, generation: randomUUID() });
							lastError = code;
						}
					}).catch(() => { lastError = "subscription_storage_error"; });
				} finally {
					clearTimeout(local.timer);
					local.markReady();
					local.prompt = undefined;
					local.view = { id: record.id, method, expiresAt: record.expiresAt, ownedHere: true };
				}
			})();
			// Do not await the supplier flow in an HTTP request.
			return { state: "authorizing", attempt: { ...local.view } };
		},
		async finished(id: string): Promise<void> { await attempts.get(id)?.completion; },
		async interactionReady(id: string): Promise<SubscriptionStatus> {
			const local = attempts.get(id);
			if (!local) throw new SubscriptionError("subscription_wrong_owner");
			await local.ready;
			return service.status();
		},
		async reply(id: string, promptId: string, input: string): Promise<SubscriptionStatus> {
			let consume: (() => void) | undefined;
			await store.transaction(async (tx) => {
				const active = tx.state.attempt;
				if (!active || active.id !== id || active.generation !== tx.state.generation || active.expiresAt <= Date.now()) throw new SubscriptionError("subscription_invalid_input");
				const local = attempts.get(id);
				if (!local || active.owner.nonce !== store.owner.nonce) throw new SubscriptionError("subscription_wrong_owner");
				if (closing || local.controller.signal.aborted || !local.prompt || local.prompt.id !== promptId || !local.view.authorizationUrl) throw new SubscriptionError("subscription_invalid_input");
				validateBrowserCallback(input, new URL(local.view.authorizationUrl).searchParams.get("state")!);
				const prompt = local.prompt;
				local.prompt = undefined;
				consume = () => prompt.resolve(input);
			});
			consume!();
			return service.status();
		},
		async cancel(id: string, reason: SubscriptionErrorCode = "subscription_cancelled"): Promise<SubscriptionStatus> {
			const local = attempts.get(id);
			await store.transaction(async (tx) => {
				if (tx.state.attempt?.id !== id) throw new SubscriptionError("subscription_invalid_input");
				if (!local || tx.state.attempt.owner.nonce !== store.owner.nonce) throw new SubscriptionError("subscription_wrong_owner");
				await tx.save({ version: 1, generation: randomUUID() });
			});
			local!.controller.abort(new SubscriptionError(reason));
			lastError = reason;
			return service.status();
		},
		async disconnect(): Promise<SubscriptionStatus> {
			closing = true;
			lastError = undefined;
			for (const a of attempts.values()) a.controller.abort(new SubscriptionError("subscription_cancelled"));
			for (const lease of leases) lease.abort(new SubscriptionError("subscription_needs_login"));
			try {
				await store.transaction(async (tx) => {
					await tx.save({ version: 1, generation: randomUUID() });
					await tx.clearJournalAfterDisconnect();
				});
				attempts.clear();
				closing = false;
				return service.status();
			} catch { throw new SubscriptionError("subscription_storage_error"); }
		},
	};
	return service;
}
export type SubscriptionService = ReturnType<typeof createSubscriptionService>;

const globalRegistry = globalThis as typeof globalThis & { __lhSubscriptionServices?: Map<string, SubscriptionService> };
export function subscriptionService(): SubscriptionService {
	const store = subscriptionStore();
	const directory = store.directory;
	const registry = globalRegistry.__lhSubscriptionServices ??= new Map();
	let service = registry.get(directory);
	if (!service) { service = createSubscriptionService(store); registry.set(directory, service); }
	return service;
}
const scopes = new AsyncLocalStorage<{ generation?: string; failure?: SubscriptionErrorCode }>();
export function getSubscriptionGeneration(): string | undefined { return scopes.getStore()?.generation; }
export async function withSubscriptionScope<T>(fn: () => Promise<T>, generation?: string | null): Promise<T> {
	if (generation === undefined && scopes.getStore()) return fn();
	if (generation === null) return scopes.run({}, fn);
	if (generation !== undefined) return scopes.run({ generation }, fn);
	let captured: string;
	try { captured = (await subscriptionService().store.getSnapshot()).generation; }
	catch {
		// A broken subscription file must not disable ordinary API-key work.
		return scopes.run({ failure: "subscription_storage_error" }, fn);
	}
	return scopes.run({ generation: captured }, fn);
}
export function subscriptionEngineForSpec(spec: ResolvedModelSpec): PiEngine {
	const generation = getSubscriptionGeneration();
	if (!generation) throw new SubscriptionError(scopes.getStore()?.failure ?? "subscription_needs_login");
	return createSubscriptionEngine(subscriptionService(), spec, generation);
}
export async function subscriptionPreflight(provider: string) {
	if (provider !== SUBSCRIPTION_PROVIDER) return null;
	try {
		if (scopes.getStore() && getSubscriptionGeneration() === undefined) throw new SubscriptionError(scopes.getStore()?.failure ?? "subscription_needs_login");
		await subscriptionService().assertAvailable(getSubscriptionGeneration());
		return null;
	}
	catch (error) { return subscriptionFailure(safeCode(error)); }
}
