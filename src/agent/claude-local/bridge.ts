/**
 * The agent-side view of the Local Claude route (docs/architecture.md
 * §8.1): the server's probe (src/server/claude-local.ts) pushes a snapshot
 * — status, catalog, how to launch the user's binary — and the agent
 * layer reads it here. Same discipline as subscription-bridge.ts: the
 * agent layer never imports the server; it is TOLD what is current.
 *
 * Scope/admission vocabulary mirrors the native connections so the shared
 * SubscriptionRequestCycle (captured / beforeDispatch / noDispatch) and the
 * jobs' consent logic apply unchanged: the probe REVISION plays the role
 * the connection epoch plays elsewhere — a re-probe that changes the
 * binary, the login state or the catalog invalidates every admitted scope.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { CLAUDE_LOCAL, type ClaudeLocalScope, type ClaudeLocalStatus, type ClaudeLocalSystemPromptMode, type ClaudeLocalUsageReport } from "../../core/contracts/claude-local.ts";
import type { AdmissionScope, NoDispatchKind } from "../subscription-request-cycle.ts";

/** How to start the detected install (never part of the public status). */
export interface ClaudeLocalLaunch {
	/** The executable the SDK is pointed at (a native `claude`, or a cli.js). */
	path: string;
	/** True when `path` is a JavaScript entry (npm install) that must run
	 *  through Node — the spawner substitutes the app's own runtime. */
	viaNode: boolean;
	/** The child's working directory: an empty app-owned dir (no CLAUDE.md,
	 *  no project settings, no session files). */
	cwd: string;
}
export interface ClaudeLocalSnapshot {
	status: ClaudeLocalStatus;
	models: Model<Api>[];
	launch: ClaudeLocalLaunch | null;
}
interface State {
	snapshot?: ClaudeLocalSnapshot;
	listeners: Set<() => void>;
	controllers: Map<AbortController, { background: boolean }>;
	usage?: ClaudeLocalUsageReport;
}
const KEY = Symbol.for("lh.claudeLocal.bridge");
function bridge(): State {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	return global[KEY] ??= { listeners: new Set(), controllers: new Map() };
}
function notify(state: State) { for (const listener of state.listeners) { try { listener(); } catch { /* observer isolation */ } } }

/** The server's push. Aborts in-flight runs the change invalidates:
 *  everything on a revision change or a loss of readiness; background
 *  runs when consent turns off. */
export function acceptClaudeLocalSnapshot(snapshot: ClaudeLocalSnapshot): void {
	const state = bridge();
	const previous = state.snapshot;
	const ready = snapshot.status.state === "ready" && snapshot.status.enabled;
	const all = !!previous && (snapshot.status.revision !== previous.status.revision || !ready);
	for (const [controller, owner] of state.controllers) {
		if (all) controller.abort("all");
		else if (owner.background && !snapshot.status.allowBackgroundUse) controller.abort("background");
	}
	state.snapshot = { status: snapshot.status, models: ready ? snapshot.models.map((m) => ({ ...m, provider: CLAUDE_LOCAL.providerId })) : [], launch: ready ? snapshot.launch : null };
	if (!previous || previous.status.revision !== snapshot.status.revision || previous.status.state !== snapshot.status.state || previous.status.enabled !== snapshot.status.enabled || previous.status.allowBackgroundUse !== snapshot.status.allowBackgroundUse || previous.status.systemPromptMode !== snapshot.status.systemPromptMode) notify(state);
}
export function claudeLocalStatus(): ClaudeLocalStatus | undefined { return bridge().snapshot?.status; }
export function claudeLocalConnected(): boolean {
	const status = claudeLocalStatus();
	return !!status && status.enabled && status.state === "ready" && !!bridge().snapshot?.launch;
}
export function claudeLocalBackgroundAllowed(): boolean { return claudeLocalConnected() && claudeLocalStatus()?.allowBackgroundUse === true; }
export function claudeLocalSystemPromptMode(): ClaudeLocalSystemPromptMode { return claudeLocalStatus()?.systemPromptMode ?? "custom"; }
export function claudeLocalLaunch(): ClaudeLocalLaunch | undefined { return claudeLocalConnected() ? bridge().snapshot?.launch ?? undefined : undefined; }
export function claudeLocalModels(): Model<Api>[] { return claudeLocalConnected() ? [...(bridge().snapshot?.models ?? [])] : []; }
export function claudeLocalModel(modelId: string): Model<Api> | undefined { return claudeLocalModels().find((m) => m.id === modelId); }
export function onClaudeLocalChange(listener: () => void): () => void { const state = bridge(); state.listeners.add(listener); return () => { state.listeners.delete(listener); }; }

export function claudeLocalScope(selectedModelId: string): ClaudeLocalScope {
	const status = claudeLocalStatus();
	if (!status || !claudeLocalConnected() || !claudeLocalModel(selectedModelId)) throw new Error("Local Claude model catalog unavailable");
	return { providerId: CLAUDE_LOCAL.providerId, revision: status.revision, selectedModelId };
}
export function claudeLocalScopeCurrent(scope: ClaudeLocalScope): boolean {
	try { return JSON.stringify(claudeLocalScope(scope.selectedModelId)) === JSON.stringify(scope); } catch { return false; }
}
/** The shared admission cycle's shape: the probe revision rides as the epoch. */
export function claudeLocalAdmissionScope(scope: ClaudeLocalScope): AdmissionScope {
	return { accountId: CLAUDE_LOCAL.providerId, epoch: scope.revision, authorityRevision: 0, selectedModelId: scope.selectedModelId };
}
export function claudeLocalAdmissionCurrent(scope: AdmissionScope): boolean {
	return scope.accountId === CLAUDE_LOCAL.providerId && scope.authorityRevision === 0 && claudeLocalScopeCurrent({ providerId: CLAUDE_LOCAL.providerId, revision: scope.epoch, selectedModelId: scope.selectedModelId });
}
export function claudeLocalAbortController(background: boolean) {
	const state = bridge(); const controller = new AbortController(); state.controllers.set(controller, { background });
	return { controller, release: () => { state.controllers.delete(controller); } };
}
/** Why a run never dispatched (the request cycle's no-dispatch kinds). */
export function claudeLocalDenial(scope: ClaudeLocalScope | undefined, controller: AbortController, callerAborted: boolean, background: boolean): NoDispatchKind {
	if (callerAborted || controller.signal.reason === "all") return "all";
	if (!scope || !claudeLocalScopeCurrent(scope)) return "other";
	if (controller.signal.reason === "background") return "background";
	if (!background) return "other";
	return claudeLocalBackgroundAllowed() ? "other" : "background";
}
/** The latest plan-usage report a turn observed (memory only; the status
 *  card reads it through the server). */
export function noteClaudeLocalUsage(report: ClaudeLocalUsageReport): void { bridge().usage = report; }
export function claudeLocalUsage(): ClaudeLocalUsageReport | undefined { return bridge().usage; }
