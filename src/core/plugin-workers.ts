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
	/** Task lifetime cancellation. Tools must cooperate and recheck after awaits
	 * before side effects; cancellation cannot undo external effects. */
	readonly signal: AbortSignal;
}
export interface PluginWorkerDefinition {
	id: string;
	instructions: string;
	/** The host exposes submit_result({ result: <this schema> }). */
	resultSchema: TSchema;
	/** Create native tools for this accepted task; result submission is host-owned. */
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
	/** Derive worker input, prompt and explicit limits without side effects. The host
	 * supplies request identity and forces background purpose. */
	prepare(input: Static<T>, context: PluginToolContext):
		Omit<PluginWorkerStartOptions, "requestId" | "purpose"> | Promise<Omit<PluginWorkerStartOptions, "requestId" | "purpose">>;
	/** Turn a terminal outcome into model text and optional rendered data; keep this
	 * side-effect free. Failure records a presentation error, not a different task
	 * outcome; restart delivery may use persisted fallback without rerunning it. */
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
/** Plugin-owned bounded tasks; model execution can incur cost. Task lifetime is
 * independent of views/subscriptions. Disable/restart interrupts unfinished tasks;
 * reactivation does not replay them. */
export interface PluginWorkerService {
	/** Register instructions, result schema and optional tools/refinement validator.
	 * Invalid/duplicate definitions throw. Returns an unregister function that
	 * interrupts unfinished tasks for this definition, retaining their records. */
	register(definition: PluginWorkerDefinition): () => void;
	/** Persist durable acceptance and return a queued snapshot, not completion.
	 * Model/tool execution proceeds independently of views. Identical request ID
	 * and options return the existing task; conflicting reuse throws. Invalid input,
	 * missing definitions and acceptance persistence failures throw synchronously. */
	start(definitionId: string, options: PluginWorkerStartOptions): PluginTaskSnapshot;
	/** Return detached snapshots of owned tasks, including ephemeral progress;
	 * listing does not start or resume work. */
	list(): PluginTaskSnapshot[];
	/** Return a detached task snapshot. Unknown IDs throw; only succeeded status
	 * makes result authoritative, including falsy JSON results. */
	get(id: string): PluginTaskSnapshot;
	/** Deliver a snapshot synchronously, then live state/progress changes. Returns
	 * an unsubscribe function, not a cancellation handle. Unknown IDs throw; an
	 * initial listener throw removes the subscription. */
	subscribe(id: string, listener: (snapshot: PluginTaskSnapshot) => void): () => void;
	/** Resolve the terminal outcome, including failed/cancelled/interrupted states;
	 * task failure is not a rejected wait. An aborted signal rejects with AbortError
	 * and stops only this waiter, not the task. Storage failures can reject, and an
	 * unknown task ID throws before waiting. */
	wait(id: string, signal?: AbortSignal): Promise<PluginTaskOutcome>;
	/** Persist cancelled status for unfinished work and signal cooperative cancellation.
	 * Terminal tasks are unchanged; external effects cannot be undone. Unknown IDs
	 * and persistence failures throw. */
	cancel(id: string): void;
	/** Interrupt unfinished tasks, clear definitions/listeners and cancel task scopes,
	 * retaining history/results; never replay on reactivation. Idempotent and does
	 * not await uncooperative tools. Persistence failures reject. Host disable also
	 * disposes this service. */
	dispose(): Promise<void>;
}
