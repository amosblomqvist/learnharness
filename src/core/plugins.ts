/** Plugin API v1. Browser-safe contracts; runtime code is trusted local code.
 * The portable SDK is type-only: use supplied context objects at runtime, not
 * runtime imports of these source helpers/constants or private host modules. */
import type { AssistantMessage, AssistantMessageEvent, Context, SimpleStreamOptions, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ChatRecord, ChatListItem } from "./contracts/chat.ts";
import type { ModelCatalogResponse } from "./contracts/models.ts";
import type { GraphSnapshot, GraphNode, GraphChain, SessionCheckpoint, CoverageEntry, NotesSource, Position } from "./contracts.ts";
export type { ChatRecord, ChatListItem } from "./contracts/chat.ts";
export type { ModelCatalogResponse } from "./contracts/models.ts";
export type { GraphSnapshot, GraphNode, GraphChain, SessionCheckpoint, CoverageEntry, NotesSource, Position } from "./contracts.ts";
import type { ServerEvent } from "./events.ts";
import type { PluginAgentService, PluginCallPurpose, PluginModelSpec } from "./plugin-agents.ts";
import type { PluginBackgroundMeta, PluginBackgroundTool, PluginWorkerService } from "./plugin-workers.ts";
export type * from "./plugin-workers.ts";
import type { PluginQuestionRenderer, PluginQuestionTypeDefinition } from "./plugin-questions.ts";
export type * from "./plugin-questions.ts";
import type { PluginProblemTypeDefinition, PluginProblemRenderer } from "./plugin-problems.ts";
export type * from "./plugin-problems.ts";
import type { PluginSubmissionInterceptor } from "./plugin-submissions.ts";
export type * from "./plugin-submissions.ts";

export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Release activation/mount resources; the host accepts synchronous or async cleanup. */
export type PluginCleanup = () => void | Promise<void>;
export interface PluginManifest {
	apiVersion: 1;
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	description?: string;
	author?: string;
	/** Bundled browser ES module. Entry paths must not address plugin data. */
	main?: string;
	/** Bundled Node CommonJS module. Node builtins are available. */
	backend?: string;
	styles?: string;
}
export interface PluginInfo {
	id: string;
	/** Host-owned package provenance; never read from a plugin manifest. */
	origin: "core" | "community";
	manifest?: PluginManifest;
	enabled: boolean;
	status: "disabled" | "active" | "error";
	error?: string;
	/** Changes only after server restart, not merely after enable/disable. */
	revision: string;
}
export interface PluginNotification {
	pluginId: string;
	topic: string;
	data?: unknown;
}
export interface PluginGraphFileData {
	"nodes.jsonl": GraphNode[];
	"chains.jsonl": GraphChain[];
	"sessions.jsonl": SessionCheckpoint[];
	"coverage.jsonl": CoverageEntry[];
	"sources.json": NotesSource[];
	"positions.json": Record<string, Position>;
	/** Raw versioned metadata rather than a second plugin-specific schema. */
	"render-settings.json": unknown;
	"format.json": unknown;
}
/** Fresh read-only access to saved native learning records. Multiple reads are not
 * a cross-file transaction; keep plugin-derived data in plugin-owned storage. */
export interface PluginLearningData {
	/** Learning-data root, not a credential directory or permission to write core files. */
	readonly directory: string;
	/** List saved session summaries with current busy/compacting flags; no model work. */
	listSessions(): ChatListItem[];
	/** Read a complete saved native session, or null when absent. Invalid IDs throw.
	 * Transcripts preserve learner answers/thinking not represented by the graph. */
	getSession(id: string): ChatRecord | null;
	/** Read the current graph projection and raw records, without a second query
	 * language. This is not a complete learner-response transcript. */
	graph(): GraphSnapshot;
	/** Read graph ledger/metadata JSON using the host's current file interpretation.
	 * Host validation/version guards apply; unknown file names throw. */
	readGraphFile<K extends keyof PluginGraphFileData>(name: K): PluginGraphFileData[K];
}
/** Host owns credentials and transport; plugins configure generation only. */
export type PluginInferenceOptions = Pick<SimpleStreamOptions,
	| "temperature" | "maxTokens" | "cacheRetention" | "reasoning" | "thinkingBudgets" | "toolChoice"
	| "timeoutMs" | "maxRetries" | "maxRetryDelayMs" | "metadata"
