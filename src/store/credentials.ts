/**
 * undefined from modify keeps the current credential. pi-ai refresh
 * returns undefined when the token is already fresh, and returns a new
 * credential only after xAI may have rotated the refresh token.
 * An aborted signal skips only the wait to enter the queue. A modify
 * that has started finishes the 0600 rename, so a cancelled caller
 * cannot drop the only valid refresh token.
 */

import fs from "node:fs";
import path from "node:path";
import type { CredentialInfo, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { AUTH_FILE } from "../../config.ts";

export interface ProviderCredentialFacts {
	oauth: boolean;
	health: "ready" | "unreadable";
}

export interface StoredCredentials extends CredentialStore {
	facts(providerId: string): ProviderCredentialFacts;
	replaceUnreadable(): Promise<void>;
}

type FileState =
	| { health: "ready"; byProvider: Record<string, OAuthCredential> }
	| { health: "unreadable" };

function toOAuth(value: unknown): OAuthCredential | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.type !== "oauth") return undefined;
	if (typeof record.access !== "string" || record.access.length === 0) return undefined;
	if (typeof record.refresh !== "string" || record.refresh.length === 0) return undefined;
	if (typeof record.expires !== "number" || !Number.isFinite(record.expires)) return undefined;
	return { type: "oauth", access: record.access, refresh: record.refresh, expires: record.expires };
}

function credentialsFile(): string {
	return path.join(path.dirname(AUTH_FILE), "credentials.json");
}

function load(): FileState {
	const file = credentialsFile();
	if (!fs.existsSync(file)) return { health: "ready", byProvider: {} };
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { health: "unreadable" };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { health: "unreadable" };
	const body = raw as Record<string, unknown>;
	if (body.version !== 1 || !body.byProvider || typeof body.byProvider !== "object" || Array.isArray(body.byProvider)) {
		return { health: "unreadable" };
	}
	const byProvider: Record<string, OAuthCredential> = {};
	for (const [id, entry] of Object.entries(body.byProvider as Record<string, unknown>)) {
		const credential = toOAuth(entry);
		if (!credential) return { health: "unreadable" };
		byProvider[id] = credential;
	}
	return { health: "ready", byProvider };
}

function writeAll(byProvider: Record<string, OAuthCredential>, providerId: string): void {
	const file = credentialsFile();
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.credentials.json.tmp-${process.pid}-${providerId}`);
	const body = { version: 1, byProvider };
	fs.writeFileSync(tmp, `${JSON.stringify(body, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
}

function aborted(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

function createCredentialStore(): StoredCredentials {
	const chains = new Map<string, Promise<unknown>>();

	function enqueue<T>(providerId: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const previous = chains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			await previous.catch(() => {});
			if (signal?.aborted) throw aborted(signal);
			return task();
		})();
		const tail = queued.then(
			() => undefined,
			() => undefined,
		);
		chains.set(providerId, tail);
		void tail.then(() => {
			if (chains.get(providerId) === tail) chains.delete(providerId);
		});
		return queued;
	}

	return {
		facts(providerId) {
			const state = load();
			if (state.health === "unreadable") return { oauth: false, health: "unreadable" };
			return { oauth: state.byProvider[providerId]?.type === "oauth", health: "ready" };
		},
		async read(providerId, options) {
			options?.signal?.throwIfAborted();
			const state = load();
			if (state.health === "unreadable") return undefined;
			return state.byProvider[providerId];
		},
		async list(options) {
			options?.signal?.throwIfAborted();
			const state = load();
			if (state.health === "unreadable") return [];
			return Object.entries(state.byProvider).map(([providerId, credential]) => ({
				providerId,
				type: credential.type,
			})) satisfies CredentialInfo[];
		},
		modify(providerId, fn, options) {
			return enqueue(
				providerId,
				async () => {
					const state = load();
					if (state.health === "unreadable") {
						throw new Error("credentials.json could not be read");
					}
					const current = state.byProvider[providerId];
					const next = await fn(current);
					if (next === undefined) return current;
					const stored = toOAuth(next);
					if (!stored) {
						throw new Error("credentials.json only stores oauth credentials");
					}
					state.byProvider[providerId] = stored;
					writeAll(state.byProvider, providerId);
					return stored;
				},
				options?.signal,
			);
		},
		delete(providerId, options) {
			return enqueue(
				providerId,
				async () => {
					const state = load();
					if (state.health === "unreadable") {
						throw new Error("credentials.json could not be read");
					}
					if (!fs.existsSync(credentialsFile())) return;
					if (!state.byProvider[providerId]) return;
					delete state.byProvider[providerId];
					writeAll(state.byProvider, providerId);
				},
				options?.signal,
			);
		},
		replaceUnreadable() {
			return enqueue("xai", async () => {
				if (load().health === "ready") return;
				fs.rmSync(credentialsFile(), { force: true });
			});
		},
	};
}

const STORE_KEY = Symbol.for("lh.credentialStore");

export const credentialStore: StoredCredentials = (() => {
	const g = globalThis as Record<symbol, StoredCredentials | undefined>;
	if (!g[STORE_KEY]) g[STORE_KEY] = createCredentialStore();
	return g[STORE_KEY];
})();

export function replaceUnreadableXai(): Promise<void> {
	return credentialStore.replaceUnreadable();
}
