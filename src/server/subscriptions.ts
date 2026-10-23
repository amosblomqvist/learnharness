/**
 * Subscription (OAuth) connections: status, login attempts, disconnect.
 *
 * Login runs the provider's native OAuth flow
 * (provider.auth.oauth.login(interaction, {agentName})) and persists the
 * result ourselves under credentials.modify, but ONLY while the attempt is
 * still current: pending, not aborted, not expired, and no disconnect/new
 * attempt has bumped the provider generation. The SDK's Models.login is not
 * used because it persists unconditionally after a late result.
 *
 * Cancel / disconnect: state flips synchronously, the flow's AbortSignal
 * fires, pending prompts are rejected, and the provider generation is
 * bumped so a late login result is dropped inside the store lock. If a
 * persist already passed the gate, cancel/disconnect queue a store delete
 * behind it (the lock serializes them), so old or new credentials are never
 * resurrected.
 *
 * API views are DTOs only. Supplier errors, codes, tokens and callback URLs
 * are never copied into them; failures map to fixed application messages.
 * Status reads only the credential store (no refresh, no provider load).
 */

import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import {
	type LoginAttemptView,
	type LoginEventView,
	type LoginPromptView,
	SUBSCRIPTION_PROVIDERS,
	type SubscriptionProviderId,
	type SubscriptionStatus,
	subscriptionProvider,
} from "../core/provider-connections.ts";
import { type ProviderCredentialStore, providerCredentials } from "../store/provider-credentials.ts";
import { ConnectionError } from "./connection-guard.ts";

export const LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000;
export const LOGIN_TERMINAL_RETENTION_MS = 2 * 60 * 1000;
export const MAX_LOGIN_EVENTS = 50;
export const MAX_LOGIN_ATTEMPTS = 16;
export const MAX_PROMPT_VALUE = 16 * 1024;

export interface SubscriptionServiceDeps {
	credentials: ProviderCredentialStore;
	/** Resolve the native OAuth auth for a subscription alias id. */
	getOAuth: (providerId: SubscriptionProviderId) => Promise<OAuthAuth | undefined> | OAuthAuth | undefined;
	now?: () => number;
	ttlMs?: number;
	retentionMs?: number;
	maxEvents?: number;
	maxAttempts?: number;
}

interface PendingPrompt {
	view: LoginPromptView;
	options?: Set<string>;
	resolve: (value: string) => void;
	reject: (reason: unknown) => void;
	cleanup: () => void;
}

interface Attempt {
	id: string;
	providerId: SubscriptionProviderId;
	generation: number;
	state: LoginAttemptView["state"];
	events: LoginEventView[];
	prompt?: PendingPrompt;
	error?: string;
	controller: AbortController;
	createdAt: number;
	finishedAt?: number;
	committing: boolean;
	/** Store cleanup for superseded attempts that must settle before this one may persist. */
	pre?: Promise<unknown>;
	timer?: ReturnType<typeof setTimeout>;
}

function clip(s: unknown, max: number): string {
	return typeof s === "string" ? s.slice(0, max) : "";
}

function safeUrl(u: unknown): string | undefined {
	if (typeof u !== "string" || u.length > 4096) return undefined;
	try {
		const p = new URL(u);
		return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : undefined;
	} catch {
		return undefined;
	}
}

function toEventView(e: AuthEvent): LoginEventView | undefined {
	switch (e.type) {
		case "info":
			return { type: "info", message: clip(e.message, 500) };
		case "progress":
			return { type: "progress", message: clip(e.message, 500) };
		case "auth_url": {
			const url = safeUrl(e.url);
			if (!url) return undefined;
			const out: LoginEventView = { type: "auth_url", url };
			if (e.instructions) out.instructions = clip(e.instructions, 500);
			return out;
		}
		case "device_code": {
			const verificationUri = safeUrl(e.verificationUri);
			if (!verificationUri) return undefined;
			return { type: "device_code", userCode: clip(e.userCode, 64), verificationUri };
		}
		default:
			return undefined;
	}
}