>;
export interface PluginInferenceRequest {
	model: PluginModelSpec;
	context: Context;
	/** User-initiated work versus automatic/background work; existing connection policy applies. */
	purpose: PluginCallPurpose;
	options?: PluginInferenceOptions;
	signal?: AbortSignal;
}
/** Host-authenticated model calls, which can incur cost. Explicit model/purpose and
 * existing consent/quota policy apply; no silent model or API-key fallback. Usage
 * is recorded under plugin data, not in a core chat. Activation abort scopes calls. */
export interface PluginInference {
	/** Return a detached last-known host catalog without refreshing accounts or
	 * choosing a model. Rejects if unavailable or activation has been cancelled. */
	catalog(): Promise<ModelCatalogResponse>;
	/** Stream native assistant events for one request, not a managed tool loop.
	 * Setup/validation failures throw during iteration; transport/error/abort states
	 * can arrive as terminal native error events. Honor request.signal and inspect
	 * the terminal message rather than treating partial text as success. */
	stream(request: PluginInferenceRequest): AsyncIterable<AssistantMessageEvent>;
	/** Consume a request and return its terminal native assistant message, including
	 * error/aborted stopReason. Setup/validation failures can reject; a resolved
	 * message is not necessarily successful. Caller/activation cancellation applies. */
	complete(request: PluginInferenceRequest): Promise<AssistantMessage>;
}
export type PluginAgentKind = "prober" | "teacher" | "practice";
/** Agent contributions are additive and apply to explicitly selected agent kinds. */
export interface PluginInstructions {
	agents: PluginAgentKind[];
	text: string;
}
export interface PluginToolContext {
	readonly chatId: string;
	readonly agent: PluginAgentKind;
}
/** A fresh native Pi loadout per conversation turn; no private app imports. */
export interface PluginTools {
	agents: PluginAgentKind[];
	/** Create fresh native tools for the matching turn's frozen chat/agent context.
	 * Factory/admission errors omit this plugin's contribution for that turn rather
	 * than replacing host tools. Honor each tool execution's cancellation signal. */
	create(context: PluginToolContext): AgentTool<any>[];
}
/** Backend activation scope, once per enabled plugin per server, not per window.
 * Trusted Node code must cooperate with cancellation; no forced process isolation. */
