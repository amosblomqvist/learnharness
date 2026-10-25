import type { AgentEvent, AgentMessage, PrepareRequestContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { nativeInputCause, needsContinuation, type LhMessage } from "../core/native-messages.ts";

export interface AdmissionScope { accountId: string; epoch: number; authorityRevision: number; selectedModelId: string }
export type NoDispatchKind = "background" | "all" | "other";
const USAGE_KEY = Symbol.for("lh.subscription.unadmittedUsage");
const usageGlobal = globalThis as typeof globalThis & { [USAGE_KEY]?: WeakSet<object> };
const unadmittedUsage = usageGlobal[USAGE_KEY] ??= new WeakSet<object>();
/** Transient identity only: no new provenance field enters saved native messages. */
export function markUnadmittedUsage(usage: object): void { unadmittedUsage.add(usage); }
export function usageWasAdmitted(usage: object): boolean { return !unadmittedUsage.has(usage); }
export interface SubscriptionDispatchLifecycle {
 captured(scope: AdmissionScope): void;
 beforeDispatch(scope: AdmissionScope): void;
 noDispatch(kind: NoDispatchKind): void;
}
interface CycleOptions {
 initialMessages: AgentMessage[];
 staged?: AgentMessage[];
 foregroundOwed: boolean;
 purpose: { background: boolean };
 scopeCurrent: (scope: AdmissionScope) => boolean;
 commitStaged?: () => void;
 restoreAutomatic: (automaticIds: ReadonlySet<string>, retainedIds: ReadonlySet<string>) => void;
}
const idOf = (m: AgentMessage) => (m as { id?: string }).id;
/** One logical turn, not an SDK loop. No credentials, persisted provenance or wire protocol. */
export class SubscriptionRequestCycle implements SubscriptionDispatchLifecycle {
 private release?: (event: AgentEvent) => void;
 private held: AgentEvent[] = [];
 private snapshot: AgentMessage[] = [];
 private seen: Set<string>;
 private automatic = new Set<string>();
 private committed = false;
 private denied?: NoDispatchKind;
 private scope?: AdmissionScope;
 private originalScope?: AdmissionScope;
 private foregroundOwed: boolean;
 private inheritedBackground: boolean;
 private resumed = false;
 private userAborted = false;
 private stagedCommitted = false;
 private started = false;
 private anyDispatch = false;
 private firstResolved = false;
 private resolveAdmission!: (admitted: boolean) => void;
 readonly admission = new Promise<boolean>((resolve) => { this.resolveAdmission = resolve; });
 constructor(private readonly options: CycleOptions) {
  this.seen = new Set(options.initialMessages.map(idOf).filter((id): id is string => !!id));
  for (const message of options.staged ?? []) { const id = idOf(message); if (id) this.seen.delete(id); }
  this.foregroundOwed = options.foregroundOwed;
  this.inheritedBackground = options.purpose.background;
 }
 get dispatched(): boolean { return this.anyDispatch; }
 get deniedBeforeDispatch(): boolean { return this.denied !== undefined; }
 abort(): void { this.userAborted = true; }
 bindRelease(release: (event: AgentEvent) => void): () => void { this.release = release; return () => { this.release = undefined; }; }
 prepare(request: PrepareRequestContext): void {
  const messages = request.context.messages as AgentMessage[];
  this.snapshot = [...messages]; this.automatic = new Set();
  let learner = false;
  for (const m of messages) {
   const id = idOf(m); if (!id || this.seen.has(id)) continue;
   const cause = nativeInputCause(m, messages.slice(0, messages.indexOf(m)));
   if (cause === "automatic") this.automatic.add(id);
   if (cause === "learner") learner = true;
  }
  if (this.automatic.size > 0) this.options.purpose.background = true;
  const retained = messages.filter((m) => !this.automatic.has(idOf(m) ?? ""));
  this.foregroundOwed ||= learner || (!this.inheritedBackground && needsContinuation(retained as LhMessage[]));
 }
 hold(event: AgentEvent): boolean {
  if (event.type === "agent_start") { if (this.started) return true; this.started = true; return false; }
  if (event.type === "agent_end") return true; // settle only after native activeRun is cleared
  if (event.type === "turn_start") {
   this.committed = false; this.denied = undefined; this.scope = undefined;
   // A retained learner batch from the denied cycle already owns its turn_start.
   if (!this.held.some((e) => e.type === "turn_start")) this.held.push(event);
   return true;
  }
  if (!this.committed) { this.held.push(event); return true; }
  return false;
 }
 captured(scope: AdmissionScope): void {
  if (this.originalScope && this.resumed && JSON.stringify(scope) !== JSON.stringify(this.originalScope)) throw new Error("Subscription recovery scope changed");
  this.scope = { ...scope };
  this.originalScope ??= { ...scope };
 }
 beforeDispatch(scope: AdmissionScope): void {
  if (this.userAborted || this.denied || this.committed || !this.scope || JSON.stringify(scope) !== JSON.stringify(this.scope) || !this.options.scopeCurrent(scope)) throw new Error("Subscription admission cancelled");
  if (!this.stagedCommitted && (this.options.staged?.length ?? 0) > 0) {
   this.options.commitStaged?.(); // synchronous durable prefix, before visibility and fetch
   this.stagedCommitted = true;
   const stagedEvents: AgentEvent[] = this.options.staged!.flatMap((message) => [{ type: "message_start" as const, message }, { type: "message_end" as const, message }]);
   const boundary = this.held.findIndex((event) => event.type === "turn_start");
   this.held.splice(boundary < 0 ? 0 : boundary + 1, 0, ...stagedEvents);
  }
  this.committed = true; this.anyDispatch = true; this.foregroundOwed = false;
  this.inheritedBackground = this.options.purpose.background;
  for (const m of this.snapshot) { const id = idOf(m); if (id) this.seen.add(id); }
  const events = this.held; this.held = [];
  for (const event of events) this.release?.(event);
  this.resolveFirst(true);
 }
 noDispatch(kind: NoDispatchKind): void { if (!this.committed) this.denied = this.userAborted ? "all" : kind; }
 acceptsUsage(_message: AssistantMessage): boolean { return this.committed; }
 private resolveFirst(value: boolean) { if (!this.firstResolved) { this.firstResolved = true; this.resolveAdmission(value); } }
 finishNativeCycle(): { action: "settle" | "resumeForeground"; messages: AgentMessage[] } {
  if (!this.denied) { this.resolveFirst(this.anyDispatch); return { action: "settle", messages: [] }; }
  const messages = this.snapshot.filter((m) => !this.automatic.has(idOf(m) ?? ""));
  const retainedIds = new Set(messages.map(idOf).filter((id): id is string => !!id));
  this.options.restoreAutomatic(this.automatic, retainedIds);
  this.resolveFirst(false); // queue deferral is installed before initial fire cargo returns
  this.held = this.held.filter((e) => (e.type === "turn_start") || ((e.type === "message_start" || e.type === "message_end") && e.message.role !== "assistant" && !this.automatic.has(idOf(e.message) ?? "")));
  const retry = this.denied === "background" && !this.userAborted && !this.resumed && this.foregroundOwed && !!this.scope && this.options.scopeCurrent(this.scope);
  if (retry) {
   this.resumed = true; this.options.purpose.background = false;
   this.seen = retainedIds;
   this.denied = undefined;
   // Staged automatic input must not be resurrected on foreground recovery.
   this.options.staged = undefined;
   return { action: "resumeForeground", messages };
  }
  this.held = [];
  return { action: "settle", messages };
 }
}
