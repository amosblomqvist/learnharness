import type { NativeSubscriptionProviderId, NativeSubscriptionStatus } from "../core/contracts/native-subscriptions.ts";
export type { NativeSubscriptionProviderId, NativeSubscriptionStatus } from "../core/contracts/native-subscriptions.ts";

/**
 * Server-side half of the native Claude/Grok subscription path. Same shape as
 * chatgpt-bridge.ts: inherited Node IPC to the Electron main process, where the
 * pi-ai OAuth flows live. This process never refreshes or stores credentials;
 * it only borrows a short-lived access token (a lease) from main for one request.
 */
export const NATIVE_SUBSCRIPTION_PROVIDERS = ["subscription-anthropic", "subscription-xai"] as const;
export interface Stamp { epoch: number; authorityRevision: number; revision: number }
export interface NativeSubscriptionScope { provider: NativeSubscriptionProviderId; accountId: string; epoch: number; authorityRevision: number; selectedModelId: string }
export interface NativeSubscriptionLease extends Stamp { accessToken: string; accountId: string }
interface StatusValue extends Stamp { status: NativeSubscriptionStatus }
interface ModelsValue extends StatusValue { accountId: string | null; models: { id: string; name: string }[] }
interface Pending { provider: NativeSubscriptionProviderId; op: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
interface ProviderState {
 status: NativeSubscriptionStatus; stamp: Stamp; modelIds: Set<string>; catalogAccount: string | null; catalogRequest: number;
 controllers: Map<AbortController, boolean>;
}
interface BridgeState {
 providers: Record<NativeSubscriptionProviderId, ProviderState>; pending: Map<string, Pending>; listeners: Set<() => void>; counter: number;
}
const key = Symbol.for("lh.native-subscription.bridge");
const CHANNEL = "lh:subscription";
const unavailable = (): NativeSubscriptionStatus => ({ available: false, pending: false, allowBackgroundUse: false, activeId: null, accounts: [], error: null });
const providerState = (): ProviderState => ({ status: unavailable(), stamp: { epoch: 0, authorityRevision: 0, revision: 0 }, modelIds: new Set(), catalogAccount: null, catalogRequest: 0, controllers: new Map() });
const isProvider = (p: unknown): p is NativeSubscriptionProviderId => p === "subscription-anthropic" || p === "subscription-xai";
const validStamp = (s: Stamp | undefined): s is Stamp => !!s && [s.epoch, s.authorityRevision, s.revision].every((v) => Number.isSafeInteger(v) && v >= 0);
const label = (provider: NativeSubscriptionProviderId) => provider === "subscription-anthropic" ? "Claude" : "Grok";

/** Next dev also has parent/child IPC. Same gate as chatgpt-bridge: Electron launch markers (including the 64+ char capability) AND a live channel; fail immediately otherwise. */
function desktopIPCConnected(): boolean {
 return process.env.LH_DESKTOP_SERVER === "1" && (process.env.LH_DESKTOP_API_SECRET?.length ?? 0) >= 64 && typeof process.send === "function" && process.connected === true;
}
/** Copy only known public fields; anything else in a reply is dropped. */
function cleanStatus(raw: unknown): NativeSubscriptionStatus | undefined {
 const s = raw as Partial<NativeSubscriptionStatus> | null;
 if (!s || typeof s !== "object" || !Array.isArray(s.accounts)) return undefined;
 const accounts = [];
 for (const a of s.accounts) {
  if (!a || typeof a.id !== "string" || typeof a.label !== "string") return undefined;
  accounts.push({ id: a.id, label: a.label, connected: a.connected === true });
 }
 return {
  available: s.available === true, pending: s.pending === true, allowBackgroundUse: s.allowBackgroundUse === true,
  activeId: typeof s.activeId === "string" ? s.activeId : null, accounts, error: typeof s.error === "string" ? s.error : null,
  ...(s.catalogError !== undefined ? { catalogError: typeof s.catalogError === "string" ? s.catalogError : null } : {}),
 };
}
function bridge(): BridgeState {
 const global = globalThis as typeof globalThis & { [key]?: BridgeState };
 if (!global[key]) {
  const state: BridgeState = { providers: { "subscription-anthropic": providerState(), "subscription-xai": providerState() }, pending: new Map(), listeners: new Set(), counter: 0 };
  global[key] = state;
  process.on("message", (raw: unknown) => {
   const m = raw as { channel?: string; kind?: string; id?: string; provider?: unknown; op?: string; ok?: boolean; value?: unknown; stamp?: Stamp; status?: unknown; invalidate?: string; error?: string } | null;
   if (!m || m.channel !== CHANNEL || !desktopIPCConnected() || !isProvider(m.provider)) return;
   const provider = m.provider, ps = state.providers[provider];
   if (m.kind === "state") {
    const status = cleanStatus(m.status);
    if (!status || !validStamp(m.stamp) || m.stamp.revision < ps.stamp.revision) return;
    acceptStatus(ps, { ...m.stamp, status });
    if (m.invalidate === "all") { ps.catalogRequest++; clearCatalog(ps); }
    if (m.invalidate === "all" || m.invalidate === "background") {
     for (const [controller, background] of ps.controllers) if (m.invalidate === "all" || background) controller.abort(m.invalidate);
    }
    for (const listener of state.listeners) listener();
    return;
   }
   if (typeof m.id === "string") {
    const call = state.pending.get(m.id);
    // A reply must echo the exact id, provider and op it was sent for.
    if (!call || call.provider !== provider || call.op !== m.op) return;
    clearTimeout(call.timer); state.pending.delete(m.id);
    if (m.ok === true) call.resolve(m.value);
    else call.reject(new Error(typeof m.error === "string" ? m.error : `${label(provider)} connection failed.`));
   }
  });
  process.on("disconnect", () => {
   for (const ps of Object.values(state.providers)) {
    ps.status = unavailable(); clearCatalog(ps); ps.catalogRequest++;
    for (const controller of ps.controllers.keys()) controller.abort("all");
   }
   for (const call of state.pending.values()) { clearTimeout(call.timer); call.reject(new Error("The desktop connection closed.")); }
   state.pending.clear();
   for (const listener of state.listeners) listener();
  });
 }
 return global[key];
}
function clearCatalog(ps: ProviderState) { ps.modelIds = new Set(); ps.catalogAccount = null; }
/** Newer revisions win; any epoch/authority/account change drops the catalog. */
function acceptStatus(ps: ProviderState, value: StatusValue): boolean {
 if (!validStamp(value) || value.revision < ps.stamp.revision) return false;
 if (value.epoch !== ps.stamp.epoch || value.authorityRevision !== ps.stamp.authorityRevision || value.status.activeId !== ps.status.activeId) clearCatalog(ps);
 ps.status = value.status; ps.stamp = { epoch: value.epoch, authorityRevision: value.authorityRevision, revision: value.revision };
 return true;
}
/** Runtime-only inherited IPC. No HTTP credential route, no renderer method, no timer when not desktop. */
export function nativeSubscriptionRequest<T>(provider: NativeSubscriptionProviderId, op: "status" | "models" | "lease", fields: Record<string, unknown> = {}): Promise<T> {
 if (!isProvider(provider)) return Promise.reject(new Error("Unsupported subscription provider."));
 if (!desktopIPCConnected()) return Promise.reject(new Error(`${label(provider)} sign-in is available only in the desktop app with a private server connection.`));
 const state = bridge();
 return new Promise<T>((resolve, reject) => {
  const id = `${process.pid}:${++state.counter}`;
  const timer = setTimeout(() => { state.pending.delete(id); reject(new Error(`The ${label(provider)} desktop connection timed out.`)); }, 45000);
  state.pending.set(id, { provider, op, resolve: (v) => resolve(v as T), reject, timer });
  process.send!({ ...fields, channel: CHANNEL, id, provider, op }, (error) => {
   if (error) { clearTimeout(timer); state.pending.delete(id); reject(new Error(`The ${label(provider)} desktop connection closed.`)); }
  });
 });
}
export function nativeSubscriptionStatus(provider: NativeSubscriptionProviderId): NativeSubscriptionStatus { return bridge().providers[provider].status; }
export function nativeSubscriptionConnected(provider: NativeSubscriptionProviderId): boolean {
 const s = nativeSubscriptionStatus(provider);
 return desktopIPCConnected() && s.available && s.accounts.some((a) => a.id === s.activeId && a.connected);
}
export function nativeSubscriptionBackgroundAllowed(provider: NativeSubscriptionProviderId): boolean { return nativeSubscriptionConnected(provider) && nativeSubscriptionStatus(provider).allowBackgroundUse === true; }
export function onNativeSubscriptionChange(listener: () => void): () => void { bridge().listeners.add(listener); return () => { bridge().listeners.delete(listener); }; }
/** Ids come only from main's catalog reply for the active account; empty unless connected. */
export function nativeSubscriptionModelIds(provider: NativeSubscriptionProviderId): ReadonlySet<string> {
 const ps = bridge().providers[provider];
 return nativeSubscriptionConnected(provider) && ps.catalogAccount !== null && ps.catalogAccount === ps.status.activeId ? ps.modelIds : new Set();
}
export function nativeSubscriptionScope(provider: NativeSubscriptionProviderId, selectedModelId: string): NativeSubscriptionScope {
 const ps = bridge().providers[provider];
 if (!nativeSubscriptionConnected(provider) || !ps.catalogAccount || ps.catalogAccount !== ps.status.activeId || !ps.modelIds.has(selectedModelId)) throw new Error(`${label(provider)} account model catalog is unavailable`);
 return { provider, accountId: ps.catalogAccount, epoch: ps.stamp.epoch, authorityRevision: ps.stamp.authorityRevision, selectedModelId };
}
export function nativeSubscriptionScopeCurrent(scope: NativeSubscriptionScope): boolean {
 if (!isProvider(scope?.provider)) return false;
 const ps = bridge().providers[scope.provider];
 return desktopIPCConnected() && nativeSubscriptionConnected(scope.provider) && scope.accountId === ps.catalogAccount && scope.accountId === ps.status.activeId
  && scope.epoch === ps.stamp.epoch && scope.authorityRevision === ps.stamp.authorityRevision && ps.modelIds.has(scope.selectedModelId);
}
/** Trust comes from main's OAuth-only lease plus provider/op/stamp checks, not token format. The one exception is a pinned-SDK API-format fact, not an auth-method claim:
 * pi-ai's Anthropic client sends any token lacking "sk-ant-oat" as an x-api-key header, so such a lease could never travel as the intended Bearer OAuth token. */
const unusableForTransport = (provider: NativeSubscriptionProviderId, token: string) => provider === "subscription-anthropic" && !token.includes("sk-ant-oat");
export async function nativeSubscriptionLease(scope: NativeSubscriptionScope, background: boolean): Promise<NativeSubscriptionLease> {
 if (!nativeSubscriptionScopeCurrent(scope)) throw new Error(`${label(scope.provider)} catalog authority changed`);
 const value = await nativeSubscriptionRequest<NativeSubscriptionLease>(scope.provider, "lease", { background, expectedAccountId: scope.accountId, expectedAuthorityRevision: scope.authorityRevision, selectedModelId: scope.selectedModelId });
 if (!validStamp(value) || !nativeSubscriptionScopeCurrent(scope) || value.epoch !== scope.epoch || value.authorityRevision !== scope.authorityRevision || value.accountId !== scope.accountId
  || typeof value.accessToken !== "string" || !value.accessToken || unusableForTransport(scope.provider, value.accessToken)) throw new Error(`${label(scope.provider)} lease is stale`);
 // Own copy: nothing else from the reply object is retained.
 return { accessToken: value.accessToken, accountId: value.accountId, epoch: value.epoch, authorityRevision: value.authorityRevision, revision: value.revision };
}
/** Fixed user-facing message for why a request cannot start. Never contains provider or main error text. */
export function nativeSubscriptionDenial(provider: NativeSubscriptionProviderId, purpose?: "background" | "chat"): string {
 const name = label(provider);
 const s = nativeSubscriptionStatus(provider);
 if (!nativeSubscriptionConnected(provider)) return `${name} is not connected. Connect it in Providers. No API-key fallback was used.`;
 if (purpose === "background" && !s.allowBackgroundUse) return `${name} background use is off in this app. Enable background use for this ${name} subscription in Providers to run this work. No API-key fallback was used.`;
 return `${name} request is unavailable for the selected model or account. Refresh Providers and choose an available model. No API-key fallback was used.`;
}
/** Catalog is the SDK's static list as reported by main, not a per-account entitlement. A newer request or invalidation fences older replies. */
async function refreshOne(provider: NativeSubscriptionProviderId): Promise<void> {
 const ps = bridge().providers[provider];
 if (!desktopIPCConnected()) { clearCatalog(ps); return; }
 const sequence = ++ps.catalogRequest;
 try {
  const value = await nativeSubscriptionRequest<ModelsValue>(provider, "models");
  if (sequence !== ps.catalogRequest || !value || !validStamp(value)) return;
  const status = cleanStatus(value.status);
  if (!status || !acceptStatus(ps, { ...value, status })) return;
  if (typeof value.accountId !== "string" || value.accountId !== ps.status.activeId || !nativeSubscriptionConnected(provider) || !Array.isArray(value.models)) return;
  const ids = new Set<string>();
  for (const entry of value.models) if (entry && typeof entry.id === "string" && entry.id) ids.add(entry.id);
  ps.catalogAccount = value.accountId; ps.modelIds = ids;
 } catch { if (sequence === ps.catalogRequest) clearCatalog(ps); }
}
export async function refreshNativeSubscriptionModels(): Promise<void> {
 await Promise.all(NATIVE_SUBSCRIPTION_PROVIDERS.map(refreshOne));
}
export function nativeSubscriptionAbortController(provider: NativeSubscriptionProviderId, background = true): { controller: AbortController; release: () => void } {
 const ps = bridge().providers[provider]; const controller = new AbortController(); ps.controllers.set(controller, background);
 return { controller, release: () => { ps.controllers.delete(controller); } };
}