export interface PluginBackendContext {
	readonly manifest: PluginManifest;
	/** Absolute code directory: app core-plugins/<id> or community plugins/<id>/dist. */
	readonly directory: string;
	/** Writable records: core-plugin-data/<id> or community plugins/<id>/data. */
	readonly dataDirectory: string;
	/** Aborted when this backend activation ends. Recheck after awaits before
	 * plugin-owned side effects; abort does not force-stop arbitrary code. */
	readonly signal: AbortSignal;
	/** Register resource cleanup for deactivation, also supported as activate's
	 * return value. A cleanup registered after expiry is still invoked. */
	cleanup(dispose: PluginCleanup): void;
	/** Read-only native learning records; not a programmable core-data write API. */
	learning: PluginLearningData;
	/** Host-authenticated raw model requests, scoped to activation; can incur cost. */
	inference: PluginInference;
	/** Persistent plugin conversations, not native data/chats sessions. */
	agents: PluginAgentService;
	/** Durable bounded tasks, independent of frontend views; can incur model cost. */
	workers: PluginWorkerService;
	/** Return a native Pi tool bound to this conversation turn. It acknowledges
	 * worker acceptance immediately and delivers the terminal result later through
	 * native job/steer handling. Host-derived identity forces background purpose;
	 * task outcome and later formatting/delivery are separate. */
	createBackgroundTool<T extends TSchema>(context: PluginToolContext, definition: PluginBackgroundTool<T>): AgentTool<T>;
	/** Add system-prompt text for selected native agent kinds, without replacing host
	 * prompts. Invalid contributions throw; unregister affects future turns only. */
	registerInstructions(contribution: PluginInstructions): () => void;
	/** Add fresh tool factories for selected native agent kinds, preserving built-ins.
	 * Invalid registration throws; per-turn factory/collision errors omit this
	 * plugin's contribution. Returned unregister affects future turns. */
	registerTools(contribution: PluginTools): () => void;
	/** Register a type in the host-owned native probe/teach lifecycle with optional
	 * plugin validation/grading. Invalid/duplicate definitions throw; returned
	 * unregister removes availability and aborts this definition's scope. */
	registerQuestionType<Q extends TSchema, A extends TSchema>(definition: PluginQuestionTypeDefinition<Q, A>): () => void;
	/** Register alternative practice poses sharing the native active-problem/conclude
	 * lifecycle. Invalid/duplicate definitions throw; returned unregister removes
	 * availability and aborts this definition's scope, not saved history. */
	registerProblemType<Q extends TSchema, S extends TSchema>(definition: PluginProblemTypeDefinition<Q, S>): () => void;
	/** Register a named operation for this plugin's frontend call bridge. Inputs and
	 * results must be JSON-compatible; validate input in the handler. Invalid or
	 * duplicate names throw. Returns unregister; this is not an arbitrary HTTP API. */
	handle(name: string, handler: (input: unknown) => unknown | Promise<unknown>): () => void;
	/** Live app hints and plugin-scoped notifications, not a durable event log. */
	events: {
		/** Observe supported app events until unsubscribe or activation cleanup.
		 * Listener failures are isolated. Re-read state when needed; turn-settled
		 * follows turn persistence, not completion of asynchronous extraction. */
		on(listener: (event: ServerEvent) => void): () => void;
		/** Notify this plugin's frontend listeners in connected windows with JSON data.
		 * Invalid topics throw while active; expired activations emit nothing. No
		 * persistence, replay or acknowledgement of frontend handling is supplied. */
		emit(topic: string, data?: unknown): void;
	};
}
export interface PluginBackendModule {
	/** Initialize server-scoped registrations/resources; optionally return cleanup.
	 * Activation failures mark this plugin as errored. Modules remain cached, so
	 * put activation side effects here rather than at module top level. */
	activate(context: PluginBackendContext): void | PluginCleanup | Promise<void | PluginCleanup>;
}
export interface PluginView {
	id: string;
	name: string;
	/** Mount only the view body; the host owns title/top bar/actions. Departure,
	 * replacement or disable aborts this mount signal. Return sync/async cleanup
	 * and scope child UI to this signal, not merely to the longer activation. */
	mount(container: HTMLElement, signal: AbortSignal): void | PluginCleanup | Promise<void | PluginCleanup>;
}
export type * from "./plugin-view-context.ts";
export type { PluginActionShortcut, PluginShortcutViewScope } from "./plugin-shortcuts.ts";
export type PluginPageActionContext =
	| { surface: "session"; sessionId: string; kind: "teaching" | "practice"; surfaceTarget: import("./plugin-ui.ts").PluginSurfaceTarget;
		/** Detached whole-session view, captured once before action invocation. */
		readonly view: import("./plugin-view-context.ts").PluginSessionViewContext }
	| { surface: "plugin-view"; pluginId: string; viewId: string }
	| { surface: "app"; pathname: string };