function isOAuthCredential(c: unknown): c is OAuthCredential {
	const o = c as OAuthCredential | undefined;
	return (
		!!o &&
		o.type === "oauth" &&
		typeof o.access === "string" &&
		typeof o.refresh === "string" &&
		typeof o.expires === "number" &&
		Number.isFinite(o.expires)
	);
}

export interface SubscriptionService {
	statuses(): Promise<SubscriptionStatus[]>;
	disconnect(providerId: string): Promise<void>;
	start(providerId: string): Promise<LoginAttemptView>;
	get(id: string): LoginAttemptView;
	answer(id: string, promptId: unknown, value: unknown): LoginAttemptView;
	cancel(id: string): Promise<LoginAttemptView>;
	/** Test/teardown: abort everything and drop timers. */
	dispose(): void;
}

export function createSubscriptionService(deps: SubscriptionServiceDeps): SubscriptionService {
	const now = deps.now ?? Date.now;
	const ttlMs = deps.ttlMs ?? LOGIN_ATTEMPT_TTL_MS;
	const retentionMs = deps.retentionMs ?? LOGIN_TERMINAL_RETENTION_MS;
	const maxEvents = deps.maxEvents ?? MAX_LOGIN_EVENTS;
	const maxAttempts = deps.maxAttempts ?? MAX_LOGIN_ATTEMPTS;
	const attempts = new Map<string, Attempt>();
	const generations = new Map<string, number>();
	const gen = (id: string) => generations.get(id) ?? 0;

	function view(a: Attempt): LoginAttemptView {
		const v: LoginAttemptView = {
			id: a.id,
			providerId: a.providerId,
			state: a.state,
			events: a.events.map((e) => ({ ...e })),
		};
		if (a.prompt) v.prompt = structuredClone(a.prompt.view);
		if (a.error) v.error = a.error;
		return v;
	}

	function clearPrompt(a: Attempt, reason?: unknown) {
		const p = a.prompt;
		if (!p) return;
		a.prompt = undefined;
		p.cleanup();
		if (reason !== undefined) p.reject(reason);
	}

	/** Move a pending attempt to a terminal state. First transition wins. */
	function finish(a: Attempt, state: "connected" | "cancelled" | "failed", error?: string) {
		if (a.state !== "pending") return;
		a.state = state;
		if (error) a.error = error;
		a.finishedAt = now();
		if (a.timer) clearTimeout(a.timer);
		a.timer = undefined;
		clearPrompt(a, new Error("login ended"));
		if (state !== "connected") a.controller.abort(new Error("login ended"));
	}

	function prune() {
		const t = now();
		for (const [id, a] of attempts) {
			// Once the write is accepted (committing) the commit outcome decides, never the TTL.
			if (a.state === "pending" && !a.committing && t - a.createdAt > ttlMs) finish(a, "failed", "Login timed out.");
			if (a.finishedAt !== undefined && t - a.finishedAt > retentionMs) attempts.delete(id);
		}
		// Hard cap: evict oldest terminal attempts first.
		if (attempts.size > maxAttempts) {
			for (const [id, a] of attempts) {
				if (attempts.size <= maxAttempts) break;
				if (a.state !== "pending") attempts.delete(id);
			}
		}
	}

	function requireAttempt(id: string): Attempt {
		prune();
		const a = typeof id === "string" ? attempts.get(id) : undefined;
		if (!a) throw new ConnectionError(404, "Login attempt not found.");
		return a;
	}

	function requireProvider(providerId: unknown): SubscriptionProviderId {
		if (typeof providerId !== "string" || !subscriptionProvider(providerId)) {
			throw new ConnectionError(400, "Unknown subscription provider.");
		}
		return providerId as SubscriptionProviderId;
	}

	function interactionFor(a: Attempt): AuthInteraction {
		return {
			signal: a.controller.signal,
			notify(event) {
				if (a.state !== "pending") return;
				const ev = toEventView(event);
				if (!ev) return;
				a.events.push(ev);
				if (a.events.length > maxEvents) a.events.splice(0, a.events.length - maxEvents);
			},
			prompt(p: AuthPrompt) {
				return new Promise<string>((resolve, reject) => {
					if (a.state !== "pending") return reject(new Error("login ended"));
					// A newer prompt supersedes an unanswered older one.
					clearPrompt(a, new Error("prompt superseded"));
					const pv: LoginPromptView = {
						id: randomUUID(),
						type: p.type,
						message: clip(p.message, 500),
					};
					let options: Set<string> | undefined;
					if (p.type === "select") {
						const opts = p.options.slice(0, 50).map((o) => ({
							id: clip(o.id, 200),
							label: clip(o.label, 200),
							...(o.description ? { description: clip(o.description, 300) } : {}),
						}));
						pv.options = opts;
						options = new Set(opts.map((o) => o.id));
					} else if (p.placeholder) {
						pv.placeholder = clip(p.placeholder, 200);
					}
					const onAbort = () => {
						if (a.prompt?.view.id === pv.id) {
							a.prompt = undefined;
						}
						reject(new Error("prompt cancelled"));
					};
					const cleanup = () => p.signal?.removeEventListener("abort", onAbort);
					if (p.signal?.aborted) return reject(new Error("prompt cancelled"));
					p.signal?.addEventListener("abort", onAbort, { once: true });
					a.prompt = { view: pv, options, resolve, reject, cleanup };
				});
			},
		};
	}

	async function run(a: Attempt, oauth: OAuthAuth) {
		let cred: OAuthCredential;
		try {
			const result = await oauth.login(interactionFor(a) as Parameters<OAuthAuth["login"]>[0], {
				agentName: "LearnHarness",
			});
			if (!isOAuthCredential(result)) throw new Error("bad credential");
			cred = result;
		} catch {
			finish(a, a.controller.signal.aborted ? "cancelled" : "failed", "Login failed.");
			return;
		}
		if (a.state !== "pending") return; // cancelled, expired or superseded: drop the late result
		try {
			await a.pre;
			if (a.state !== "pending") return;
			await deps.credentials.modify(
				a.providerId,
				async () => {
					if (a.state !== "pending" || a.generation !== gen(a.providerId) || a.controller.signal.aborted) {
						return undefined;
					}
					a.committing = true;
					return cred;
				},
				{ signal: a.controller.signal },
			);
		} catch {
			finish(a, a.controller.signal.aborted ? "cancelled" : "failed", "Could not save credentials.");
			return;
		}
		if (a.committing && a.state === "pending") finish(a, "connected");
		else finish(a, "cancelled");
	}

	/** Cancel an attempt; if its write may already be committing, queue a delete behind it. */
	async function cancelAttempt(a: Attempt) {
		if (a.state !== "pending") return; // already settled: never touch the store on its behalf
		const wasCommitting = a.committing;
		finish(a, "cancelled");
		if (wasCommitting) {
			try {
				await deps.credentials.delete(a.providerId);
			} catch {
				// store failure: nothing more we can do here
			}
		}
	}

	return {
		async statuses() {
			const out: SubscriptionStatus[] = [];
			for (const p of SUBSCRIPTION_PROVIDERS) {
				let cred;
				try {
					cred = await deps.credentials.read(p.id);
				} catch {
					cred = undefined; // fail closed: unreadable store reads as disconnected
				}
				const s: SubscriptionStatus = { id: p.id, name: p.name, connected: cred?.type === "oauth" };
				if (cred?.type === "oauth" && Number.isFinite(cred.expires)) s.expires = cred.expires;
				out.push(s);
			}
			return out;
		},

		async disconnect(providerId) {
			const id = requireProvider(providerId);
			generations.set(id, gen(id) + 1);
			const pending = [...attempts.values()].filter((a) => a.providerId === id);
			for (const a of pending) finish(a, "cancelled"); // the delete below is serialized after any in-flight commit
			try {
				await deps.credentials.delete(id);
			} catch {
				throw new ConnectionError(500, "Could not disconnect.");
			}
		},

		async start(providerId) {
			const id = requireProvider(providerId);
			prune();
			const active = [...attempts.values()].filter((a) => a.state === "pending");
			if (active.length >= maxAttempts) throw new ConnectionError(429, "Too many login attempts.");
			let existing;
			try {
				existing = await deps.credentials.read(id);
			} catch {
				existing = undefined; // unreadable store: the later write will fail closed itself
			}
			if (existing?.type === "oauth") throw new ConnectionError(409, "Already connected. Disconnect first.");
			let oauth: OAuthAuth | undefined;
			try {
				oauth = await deps.getOAuth(id);
			} catch {
				oauth = undefined;
			}
			if (!oauth) throw new ConnectionError(503, "Subscription login is not available.");
			// Everything from here to registering the attempt is synchronous, so concurrent
			// start() calls are totally ordered: the later one supersedes the earlier,
			// and generation is captured with no await in between.
			generations.set(id, gen(id) + 1);
			const cleanups: Promise<unknown>[] = [];
			for (const old of attempts.values()) {
				if (old.providerId !== id || old.state !== "pending") continue;
				const wasCommitting = old.committing;
				finish(old, "cancelled");
				if (wasCommitting) cleanups.push(deps.credentials.delete(id).catch(() => {}));
			}
			const a: Attempt = {
				id: randomUUID(),
				providerId: id,
				generation: gen(id),
				state: "pending",
				events: [],
				controller: new AbortController(),
				createdAt: now(),
				committing: false,
				pre: cleanups.length ? Promise.all(cleanups) : undefined,
			};
			a.timer = setTimeout(() => {
				if (!a.committing) finish(a, "failed", "Login timed out.");
			}, ttlMs);
			a.timer.unref?.();
			attempts.set(a.id, a);
			void run(a, oauth);
			await new Promise<void>((r) => setImmediate(r)); // let a first prompt/event surface
			return view(a);
		},

		get(id) {
			return view(requireAttempt(id));
		},

		answer(id, promptId, value) {
			const a = requireAttempt(id);
			if (a.state !== "pending") throw new ConnectionError(409, "Login attempt has ended.");
			const p = a.prompt;
			if (typeof promptId !== "string" || !p || p.view.id !== promptId) {
				throw new ConnectionError(409, "That prompt is no longer active.");
			}
			if (typeof value !== "string" || value.length > MAX_PROMPT_VALUE) {
				throw new ConnectionError(400, "Invalid answer.");
			}
			if (p.options && !p.options.has(value)) throw new ConnectionError(400, "Invalid answer.");
			a.prompt = undefined;
			p.cleanup();
			p.resolve(value);
			return view(a);
		},

		async cancel(id) {
			const a = requireAttempt(id);
			await cancelAttempt(a);
			return view(a);
		},

		dispose() {
			for (const a of attempts.values()) {
				if (a.timer) clearTimeout(a.timer);
				finish(a, "cancelled");
			}
			attempts.clear();
		},
	};
}

// ---- default service (production) ---------------------------------------

const SERVICE_KEY = Symbol.for("lh.subscriptionService");

function defaultService(): SubscriptionService {
	const g = globalThis as Record<symbol, SubscriptionService | undefined>;
	g[SERVICE_KEY] ??= createSubscriptionService({
		credentials: providerCredentials,
		getOAuth: async (providerId) => {
			const { piModels } = await import("../agent/models.ts");
			return piModels().getProvider(providerId)?.auth.oauth;
		},
	});
	return g[SERVICE_KEY];
}

export const listSubscriptionStatuses = () => defaultService().statuses();
export const disconnectSubscription = (providerId: string) => defaultService().disconnect(providerId);
export const startSubscriptionLogin = (providerId: string) => defaultService().start(providerId);
export const getSubscriptionLogin = (id: string) => defaultService().get(id);
export const answerSubscriptionLogin = (id: string, promptId: unknown, value: unknown) =>
	defaultService().answer(id, promptId, value);
export const cancelSubscriptionLogin = (id: string) => defaultService().cancel(id);
