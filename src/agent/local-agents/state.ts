import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_LOCAL_AGENT_PREFERENCES, LOCAL_AGENTS, type LocalAgentPreferences, type LocalAgentProviderId, type LocalAgentStatus } from "../../core/contracts/local-agents.ts";
import type { LocalAgentPreferenceStore } from "../../core/ports.ts";
import type { AdmissionScope } from "../subscription-request-cycle.ts";
import type { AdapterProbe, LocalAgentAdapter } from "./adapter.ts";
import { antigravityAdapter } from "./antigravity.ts";
import { claudeAdapter } from "./claude.ts";
import { closeProviderRuns } from "./run.ts";

/**
 * Local agent connection state (docs/architecture.md §8.2). Everything here
 * is derived from the runtimes themselves (installed? signed in? which
 * account?) plus the learner's two persisted choices (enabled, background
 * use). No credential ever passes through. The preference store arrives
 * from the server layer (the agent layer never imports a store adapter).
 */

const STATUS_TTL_MS = 30_000;

interface ProviderState {
	status: LocalAgentStatus;
	models: Model<Api>[];
	binary?: string;
	identity: string;
	refreshing?: Promise<void>;
	signIn?: AbortController;
}
interface State {
	providers: Map<LocalAgentProviderId, ProviderState>;
	listeners: Set<() => void>;
	preferences?: LocalAgentPreferenceStore;
	adapters: Record<LocalAgentProviderId, LocalAgentAdapter>;
	controllers: Map<AbortController, { providerId: LocalAgentProviderId; background: boolean }>;
}

const KEY = Symbol.for("lh.localAgents.state");
function state(): State {
	const g = globalThis as typeof globalThis & { [KEY]?: State };
	return (g[KEY] ??= { providers: new Map(), listeners: new Set(), adapters: { "claude-code": claudeAdapter, antigravity: antigravityAdapter }, controllers: new Map() });
}

export function isLocalAgentProvider(provider: string | undefined): provider is LocalAgentProviderId {
	return LOCAL_AGENTS.some((agent) => agent.providerId === provider);
}

/** Wiring seam (server composition). */
export function configureLocalAgentPreferences(store: LocalAgentPreferenceStore): void { state().preferences = store; }
/** Test seam: replace a runtime adapter. */
export function setLocalAgentAdapter(adapter: LocalAgentAdapter): void { state().adapters[adapter.providerId] = adapter; state().providers.delete(adapter.providerId); }
export function localAgentAdapter(providerId: LocalAgentProviderId): LocalAgentAdapter { return state().adapters[providerId]; }
/** Test seam: forget all cached state. */
export function resetLocalAgents(): void {
	const s = state();
	for (const id of s.providers.keys()) closeProviderRuns(id);
	s.providers.clear();
}

function preferences(providerId: LocalAgentProviderId): LocalAgentPreferences {
	return { ...DEFAULT_LOCAL_AGENT_PREFERENCES, ...(state().preferences?.read()[providerId] ?? {}) };
}

function notify() { for (const listener of state().listeners) { try { listener(); } catch { /* observer isolation */ } } }
export function onLocalAgentChange(listener: () => void): () => void { const s = state(); s.listeners.add(listener); return () => { s.listeners.delete(listener); }; }

function emptyStatus(providerId: LocalAgentProviderId): LocalAgentStatus {
	const prefs = preferences(providerId);
	return { providerId, enabled: prefs.enabled, allowBackgroundUse: prefs.allowBackgroundUse, installed: false, signedIn: false, pending: false, connected: false, generation: 0, checkedAt: 0 };
}

function providerState(providerId: LocalAgentProviderId): ProviderState {
	const s = state();
	let entry = s.providers.get(providerId);
	if (!entry) { entry = { status: emptyStatus(providerId), models: [], identity: "" }; s.providers.set(providerId, entry); }
	return entry;
}

/** Apply a probe (or a preference change) and bump the generation when the connection's identity changed. */
function apply(providerId: LocalAgentProviderId, probe: AdapterProbe | undefined) {
	const entry = providerState(providerId);
	const prefs = preferences(providerId);
	const previous = entry.status;
	const kept: AdapterProbe = { installed: previous.installed, signedIn: previous.signedIn, version: previous.version, account: previous.account, plan: previous.plan, usesSubscription: previous.usesSubscription, models: entry.models, binary: entry.binary, error: previous.error };
	const p = !probe ? kept : probe.uncertain ? { ...kept, installed: probe.installed, binary: probe.binary ?? kept.binary, version: probe.version ?? kept.version } : probe;
	entry.models = p.models;
	entry.binary = p.binary;
	const connected = prefs.enabled && p.installed && p.signedIn && p.models.length > 0;
	const identity = JSON.stringify({ connected, account: p.account ?? null, binary: p.binary ?? null });
	const generation = identity === entry.identity ? previous.generation : previous.generation + 1;
	if (identity !== entry.identity && entry.identity) closeProviderRuns(providerId);
	entry.identity = identity;
	entry.status = {
		providerId, enabled: prefs.enabled, allowBackgroundUse: prefs.allowBackgroundUse,
		installed: p.installed, signedIn: p.signedIn, pending: !!entry.signIn, connected, generation,
		...(p.version ? { version: p.version } : {}), ...(p.account ? { account: p.account } : {}), ...(p.plan ? { plan: p.plan } : {}),
		...(p.usesSubscription !== undefined ? { usesSubscription: p.usesSubscription } : {}),
		...(p.error ? { error: p.error } : {}),
		checkedAt: Date.now(),
	};
	// Background consent withdrawn: stop background work immediately, parked runs included.
	if (!prefs.allowBackgroundUse) {
		for (const [controller, owner] of state().controllers) if (owner.providerId === providerId && owner.background) controller.abort("background");
		closeProviderRuns(providerId, { backgroundOnly: true });
	}
	if (!connected) for (const [controller, owner] of state().controllers) if (owner.providerId === providerId) controller.abort("all");
}