export type PluginActionContext =
	| ({ placement: "top-bar" } & Exclude<PluginPageActionContext, { surface: "app" }>)
	| ({ placement: "keyboard" } & PluginPageActionContext)
	| { placement: "sidebar"; surface: "sidebar" }
	| { placement: "graph"; surface: "graph" };
export interface PluginAction {
	id: string;
	name: string;
	/** Trusted plugin SVG markup. The host still renders the surrounding button. */
	icon?: string;
	/** Opt in without creating chrome. Scope/default are captured at registration. */
	readonly shortcut?: import("./plugin-shortcuts.ts").PluginActionShortcut;
	disabled?: boolean | ((context: PluginActionContext) => boolean);
	/** Execute for the actual invocation placement/page. The host prevents repeat
	 * invocation while busy and reports thrown/rejected errors. Session view data
	 * is captured once before invocation and remains detached across awaits. */
	run(context: PluginActionContext): void | Promise<void>;
}
/** Registration alone never creates chrome. Each placement is explicit. */
export type PluginActionPlacement =
	| { id: string; actionId: string; location: "sidebar" | "graph" }
	| { id: string; actionId: string; location: "top-bar"; sessions?: ("teaching" | "practice")[]; views?: string[] };
export type PluginSettingsRegistration = PluginView["mount"] | import("./plugin-ui.ts").PluginSettingsSchema;
export interface PluginCodeBlockProps {
	language: string;
	source: string;
	meta: string;
	incomplete: boolean;
	/** Aborted on replacement, unmount or plugin disable. */
	signal: AbortSignal;
}
export interface PluginCodeBlockRenderer {
	language: string;
	/** Render this fence into the supplied container; return sync/async cleanup.
	 * Replacement/unregister/disable aborts block.signal. Failed/missing renderers
	 * fall back to readable source; host-only mountMarkdown does not use this hook. */
	mount(container: HTMLElement, block: PluginCodeBlockProps): void | PluginCleanup | Promise<void | PluginCleanup>;
}
export interface PluginToolRenderProps {
	toolName: string;
	toolCallId: string;
	input: unknown;
	state: "input-streaming" | "input-available" | "output-available" | "output-error";
	/** Native result details, also used by existing app tool cards. */
	output?: unknown;
	errorText?: string;
	result?: Pick<ToolResultMessage, "content" | "details" | "isError">;
	/** Present on the separate later result card; the original call retains its ack. */
	background?: PluginBackgroundMeta;
	signal: AbortSignal;
}
export interface PluginToolRenderer {
	toolName: string;
	/** Later worker results collapse by default; rich results may opt into a card or unframed shell. */
	backgroundPresentation?: "collapsed" | "card" | "plain";
	/** Render native tool input/result state; return sync/async cleanup. Replacement,
	 * unregister or disable aborts tool.signal; errors fall back to readable results.
	 * Presentation alone does not create pending learner input or run a tool. */
	mount(container: HTMLElement, tool: PluginToolRenderProps): void | PluginCleanup | Promise<void | PluginCleanup>;
}
/** Frontend activation scope, once per enabled plugin per window. Registrations,
 * subscriptions and UI expire with this activation; backend work is server-owned. */
