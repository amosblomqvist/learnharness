import type { Api, Model, ModelAuth } from "@earendil-works/pi-ai";
import { onWebSubscriptionPacket, webSubscriptionRequest, webSubscriptionsEnabled } from "./subscription-runtime.ts";
import { NATIVE_SUBSCRIPTIONS, type NativeSubscriptionProviderId, type NativeSubscriptionScope, type NativeSubscriptionSnapshot, type NativeSubscriptionStatus } from "../core/contracts/subscriptions.ts";
import type { AdmissionScope, NoDispatchKind } from "./chatgpt-request-cycle.ts";

interface Pending { op: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface State {
	statuses: Map<NativeSubscriptionProviderId, NativeSubscriptionStatus>;
	models: Map<NativeSubscriptionProviderId, Model<Api>[]>;
	pending: Map<string, Pending>;
	controllers: Map<AbortController, { providerId: NativeSubscriptionProviderId; background: boolean }>;
	listeners: Set<() => void>;
	counter: number;
}
const KEY = Symbol.for("lh.subscriptions.bridge");
export function nativeSubscriptionId(logicalId: string): NativeSubscriptionProviderId | undefined {
	return NATIVE_SUBSCRIPTIONS.find((entry) => entry.logicalId === logicalId)?.providerId;
}
function desktopConnected(): boolean {
	return process.env.LH_DESKTOP_SERVER === "1" && (process.env.LH_DESKTOP_API_SECRET?.length ?? 0) >= 64 && typeof process.send === "function" && process.connected === true;
}
function runtimeConnected(): boolean { return desktopConnected() || webSubscriptionsEnabled(); }
function notify(state: State) { for (const listener of state.listeners) { try { listener(); } catch { /* observer isolation */ } } }
function invalidate(state: State, providerId?: NativeSubscriptionProviderId) {
	for (const [controller, owner] of state.controllers) if (!providerId || owner.providerId === providerId) controller.abort("all");
	if (providerId) { state.models.delete(providerId); state.statuses.delete(providerId); }
	else { state.models.clear(); state.statuses.clear(); }
}
function accept(state: State, snapshot: NativeSubscriptionSnapshot) {
	if (!snapshot || !Array.isArray(snapshot.statuses) || !snapshot.models) return;
	let changed = false;
	for (const entry of snapshot.statuses) {
		if (!NATIVE_SUBSCRIPTIONS.some((p) => p.providerId === entry.providerId) || ![entry.revision, entry.epoch, entry.authorityRevision].every((n) => Number.isSafeInteger(n) && n >= 0)) continue;
		const previous = state.statuses.get(entry.providerId);
		if (previous && entry.revision < previous.revision) continue;
		const all = !!previous && (entry.connectionId !== previous.connectionId || entry.epoch !== previous.epoch || entry.authorityRevision !== previous.authorityRevision || !entry.available || !entry.connected);
		for (const [controller, owner] of state.controllers) {
			if (owner.providerId !== entry.providerId) continue;
			if (all) controller.abort("all");
			else if (owner.background && !entry.allowBackgroundUse) controller.abort("background");
		}
		state.statuses.set(entry.providerId, entry);
		const descriptor = NATIVE_SUBSCRIPTIONS.find((p) => p.providerId === entry.providerId)!;
		state.models.set(entry.providerId, entry.available && entry.connected ? (snapshot.models[entry.providerId] ?? []).filter((m) => m.provider === entry.providerId).map((m) => ({ ...m, provider: descriptor.logicalId })) : []);
		changed ||= !previous || entry.revision !== previous.revision;
	}
	if (changed) notify(state);
}
function bridge(): State {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	if (!global[KEY]) {
		const state: State = { statuses: new Map(), models: new Map(), pending: new Map(), controllers: new Map(), listeners: new Set(), counter: 0 };
		global[KEY] = state;
		process.on("message", (raw: unknown) => {
			const message = raw as { channel?: string; op?: string; id?: string; ok?: boolean; value?: unknown; error?: string; snapshot?: NativeSubscriptionSnapshot };
			if (!desktopConnected() || message?.channel !== "lh:subscriptions") return;
			if (message.op === "changed" && message.snapshot) accept(state, message.snapshot);
			if (!message.id) return;
			const pending = state.pending.get(message.id);
			if (!pending || pending.op !== message.op) return;
			clearTimeout(pending.timer); state.pending.delete(message.id);
			if (message.ok) pending.resolve(message.value);
			else pending.reject(new Error(message.error ?? "Subscription connection failed."));
		});
		onWebSubscriptionPacket("lh:subscriptions", (packet) => {
			if (webSubscriptionsEnabled() && packet.snapshot) accept(state, packet.snapshot as NativeSubscriptionSnapshot);
		});
		process.on("disconnect", () => {
			if (webSubscriptionsEnabled()) return;
			invalidate(state);
			for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("The desktop connection closed.")); }
			state.pending.clear(); notify(state);
		});
	}
	return global[KEY];
}
export function subscriptionRequest<T>(op: "snapshot" | "lease", fields: Record<string, unknown> = {}): Promise<T> {
	const state = bridge();
	if (webSubscriptionsEnabled()) return webSubscriptionRequest<T>("lh:subscriptions", op, fields);
	if (!desktopConnected()) return Promise.reject(new Error("Subscription sign-in is available only in the desktop app with a private server connection."));
	return new Promise<T>((resolve, reject) => {
		const id = `${process.pid}:${++state.counter}`;
		const timer = setTimeout(() => { state.pending.delete(id); reject(new Error("The subscription desktop connection timed out.")); }, 45000);
		state.pending.set(id, { op, timer, resolve: (value) => resolve(value as T), reject });
		process.send!({ ...fields, channel: "lh:subscriptions", id, op }, (error) => {
			if (error) { clearTimeout(timer); state.pending.delete(id); reject(new Error("The subscription desktop connection closed.")); }
		});
	});
}
export async function refreshSubscriptionModels(): Promise<void> {
	const state = bridge();
	if (!runtimeConnected()) { invalidate(state); return; }
	try { accept(state, await subscriptionRequest<NativeSubscriptionSnapshot>("snapshot")); }
	catch { invalidate(state); notify(state); }
}
export function nativeSubscriptionStatus(providerId: NativeSubscriptionProviderId): NativeSubscriptionStatus | undefined { return bridge().statuses.get(providerId); }
export function nativeSubscriptionConnected(providerId: NativeSubscriptionProviderId): boolean {
	const status = nativeSubscriptionStatus(providerId);
	return runtimeConnected() && status?.available === true && status.connected && !!status.connectionId;
}
export function nativeSubscriptionBackgroundAllowed(providerId: NativeSubscriptionProviderId): boolean { return nativeSubscriptionConnected(providerId) && nativeSubscriptionStatus(providerId)?.allowBackgroundUse === true; }
export function nativeSubscriptionModels(): Model<Api>[] { return runtimeConnected() ? [...bridge().models.values()].flat() : []; }
export function nativeSubscriptionModel(logicalId: string, modelId: string): Model<Api> | undefined { return nativeSubscriptionModels().find((m) => m.provider === logicalId && m.id === modelId); }
export function onNativeSubscriptionChange(listener: () => void): () => void { const state = bridge(); state.listeners.add(listener); return () => { state.listeners.delete(listener); }; }
export function subscriptionScope(providerId: NativeSubscriptionProviderId, selectedModelId: string): NativeSubscriptionScope {
	const state = nativeSubscriptionStatus(providerId);
	const logicalId = NATIVE_SUBSCRIPTIONS.find((p) => p.providerId === providerId)!.logicalId;
	if (!state?.connectionId || !nativeSubscriptionConnected(providerId) || !nativeSubscriptionModel(logicalId, selectedModelId)) throw new Error("Subscription model catalog unavailable");
	return { providerId, connectionId: state.connectionId, epoch: state.epoch, authorityRevision: state.authorityRevision, selectedModelId };
}
export function subscriptionScopeCurrent(scope: NativeSubscriptionScope): boolean {
	try { return JSON.stringify(subscriptionScope(scope.providerId, scope.selectedModelId)) === JSON.stringify(scope); } catch { return false; }
}
/** Compatibility shape for the shared admission cycle; accountId is a local connection ID here. */
export function subscriptionAdmissionScope(scope: NativeSubscriptionScope): AdmissionScope {
	return { accountId: scope.connectionId, epoch: scope.epoch, authorityRevision: scope.authorityRevision, selectedModelId: scope.selectedModelId };
}
export function nativeAdmissionCurrent(providerId: NativeSubscriptionProviderId, scope: AdmissionScope): boolean {
	return subscriptionScopeCurrent({ providerId, connectionId: scope.accountId, epoch: scope.epoch, authorityRevision: scope.authorityRevision, selectedModelId: scope.selectedModelId });
}
export async function subscriptionLease(scope: NativeSubscriptionScope, background: boolean): Promise<ModelAuth> {
	if (!subscriptionScopeCurrent(scope)) throw new Error("Subscription connection changed");
	const result = await subscriptionRequest<{ scope: NativeSubscriptionScope; auth: ModelAuth }>("lease", { scope, background });
	if (!result?.auth || !subscriptionScopeCurrent(scope) || JSON.stringify(result.scope) !== JSON.stringify(scope) || (!result.auth.apiKey && !Object.values(result.auth.headers ?? {}).some((value) => !!value))) throw new Error("Subscription lease is stale");
	return result.auth;
}
export function subscriptionAbortController(providerId: NativeSubscriptionProviderId, background: boolean) {
	const state = bridge(); const controller = new AbortController(); state.controllers.set(controller, { providerId, background });
	return { controller, release: () => { state.controllers.delete(controller); } };
}
export async function subscriptionDenial(scope: NativeSubscriptionScope | undefined, controller: AbortController, callerAborted: boolean, background: boolean): Promise<NoDispatchKind> {
	if (callerAborted || controller.signal.reason === "all") return "all";
	if (!scope || !subscriptionScopeCurrent(scope)) return "other";
	if (controller.signal.reason === "background") return "background";
	if (!background) return "other";
	await refreshSubscriptionModels();
	if (!subscriptionScopeCurrent(scope)) return "all";
	return nativeSubscriptionBackgroundAllowed(scope.providerId) ? "other" : "background";
}