export async function refreshLocalAgents(options: { force?: boolean; providerId?: LocalAgentProviderId } = {}): Promise<void> {
	const ids = options.providerId ? [options.providerId] : LOCAL_AGENTS.map((agent) => agent.providerId);
	await Promise.all(ids.map(async (providerId) => {
		const entry = providerState(providerId);
		if (entry.refreshing) {
			await entry.refreshing;
			// A forced refresh must observe state after its own request, not an older probe's.
			if (!options.force) return;
		}
		if (entry.refreshing) return entry.refreshing;
		if (!options.force && Date.now() - entry.status.checkedAt < STATUS_TTL_MS) return;
		const before = JSON.stringify(entry.status);
		entry.refreshing = (async () => {
			let probe: AdapterProbe;
			try { probe = await localAgentAdapter(providerId).probe({ discoverModels: preferences(providerId).enabled, previous: options.force ? [] : entry.models }); }
			catch (error) { probe = { installed: entry.status.installed, signedIn: false, models: [], uncertain: true, error: error instanceof Error ? error.message : String(error) }; }
			apply(providerId, probe);
		})().finally(() => { entry.refreshing = undefined; if (JSON.stringify({ ...entry.status, checkedAt: 0 }) !== JSON.stringify({ ...JSON.parse(before), checkedAt: 0 })) notify(); });
		return entry.refreshing;
	}));
}

export function localAgentStatuses(): LocalAgentStatus[] { return LOCAL_AGENTS.map((agent) => providerState(agent.providerId).status); }
export function localAgentStatus(providerId: LocalAgentProviderId): LocalAgentStatus { return providerState(providerId).status; }
export function localAgentBinary(providerId: LocalAgentProviderId): string | undefined { return providerState(providerId).binary; }
export function localAgentConnected(providerId: LocalAgentProviderId): boolean { return providerState(providerId).status.connected; }
export function localAgentBackgroundAllowed(providerId: LocalAgentProviderId): boolean { const s = providerState(providerId).status; return s.connected && s.allowBackgroundUse; }
export function localAgentModels(): Model<Api>[] { return LOCAL_AGENTS.flatMap((agent) => localAgentConnected(agent.providerId) ? providerState(agent.providerId).models : []); }
export function localAgentModel(provider: string, id: string): Model<Api> | undefined { return localAgentModels().find((model) => model.provider === provider && model.id === id); }

export function setLocalAgentPreferences(providerId: LocalAgentProviderId, patch: Partial<LocalAgentPreferences>): void {
	const store = state().preferences;
	if (!store) throw new Error("Local agent preferences are unavailable.");
	store.write(providerId, { ...preferences(providerId), ...patch });
	apply(providerId, undefined);
	notify();
}

export async function signInLocalAgent(providerId: LocalAgentProviderId): Promise<void> {
	const adapter = localAgentAdapter(providerId);
	const entry = providerState(providerId);
	if (!adapter.signIn) throw new Error("Sign in from a terminal, then refresh.");
	if (entry.signIn) throw new Error("A sign-in is already running.");
	const controller = new AbortController();
	entry.signIn = controller;
	apply(providerId, undefined); notify();
	try { entry.models = await adapter.signIn(controller.signal); }
	finally {
		entry.signIn = undefined;
		// Re-probe (reusing the catalog the sign-in just discovered).
		entry.status = { ...entry.status, checkedAt: 0 };
		await refreshLocalAgents({ providerId }).catch(() => {});
		notify();
	}
}
export function cancelLocalAgentSignIn(providerId: LocalAgentProviderId): void { providerState(providerId).signIn?.abort(); }

// ── admission (the shared subscription request cycle) ───────────────────

export interface LocalAgentScope { providerId: LocalAgentProviderId; generation: number; selectedModelId: string }
export function localAgentScope(providerId: LocalAgentProviderId, selectedModelId: string): LocalAgentScope {
	if (!localAgentConnected(providerId) || !localAgentModel(providerId, selectedModelId)) throw new Error("model unavailable");
	return { providerId, generation: localAgentStatus(providerId).generation, selectedModelId };
}
export function localAgentScopeCurrent(scope: LocalAgentScope): boolean {
	return localAgentConnected(scope.providerId) && localAgentStatus(scope.providerId).generation === scope.generation && !!localAgentModel(scope.providerId, scope.selectedModelId);
}
export function localAgentAdmissionScope(scope: LocalAgentScope): AdmissionScope {
	return { accountId: `${scope.providerId}:${localAgentStatus(scope.providerId).account ?? "local"}`, epoch: scope.generation, authorityRevision: 0, selectedModelId: scope.selectedModelId };
}
export function localAgentAdmissionCurrent(providerId: LocalAgentProviderId, scope: AdmissionScope): boolean {
	return localAgentScopeCurrent({ providerId, generation: scope.epoch, selectedModelId: scope.selectedModelId });
}
export function localAgentAbortController(providerId: LocalAgentProviderId, background: boolean) {
	const controller = new AbortController();
	state().controllers.set(controller, { providerId, background });
	return { controller, release: () => { state().controllers.delete(controller); } };
}