export interface PluginFrontendContext {
	readonly manifest: PluginManifest;
	/** Aborted when this window's activation ends. Use shorter per-mount signals
	 * for view widgets and cooperative async work. */
	readonly signal: AbortSignal;
	/** Register sync/async resource cleanup for deactivation; late registrations
	 * are still invoked. An activation may also return a cleanup function. */
	cleanup(dispose: PluginCleanup): void;
	/** Register a plugin-owned body view with host chrome. Invalid/duplicate IDs
	 * throw; returned unregister removes the view without deleting plugin data. */
	registerView(view: PluginView): () => void;
	/** Register an invokable action and optional shortcut, but no button placement.
	 * Invalid/duplicate registrations throw. Returns unregister; shortcut scope and
	 * default are captured here, not changed by refreshActions. */
	registerAction(action: PluginAction): () => void;
	/** Place an already registered action in explicit host chrome. Invalid targets
	 * or duplicate placement IDs throw. Returns unregister for this placement only. */
	placeAction(placement: PluginActionPlacement): () => void;
	/** Explicitly notify the host when dynamic action enabled state changes. */
	refreshActions(): void;
	/** Register learner-input preparation under this plugin's identity. Invalid or
	 * duplicate definitions throw; returned unregister aborts its captured scope.
	 * Acceptance, retry and draft-retention rules remain host-owned. */
	registerSubmissionInterceptor(definition: PluginSubmissionInterceptor): () => void;
	/** Notify the host when plugin-owned pending submission input changes. */
	refreshSubmissions(): void;
	/** Register a lazy settings-body mount; returns unregister. Only one settings
	 * registration is allowed per activation. Mount signal scopes its child UI. */
	registerSettings(mount: PluginView["mount"]): () => void;
	/** Register controlled settings rows; returns a shallow-update/dispose handle.
	 * Invalid schemas or duplicate settings registrations throw. The plugin owns
	 * persistence and must publish accepted values after saves. */
	registerSettings(schema: import("./plugin-ui.ts").PluginSettingsSchema): import("./plugin-ui.ts").PluginWidgetHandle<import("./plugin-ui.ts").PluginSettingsSchema>;
	/** Register either a lazy custom mount (unregister function) or controlled schema
	 * (widget handle); neither form loads or saves plugin settings automatically. */
	registerSettings(settings: PluginSettingsRegistration): (() => void) | import("./plugin-ui.ts").PluginWidgetHandle<import("./plugin-ui.ts").PluginSettingsSchema>;
	/** Controlled host widgets/overlays; accessing an unavailable UI host throws. */
	readonly ui: import("./plugin-ui.ts").PluginUi;
	/** Register a fence-language renderer; reserved/duplicate claims throw. Returns
	 * unregister, which aborts existing renderer mounts as well as removing the hook. */
	registerCodeBlock(renderer: PluginCodeBlockRenderer): () => void;
	/** Register native tool-result presentation; reserved/duplicate claims throw.
	 * Returns unregister, which aborts existing mounts. Does not register a tool. */
	registerToolRenderer(renderer: PluginToolRenderer): () => void;
	/** Register owner-scoped slots inside the host question card. Contract versions
	 * must match saved/live questions; invalid/duplicate registrations throw.
	 * Returns unregister; host question identity/acceptance remains authoritative. */
	registerQuestionRenderer(renderer: PluginQuestionRenderer): () => void;
	/** Register owner-scoped practice submission presentation for supported contract
	 * versions. Invalid/duplicate registrations throw. Returns unregister; does not
	 * pose, process or conclude a problem by rendering it. */
	registerProblemRenderer(renderer: PluginProblemRenderer): () => void;
	/** Invoke this plugin's named backend operation with JSON-compatible input and
	 * resolve its result. Rejects on serialization, transport, backend or activation
	 * failure. T is a caller annotation, not runtime validation; no caller signal or
	 * arbitrary HTTP access is exposed. Disabling scopes the frontend request. */
	call<T = unknown>(operation: string, input?: unknown): Promise<T>;
	/** Pure, in-memory PDF/UTF-8 conversion; no learning/model/storage side effects.
	 * Automatically activation-scoped; caller cancellation is optional and cooperative. */
	readonly documents: {
		/** Convert a browser File to Markdown plus notices without saving it. PDF
		 * signature/suffix selects PDF conversion (no OCR); otherwise strict UTF-8.
		 * Busy, invalid, empty or over-limit input rejects with Error, never truncated
		 * success. Caller cancellation preserves signal.reason while activation is
		 * live; cancellation is cooperative, not a hard execution deadline. */
		toMarkdown(file: File, options?: { signal?: AbortSignal }): Promise<{ name: string; markdown: string; notices: string[] }>;
	};
	/** Observe this plugin's live-only notifications; returns unsubscribe and expires
	 * with activation. Re-read state on resync; no implied durable replay. */
	onNotification(listener: (event: PluginNotification) => void): () => void;
	/** Observe live supported app events, excluding plugin-message notifications.
	 * Returns unsubscribe; activation expiry also ends delivery. Events are hints,
	 * not durable replay or completion of asynchronous extraction. */
	onAppEvent(listener: (event: ServerEvent) => void): () => void;
	/** Re-read authoritative state after connection resync; missed events are not
	 * replayed. Returns unsubscribe and expires with this activation. */
	onResync(listener: () => void): () => void;
	/** Host navigation in this window; openView/openSettings target this plugin.
	 * Navigation methods are inert after activation expiry and do not await mounts. */
	app: {
		/** Read the current host pathname, not a captured invocation-page snapshot. */
		pathname(): string;
		/** Navigate to a native session by ID; does not create or run a session. */
		openSession(id: string): void;
		/** Navigate to the host home page. */
		openHome(): void;
		/** Navigate to this plugin's registered view ID, not another plugin's view. */
		openView(id: string): void;
		/** Open this plugin's dedicated Settings page, not package management. */
		openSettings(): void;
	};
}
export interface PluginFrontendModule {
	/** Initialize window-scoped registrations/resources; optionally return cleanup.
	 * Thrown/rejected activation tears down this generation and reports an error.
	 * Module code remains cached; put side effects here, not at module top level. */
	activate(context: PluginFrontendContext): void | PluginCleanup | Promise<void | PluginCleanup>;
}

