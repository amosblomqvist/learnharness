/** Plugin API v1. Browser-safe contracts; runtime code is trusted local code. */
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

export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
export interface PluginLearningData {
	readonly directory: string;
	listSessions(): ChatListItem[];
	getSession(id: string): ChatRecord | null;
	/** Raw graph records and projections, without a second query language. */
	graph(): GraphSnapshot;
	/** Read graph ledger/metadata JSON using the host's current file interpretation. */
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
export interface PluginInference {
	catalog(): Promise<ModelCatalogResponse>;
	stream(request: PluginInferenceRequest): AsyncIterable<AssistantMessageEvent>;
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
	create(context: PluginToolContext): AgentTool<any>[];
}
export interface PluginBackendContext {
	readonly manifest: PluginManifest;
	readonly directory: string;
	readonly dataDirectory: string;
	readonly signal: AbortSignal;
	cleanup(dispose: PluginCleanup): void;
	learning: PluginLearningData;
	inference: PluginInference;
	agents: PluginAgentService;
	workers: PluginWorkerService;
	/** Returns a native Pi tool: acknowledge dispatch now, deliver the result later. */
	createBackgroundTool<T extends TSchema>(context: PluginToolContext, definition: PluginBackgroundTool<T>): AgentTool<T>;
	registerInstructions(contribution: PluginInstructions): () => void;
	registerTools(contribution: PluginTools): () => void;
	/** JSON-compatible operation results, not arbitrary HTTP endpoints. */
	handle(name: string, handler: (input: unknown) => unknown | Promise<unknown>): () => void;
	events: {
		on(listener: (event: ServerEvent) => void): () => void;
		emit(topic: string, data?: unknown): void;
	};
}
export interface PluginBackendModule {
	activate(context: PluginBackendContext): void | PluginCleanup | Promise<void | PluginCleanup>;
}
export interface PluginView {
	id: string;
	name: string;
	mount(container: HTMLElement): void | PluginCleanup | Promise<void | PluginCleanup>;
}
export interface PluginAction {
	id: string;
	name: string;
	run(): void | Promise<void>;
}
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
	mount(container: HTMLElement, tool: PluginToolRenderProps): void | PluginCleanup | Promise<void | PluginCleanup>;
}
export interface PluginFrontendContext {
	readonly manifest: PluginManifest;
	readonly signal: AbortSignal;
	cleanup(dispose: PluginCleanup): void;
	registerView(view: PluginView): () => void;
	registerAction(action: PluginAction): () => void;
	registerSettings(mount: PluginView["mount"]): () => void;
	registerCodeBlock(renderer: PluginCodeBlockRenderer): () => void;
	registerToolRenderer(renderer: PluginToolRenderer): () => void;
	call<T = unknown>(operation: string, input?: unknown): Promise<T>;
	/** Live-only notifications. Re-read state on resync; no implied durable replay. */
	onNotification(listener: (event: PluginNotification) => void): () => void;
	onAppEvent(listener: (event: ServerEvent) => void): () => void;
	onResync(listener: () => void): () => void;
	app: {
		pathname(): string;
		openSession(id: string): void;
		openHome(): void;
		openView(id: string): void;
	};
}
export interface PluginFrontendModule {
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
