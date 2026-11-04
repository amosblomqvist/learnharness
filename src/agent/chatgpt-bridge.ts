import type { Model } from "@earendil-works/pi-ai";
import { onWebSubscriptionPacket, webSubscriptionRequest, webSubscriptionsEnabled } from "./subscription-runtime.ts";
import type { ChatGPTStatus } from "../core/contracts/chatgpt.ts";
import type { AdmissionScope, NoDispatchKind } from "./chatgpt-request-cycle.ts";
export type { ChatGPTStatus } from "../core/contracts/chatgpt.ts";
export interface Stamp { epoch: number; authorityRevision: number; revision: number }
interface StatusValue extends Stamp { status: ChatGPTStatus }
interface ModelsValue extends StatusValue { accountId: string | null; models: { id: string; name: string }[] }
interface LeaseValue extends Stamp { accessToken: string; accountId: string }
interface Pending { op: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
interface BridgeState {
 status: ChatGPTStatus; stamp: Stamp; models: Model<"openai-responses">[]; catalogAccount: string | null;
 pending: Map<string, Pending>; controllers: Map<AbortController, boolean>; listeners: Set<() => void>; counter: number; catalogRequest: number;
}
const key = Symbol.for("lh.chatgpt.bridge");
const unavailable = (): ChatGPTStatus => ({ available: false, pending: false, allowBackgroundUse: true, activeId: null, accounts: [], error: null });
const validStamp = (s: Stamp) => s && [s.epoch, s.authorityRevision, s.revision].every((v) => Number.isSafeInteger(v) && v >= 0);
/** Next dev also uses parent/child IPC. IPC alone is not our desktop
 * transport: require the same launch markers set by Electron startServer.
 * These identify the transport, not a substitute for admission/lease checks. */
function desktopIPCConnected(): boolean {
 return process.env.LH_DESKTOP_SERVER === "1" && (process.env.LH_DESKTOP_API_SECRET?.length ?? 0) >= 64 && typeof process.send === "function" && process.connected === true;
}
function runtimeConnected(): boolean { return desktopIPCConnected() || webSubscriptionsEnabled(); }
function bridge(): BridgeState {
 const global = globalThis as typeof globalThis & { [key]?: BridgeState };
 if (!global[key]) {
  const state: BridgeState = { status: unavailable(), stamp: { epoch: 0, authorityRevision: 0, revision: 0 }, models: [], catalogAccount: null, pending: new Map(), controllers: new Map(), listeners: new Set(), counter: 0, catalogRequest: 0 };
  global[key] = state;
  const receive = (raw: unknown) => {
   const m = raw as { channel?: string; kind?: string; id?: string; op?: string; ok?: boolean; value?: unknown; stamp: Stamp; status: ChatGPTStatus; invalidate?: string; error?: string };
   if (m?.channel !== "lh:chatgpt") return;
   if (m.kind === "state" && validStamp(m.stamp) && m.stamp.revision >= state.stamp.revision) {
    acceptStatus(state, { ...m.stamp, status: m.status });
    if (m.invalidate === "all") { state.catalogRequest++; clearCatalog(state); }
    if (m.invalidate === "all" || m.invalidate === "background") {
     for (const [controller, background] of state.controllers) if (m.invalidate === "all" || background) controller.abort(m.invalidate === "all" ? "all" : "background");
    }
    for (const listener of state.listeners) listener();
   }
   if (m.id) {
    const call = state.pending.get(m.id);
    if (!call || call.op !== m.op) return;
    clearTimeout(call.timer); state.pending.delete(m.id);
    if (m.ok === true) call.resolve(m.value);
    else call.reject(new Error(m.error ?? "ChatGPT connection failed."));
   }
  };
  process.on("message", (raw: unknown) => { if (desktopIPCConnected()) receive(raw); });
  onWebSubscriptionPacket("lh:chatgpt", (packet) => { if (webSubscriptionsEnabled()) receive(packet); });
  process.on("disconnect", () => {
   if (webSubscriptionsEnabled()) return;
   state.status = unavailable(); clearCatalog(state); state.catalogRequest++;
   for (const controller of state.controllers.keys()) controller.abort("all");
   for (const call of state.pending.values()) { clearTimeout(call.timer); call.reject(new Error("The desktop connection closed.")); }
   state.pending.clear();
   for (const listener of state.listeners) listener();
  });
 }
 return global[key];
}
function clearCatalog(state: BridgeState) { state.models = []; state.catalogAccount = null; }
function acceptStatus(state: BridgeState, value: StatusValue) {
 if (!validStamp(value) || value.revision < state.stamp.revision) return;
 if (value.epoch !== state.stamp.epoch || value.authorityRevision !== state.stamp.authorityRevision || value.status.activeId !== state.status.activeId) clearCatalog(state);
 state.status = value.status; state.stamp = { epoch: value.epoch, authorityRevision: value.authorityRevision, revision: value.revision };
}
/** Runtime-only: inherited desktop IPC or direct web owner. Never HTTP leases. */
export function chatGPTRequest<T>(op: "status" | "models" | "lease", fields: Record<string, unknown> = {}): Promise<T> {
 const state = bridge();
 if (webSubscriptionsEnabled()) return webSubscriptionRequest<T>("lh:chatgpt", op, fields);
 if (!desktopIPCConnected()) return Promise.reject(new Error("ChatGPT sign-in is available only in the desktop app with a private server connection."));
 return new Promise<T>((resolve, reject) => {
  const id = `${process.pid}:${++state.counter}`;
  const timer = setTimeout(() => { state.pending.delete(id); reject(new Error("The ChatGPT desktop connection timed out.")); }, 45000);
  state.pending.set(id, { op, resolve: (v) => resolve(v as T), reject, timer });
  process.send!({ ...fields, channel: "lh:chatgpt", id, op }, (error) => {
   if (error) { clearTimeout(timer); state.pending.delete(id); reject(new Error("The ChatGPT desktop connection closed.")); }
  });
 });
}
export function chatGPTStatus(): ChatGPTStatus { return bridge().status; }
export function chatGPTConnected(): boolean { const s = chatGPTStatus(); return runtimeConnected() && s.available && s.accounts.some((a) => a.id === s.activeId && a.connected && a.planEnabled === true); }
export function chatGPTBackgroundAllowed(): boolean { const s = chatGPTStatus(); return chatGPTConnected() && s.allowBackgroundUse === true; }
export function onChatGPTChange(listener: () => void): () => void { bridge().listeners.add(listener); return () => { bridge().listeners.delete(listener); }; }
export function chatGPTModels(): Model<"openai-responses">[] { return bridge().models; }
export function chatGPTModel(id: string): Model<"openai-responses"> | undefined { return chatGPTModels().find((m) => m.id === id); }
export function chatGPTScope(selectedModelId: string): AdmissionScope {
 const state = bridge();
 if (!chatGPTConnected() || !state.catalogAccount || state.catalogAccount !== state.status.activeId || !chatGPTModel(selectedModelId)) throw new Error("ChatGPT account model catalog is unavailable");
 return { accountId: state.catalogAccount, epoch: state.stamp.epoch, authorityRevision: state.stamp.authorityRevision, selectedModelId };
}
export function chatGPTScopeCurrent(scope: AdmissionScope): boolean {
 const s = bridge();
 return runtimeConnected() && chatGPTConnected() && scope.accountId === s.catalogAccount && scope.accountId === s.status.activeId && scope.epoch === s.stamp.epoch && scope.authorityRevision === s.stamp.authorityRevision && !!chatGPTModel(scope.selectedModelId);
}
export async function chatGPTLease(scope: AdmissionScope, background: boolean): Promise<LeaseValue> {
 if (!chatGPTScopeCurrent(scope)) throw new Error("ChatGPT catalog authority changed");
 const value = await chatGPTRequest<LeaseValue>("lease", { background, expectedAccountId: scope.accountId, expectedAuthorityRevision: scope.authorityRevision, selectedModelId: scope.selectedModelId });
 if (!validStamp(value) || !chatGPTScopeCurrent(scope) || value.epoch !== scope.epoch || value.authorityRevision !== scope.authorityRevision || value.accountId !== scope.accountId || typeof value.accessToken !== "string" || !value.accessToken || value.accessToken.startsWith("sk-")) throw new Error("ChatGPT lease is stale");
 return value;
}
/** Safe status confirmation can establish consent-only denial, never parse error text. */
export async function chatGPTDenial(scope: AdmissionScope | undefined, controller: AbortController, callerAborted: boolean, background: boolean): Promise<NoDispatchKind> {
 if (callerAborted || controller.signal.reason === "all") return "all";
 if (!scope || !chatGPTScopeCurrent(scope)) return "other";
 if (controller.signal.reason === "background") return "background";
 if (!background) return "other";
 try { const value = await chatGPTRequest<StatusValue>("status"); acceptStatus(bridge(), value); }
 catch { return "other"; }
 if (controller.signal.reason === "all" || !chatGPTScopeCurrent(scope)) return "all";
 return !chatGPTBackgroundAllowed() ? "background" : "other";
}
/** Preserve account order; unknown capabilities/windows are never fabricated. */
export async function refreshChatGPTModels(supported: Model<"openai-responses">[]): Promise<void> {
 const state = bridge();
 if (!runtimeConnected()) { clearCatalog(state); return; }
 const sequence = ++state.catalogRequest;
 try {
  const value = await chatGPTRequest<ModelsValue>("models");
  if (sequence !== state.catalogRequest || !validStamp(value)) return;
  acceptStatus(state, value);
  if (value.epoch !== state.stamp.epoch || value.authorityRevision !== state.stamp.authorityRevision || value.accountId !== state.status.activeId || !chatGPTConnected()) return;
  state.catalogAccount = value.accountId;
  state.models = value.models.flatMap((entry) => {
   const known = supported.find((m) => m.id === entry.id && m.api === "openai-responses");
   return known ? [{ ...known, provider: "chatgpt", name: entry.name, headers: undefined, samplingParams: undefined, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] : [];
  });
 } catch { if (sequence === state.catalogRequest) clearCatalog(state); }
}
export function chatGPTAbortController(background = true): { controller: AbortController; release: () => void } {
 const state = bridge(); const controller = new AbortController(); state.controllers.set(controller, background);
 return { controller, release: () => { state.controllers.delete(controller); } };
}
