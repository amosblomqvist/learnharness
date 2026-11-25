import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { AUTH_FILE, PATHS } from "../../config.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { jobStore } from "../store/jobs.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { accountKey, selectThreadProfile } from "../store/thread-profile.ts";
import { markThreadModified, threadModifiedAt } from "../store/thread-times.ts";
import { readThreadBundle, removeThreadBundle, threadIds, writeThreadBundle } from "../store/thread-bundles.ts";
import { cloudClient, cloudRefs, convexRemote, type CloudTokens, type CloudUser } from "./cloud-remote.ts";
import { syncThreads } from "./thread-sync-engine.ts";
import type { SyncHead } from "../core/thread-sync.ts";
import { emit } from "../core/events.ts";
import { runningWorkBlocker } from "./chats.ts";
import { sideChats } from "./side-chat.ts";
import { compactionInFlight } from "./compaction.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { listenForGoogleCallback } from "./cloud-loopback.ts";

const DEFAULT_CLOUD_DEPLOYMENT = "https://watchful-jackal-487.ap-southeast-2.convex.cloud";
const credentialsFile = () => path.join(path.dirname(AUTH_FILE), "learnharness-cloud-credentials.json");
interface CloudSession { deployment: string; user: CloudUser; tokens: CloudTokens }
interface PendingSignIn { id: string; state: string; expires: number; deployment: string; close?: () => void }
interface CloudState {
	operation: boolean; timer?: ReturnType<typeof setInterval>; session?: CloudSession | null;
	pending?: PendingSignIn; error: string | null; lastSynced: string | null; deferred: number;
}
function state(): CloudState {
	const global = globalThis as typeof globalThis & { __lhCloudSync?: CloudState };
	return global.__lhCloudSync ??= { operation: false, error: null, lastSynced: null, deferred: 0 };
}
export function cloudDeployment(): string | null {
	const value = (process.env.LH_CONVEX_URL ?? DEFAULT_CLOUD_DEPLOYMENT).trim();
	if (!value) return null;
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("LH_CONVEX_URL must be an HTTPS Convex deployment URL.");
	return url.origin;
}
function enabled(): boolean { return readSettings()?.labs?.threadSync === true; }
function session(): CloudSession | null {
	const current = state();
	if (current.session !== undefined) return current.session;
	try {
		const value = JSON.parse(fs.readFileSync(credentialsFile(), "utf8")) as CloudSession;
		if (!value?.deployment || !value.user?.id || value.tokens?.userId !== value.user.id || !value.tokens.accessToken || !value.tokens.refreshToken) throw new Error("Invalid saved Google connection.");
		return current.session = value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return current.session = null;
		throw error;
	}
}
function saveSession(value: CloudSession): void {
	fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true });
	writeFileAtomicSync(credentialsFile(), JSON.stringify(value), { mode: 0o600 });
	state().session = value;
}
function chatBusy(id: string): boolean {
	return !!runningWorkBlocker(id) || compactionInFlight(id)
		|| jobStore.listJobs(id).some(job => job.status === "running")
		|| Object.keys(sideChats.list(id)?.answering ?? {}).length > 0
		|| extractionStatuses().some(run => run.chatId === id);
}
function requireIdle(): void {
	if (threadIds(PATHS.threadData).some(chatBusy) || extractionStatuses().length) throw new Error("Wait for active turns and background work to finish before changing accounts.");
}
function indexFile(root: string): string { return path.join(root, "cloud-index.json"); }
function loadIndex(root: string): Record<string, SyncHead> {
	try {
		const value = JSON.parse(fs.readFileSync(indexFile(root), "utf8")) as Record<string, SyncHead>;
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(head => !head || typeof head.revision !== "string" || !(head.digest === null || typeof head.digest === "string"))) throw new Error("Invalid sync checkpoint. Local threads have been preserved.");
		return value;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null); throw error; }
}
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
	const current = state();
	if (current.operation) throw new Error("A sync or account operation is in progress. Please retry.");
	current.operation = true;
	try { return await work(); } finally { current.operation = false; }
}
async function authenticatedClient(saved: CloudSession) {
	const client = cloudClient(saved.deployment);
	try {
		// This is only a refresh hint; Convex verifies identity and session on every operation.
		if ((decodeJwt(saved.tokens.accessToken).exp ?? 0) * 1000 > Date.now() + 60_000) {
			client.setAuth(saved.tokens.accessToken); return client;
		}
	} catch { /* Refresh malformed or expired access tokens using the private refresh token. */ }
	// Rotation is persisted before any thread request. Never infer identity from a JWT.
	const refreshed = await client.mutation(cloudRefs.refresh, { refreshToken: saved.tokens.refreshToken });
	if (refreshed.kind === "noSession") throw new Error("Google session expired. Sign out and reconnect; local changes are saved.");
	if (refreshed.tokens.userId !== saved.user.id) throw new Error("Google account changed unexpectedly. Reconnect in Labs.");
	saveSession({ ...saved, tokens: refreshed.tokens });
	client.setAuth(refreshed.tokens.accessToken);
	return client;
}
async function syncCycle(): Promise<void> {
	const current = state();
	if (current.operation || !enabled()) return;
	await exclusive(async () => {
		const saved = session();
		const deployment = cloudDeployment();
		if (!saved || !deployment) return;
		if (saved.deployment !== deployment) throw new Error("Convex deployment changed. Sign out before connecting to another deployment.");
		const root = path.join(PATHS.data, "cloud-accounts", accountKey(saved.deployment, saved.user.id));
		if (PATHS.threadData !== root) throw new Error("Account cache does not match the signed-in account.");
		const remote = convexRemote(await authenticatedClient(saved));
		const result = await syncThreads({
			ids: () => threadIds(root), read: id => readThreadBundle(root, id), busy: chatBusy,
			modifiedAt: id => threadModifiedAt(root, id),
			write(id, bundle, updatedAt) {
				if (bundle) writeThreadBundle(root, bundle); else removeThreadBundle(root, id);
				markThreadModified(root, id, updatedAt);
				emit("chats-changed", {}); emit("record-changed", { chatId: id }); emit("jobs-changed", { chatId: id });
			},
			loadIndex: () => loadIndex(root),
			saveIndex: index => { fs.mkdirSync(root, { recursive: true }); writeFileAtomicSync(indexFile(root), JSON.stringify(index), { mode: 0o600 }); },
		}, remote);
		current.deferred = result.deferred;
		current.lastSynced = new Date().toISOString(); current.error = null;
	});
}
function recordSyncError(error: unknown): void {
	// Never forward Convex/network errors: these can contain provider URLs or tokens.
	state().error = error instanceof Error && /^(Google session|Google account|Convex deployment|Account cache|Invalid sync checkpoint|Thread |Cloud snapshot)/.test(error.message)
		? error.message : "Sync is unavailable. Local changes are saved and will retry automatically.";
}
export function startCloudSync(): void {
	const current = state();
	if (!enabled() || current.timer) return;
	const tick = () => { void syncCycle().catch(recordSyncError); };
	current.timer = setInterval(tick, 10_000); current.timer.unref?.(); tick();
}
export function cloudSyncStatus() {
	startCloudSync();
	const saved = session();
	let configured = false;
	try { configured = !!cloudDeployment(); } catch (error) { recordSyncError(error); }
	return {
		enabled: enabled(), configured, user: saved?.user ?? null,
		profile: PATHS.threadData === PATHS.data ? "local" : path.basename(PATHS.threadData),
		syncing: state().operation, lastSynced: state().lastSynced, error: state().error,
		deferred: state().deferred,
		pendingSignIn: !!state().pending && state().pending!.expires > Date.now(),
	};
}
export function cloudSyncProfile(): string {
	return PATHS.threadData === PATHS.data ? "local" : path.basename(PATHS.threadData);
}
async function disconnect(): Promise<void> {
	requireIdle();
	const saved = session();
	selectThreadProfile(PATHS.data, null);
	fs.rmSync(credentialsFile(), { force: true }); state().session = null; state().pending?.close?.(); state().pending = undefined;
	state().lastSynced = null; state().error = null;
	if (saved) {
		try { await cloudClient(saved.deployment).mutation(cloudRefs.signOut, { refreshToken: saved.tokens.refreshToken }); }
		catch { /* Local disconnect must remain available offline. */ }
	}
	emit("chats-changed", {});
}
export async function cloudControl(op: string, origin: string, value?: unknown): Promise<unknown> {
	if (op === "sync") { await syncCycle(); return cloudSyncStatus(); }
	const result = await exclusive(async () => {
		if (op === "enable") {
			if (typeof value !== "boolean") throw new Error("Choose whether thread sync is enabled.");
			if (!value) await disconnect();
			const settings = readSettings() ?? { version: 1 };
			writeSettings({ ...settings, labs: { ...settings.labs, threadSync: value } });
			return null;
		}
		if (op === "signOut") { await disconnect(); return null; }
		if (op === "cancel") { state().pending?.close?.(); state().pending = undefined; return null; }
		if (op !== "signIn") throw new Error("Unsupported cloud account operation.");
		if (!enabled()) throw new Error("Enable Google account & thread sync in Labs first.");
		requireIdle();
		if (session()) throw new Error("Sign out before connecting another account.");
		const deployment = cloudDeployment();
		if (!deployment) throw new Error("Configure LH_CONVEX_URL before signing in.");
		state().pending?.close?.(); state().pending = undefined;
		const id = randomBytes(32).toString("hex");
		const app = new URL(origin);
		const loopback = process.env.LH_DESKTOP_SERVER === "1" || (["localhost", "127.0.0.1", "[::1]"].includes(app.hostname) && app.port !== "3000")
			? await listenForGoogleCallback(completeCloudSignIn) : null;
		try {
			const callback = new URL("/labs/google/callback", loopback?.origin ?? origin); callback.searchParams.set("attempt", id);
			const response = await cloudClient(deployment).mutation(cloudRefs.start, { redirectTo: callback.href });
			const target = new URL(response.redirect);
			if (target.origin !== "https://accounts.google.com") throw new Error("Unexpected Google sign-in URL.");
			state().pending = { id, state: response.state, expires: Date.now() + 10 * 60_000, deployment, close: loopback?.close };
			state().error = null;
			return { redirect: response.redirect };
		} catch (error) { loopback?.close(); throw error; }
	});
	return result ?? cloudSyncStatus();
}
export async function completeCloudSignIn(url: URL): Promise<void> {
	await exclusive(async () => {
		const pending = state().pending;
		if (!enabled() || !pending || pending.id !== url.searchParams.get("attempt") || pending.expires < Date.now()) throw new Error("Sign-in expired. Start again in Labs.");
		state().pending = undefined; pending.close?.(); // one-use, even if redemption fails
		if (url.searchParams.has("convexAuthError")) throw new Error("Google sign-in was cancelled or failed.");
		const code = url.searchParams.get("convexAuthCode");
		if (!code) throw new Error("Google sign-in did not return a code.");
		const client = cloudClient(pending.deployment);
		const result = await client.mutation(cloudRefs.complete, { code, state: pending.state });
		if (result.status !== "complete") throw new Error("Google sign-in could not be verified.");
		client.setAuth(result.tokens.accessToken);
		const user = await client.query(cloudRefs.user, {});
		if (user.id !== result.tokens.userId) throw new Error("Google sign-in identity mismatch.");
		requireIdle(); // work may have started during the browser round trip
		const key = accountKey(pending.deployment, user.id);
		const root = path.join(PATHS.data, "cloud-accounts", key);
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		// The signed-out library is imported once, into the first account only.
		// It stays intact as the signed-out library and an independent backup.
		const marker = path.join(PATHS.data, "cloud-import.json");
		if (!fs.existsSync(marker)) {
			for (const id of threadIds(PATHS.data)) {
				const bundle = readThreadBundle(PATHS.data, id);
				if (bundle && !fs.existsSync(path.join(root, "chats", `${id}.json`))) {
					writeThreadBundle(root, bundle); markThreadModified(root, id, threadModifiedAt(PATHS.data, id));
				}
			}
			writeFileAtomicSync(marker, JSON.stringify(key), { mode: 0o600 });
		}
		saveSession({ deployment: pending.deployment, user, tokens: result.tokens });
		selectThreadProfile(PATHS.data, key);
		state().error = null; state().lastSynced = null;
		emit("chats-changed", {});
	});
	startCloudSync();
}
