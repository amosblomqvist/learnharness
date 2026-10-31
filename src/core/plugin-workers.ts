/** Result-oriented tasks owned by a plugin. Execution uses the native Pi runner. */
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { JobUsage } from "./contracts/jobs.ts";
import type { PluginCallPurpose, PluginModelSpec } from "./plugin-agents.ts";
import type { PluginInferenceOptions, PluginToolContext } from "./plugins.ts";

export interface PluginWorkerContext {
	readonly taskId: string;
	/** Immutable accepted input, never an identity supplied by the model's result. */
	readonly input: unknown;
	readonly signal: AbortSignal;
}
export interface PluginWorkerDefinition {
	id: string;
	instructions: string;
	/** The host exposes submit_result({ result: <this schema> }). */
	resultSchema: TSchema;
	tools?: (context: PluginWorkerContext) => AgentTool<any>[];
	/** Throw useful correction feedback. This validator must not have side effects. */
	validateResult?: (result: unknown, context: PluginWorkerContext) => void | Promise<void>;
}
export interface PluginWorkerStartOptions {
	/** Retries of the same acceptance use the same id; a new attempt uses a new id. */
	requestId: string;
	input: unknown;
	prompt: string;
	model: PluginModelSpec;
	purpose: PluginCallPurpose;
	/** Maximum model turns, including correction turns. No implicit default. */
	maxTurns: number;
	options?: PluginInferenceOptions;
	/** Wall-clock lifetime from acceptance, including admission waits. */
	timeoutMs?: number;
}
export type PluginTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface PluginTaskError {
	code: "no_result" | "max_turns" | "timeout" | "run_error" | "storage_error" | "cancelled" | "interrupted";
	message: string;
}
export interface PluginTaskRecord extends PluginWorkerStartOptions {
	version: 1;
	id: string;
	definitionId: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	status: PluginTaskStatus;
	messages: AgentMessage[];
	turns: number;
	activity?: string;
	usage?: JobUsage;
	/** Authoritative only when status is succeeded; falsy JSON values are valid. */
	result?: unknown;
	error?: PluginTaskError;
}
export interface PluginTaskSnapshot extends PluginTaskRecord {
	/** Ephemeral streaming progress, not committed history or a result. */
	partial?: AssistantMessage;
}
export type PluginTaskOutcome =
	| { id: string; status: "succeeded"; result: unknown }
	| { id: string; status: "failed" | "cancelled" | "interrupted"; error: PluginTaskError };
/** A thin native-tool adapter, not another agent or tool execution framework. */
export type PluginBackgroundTool<T extends TSchema = TSchema> = Omit<AgentTool<T>, "execute"> & {
	workerId: string;
	prepare(input: Static<T>, context: PluginToolContext):
		Omit<PluginWorkerStartOptions, "requestId" | "purpose"> | Promise<Omit<PluginWorkerStartOptions, "requestId" | "purpose">>;
	/** Model text and rendered data are separate. Keep this formatter side-effect free. */
	format(outcome: PluginTaskOutcome, context: PluginToolContext): PluginBackgroundPresentation | Promise<PluginBackgroundPresentation>;
};
export interface PluginBackgroundPresentation {
	text: string;
	data?: unknown;
}
/** Persisted in the normal background-job result and conversation marker. */
export interface PluginBackgroundResult extends PluginBackgroundPresentation {
	pluginId: string;
	toolName: string;
	input: unknown;
	outcome: PluginTaskOutcome;
	/** Worker success is not retroactively changed by presentation failure. */
	formatError?: string;
}
export interface PluginBackgroundMeta {
	pluginId: string;
	taskId: string;
	status: PluginTaskOutcome["status"];
}
export interface PluginWorkerService {
	register(definition: PluginWorkerDefinition): () => void;
	/** Durable acceptance only. Model/tool execution proceeds independently of views. */
	start(definitionId: string, options: PluginWorkerStartOptions): PluginTaskSnapshot;
	list(): PluginTaskSnapshot[];
	get(id: string): PluginTaskSnapshot;
	subscribe(id: string, listener: (snapshot: PluginTaskSnapshot) => void): () => void;
	/** Aborting a wait stops only that waiter, not the task. */
	wait(id: string, signal?: AbortSignal): Promise<PluginTaskOutcome>;
	cancel(id: string): void;
	/** Interrupt unfinished tasks, retain history/results, never replay on reactivation. */
	dispose(): Promise<void>;
}