/** No loosely coercing malformed manifests or executing incompatible packages. */
export function parsePluginManifest(value: unknown, folder: string, appVersion: string): PluginManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest.json must be an object");
	const m = value as Record<string, unknown>;
	if (!PLUGIN_ID_PATTERN.test(folder) || m.id !== folder) throw new Error("Plugin id must match its lowercase-hyphen folder name");
	if (m.apiVersion !== PLUGIN_API_VERSION) throw new Error("Unsupported plugin apiVersion (expected 1)");
	for (const key of ["name", "version", "minAppVersion"] as const) {
		if (typeof m[key] !== "string" || !m[key].trim()) throw new Error(`Manifest ${key} is required`);
	}
	const version = (s: unknown): number[] => {
		if (typeof s !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(s)) throw new Error("Versions must have three numeric components (x.y.z)");
		return s.split(".").map(Number);
	};
	version(m.version);
	const required = version(m.minAppVersion), actual = version(appVersion);
	for (let i = 0; i < 3; i++) {
		if (actual[i]! > required[i]!) break;
		if (actual[i]! < required[i]!) throw new Error(`Requires LearnHarness ${m.minAppVersion} or newer`);
	}
	for (const key of ["description", "author"] as const) {
		if (m[key] !== undefined && typeof m[key] !== "string") throw new Error(`Manifest ${key} must be a string`);
	}
	for (const [key, ext] of [["main", ".js"], ["backend", ".cjs"], ["styles", ".css"]] as const) {
		if (m[key] !== undefined && (typeof m[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(m[key]) || !m[key].endsWith(ext))) throw new Error(`Manifest ${key} must name a root ${ext} file`);
	}
	if (!m.main && !m.backend) throw new Error("A plugin needs a main or backend entry");
	if (m.styles && !m.main) throw new Error("styles requires a frontend main entry");
	return { apiVersion: 1, id: folder, name: m.name as string, version: m.version as string, minAppVersion: m.minAppVersion as string,
		...(m.description !== undefined ? { description: m.description as string } : {}), ...(m.author !== undefined ? { author: m.author as string } : {}),
		...(m.main ? { main: m.main as string } : {}), ...(m.backend ? { backend: m.backend as string } : {}), ...(m.styles ? { styles: m.styles as string } : {}) };
}
