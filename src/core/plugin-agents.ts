/** Public managed-agent contract. Records belong to a plugin, never data/chats. */
import type { AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { ChatSettings } from "./contracts/chat.ts";

export type PluginModelSpec = NonNullable<ChatSettings["model"]> & { thinkingLevel?: ChatSettings["thinkingLevel"] };
export type PluginCallPurpose = "user" | "background";
export type PluginAgentTool = {
	name: string;
	description: string;
	parameters: TSchema;
	prepareArguments?: AgentTool<any>["prepareArguments"];
	resultSchema?: TSchema;
	formatResult?: (value: unknown) => AgentToolResult<unknown>;
} & (
	| {
		/** Declarative external input is persisted, never a suspended Promise. */
		kind: "input";
		execute?: never;
		endRun?: never;
	}
	| {
		kind?: "server";
		execute: AgentTool<any>["execute"];
		/** A successful ordinary tool may return its result and pause the run. */
		endRun?: boolean;
	}
);
export interface PluginAgentDefinition {
	id: string;
	instructions: string;
	model: PluginModelSpec;
	tools?: PluginAgentTool[];
	maxTurns?: number;
}
export interface PluginPendingInput {
	toolCallId: string;
	toolName: string;
	input: unknown;
}
export interface PluginAgentRecord {
	version: 1;
	id: string;
	definitionId: string;
	createdAt: string;
	updatedAt: string;
	messages: AgentMessage[];
	pending: PluginPendingInput[];
	status: "idle" | "running" | "waiting" | "error" | "interrupted";
	error?: string;
	/** Accepted input identities prevent a retried submission running twice. */
	acceptedInputs: string[];
}
export interface PluginAgentSnapshot extends PluginAgentRecord {
	/** Ephemeral response-so-far; never confused with committed history. */
	partial?: AssistantMessage;
}
export interface PluginAgentInputOptions {
	/** Retry an accepted action with the same identity to avoid accepting it twice;
	 * a new action needs a new ID. This does not guarantee exactly-once external effects. */
	requestId: string;
	/** Initiation/consent classification, not view visibility. Defaults to user for
	 * send/answer and background for run; classify automatic work explicitly. */
	purpose?: PluginCallPurpose;
}
/** Plugin-owned persistent conversations, independent of frontend views. Model
 * execution can incur cost. Re-register compatible definitions after activation;
 * restart interrupts running work rather than replaying tools automatically. */
export interface PluginAgentService {
	/** Register instructions, model and tools for a definition ID. Invalid/duplicate
	 * definitions throw. Returns an unregister function that cooperatively cancels
	 * that definition's active runs without deleting saved conversations. */
	register(definition: PluginAgentDefinition): () => void;
	/** Persist an empty idle conversation and return its detached snapshot; no model
	 * request starts. Throws if the definition is unavailable or persistence fails. */
	create(definitionId: string): PluginAgentSnapshot;
	/** Return detached snapshots of this plugin's conversations, including current
	 * ephemeral partials. Does not run, resume or subscribe to any conversation. */
	list(): PluginAgentSnapshot[];
	/** Read one detached snapshot, including any current partial. Unknown IDs throw;
	 * a returned partial is progress, not committed history. */
	get(id: string): PluginAgentSnapshot;
	/** Persist explicit nonblank user text and launch execution. Resolves after
	 * acceptance, not completion; observe later status/errors with get/subscribe.
	 * An already accepted requestId returns current state without another input.
	 * Rejects busy sessions, unresolved external inputs and acceptance/storage errors. */
	send(id: string, text: string, options: PluginAgentInputOptions): Promise<PluginAgentSnapshot>;
	/** Validate and persist one pending input-tool result. Invalid answers are not
	 * saved; the final required answer launches continuation. Resolves to accepted
	 * state, not model completion; accepted request IDs do not submit twice.
	 * Missing inputs/definitions, busy sessions and validation/storage failures reject. */
	answer(id: string, toolCallId: string, value: unknown, options: PluginAgentInputOptions): Promise<PluginAgentSnapshot>;
	/** Resume existing runnable persisted input without appending a synthetic prompt.
	 * Resolves after acceptance, not completion; accepted request IDs return current
	 * state. Rejects pending external inputs, unsafe unresolved tool batches, busy
	 * sessions or history with no runnable input; use send for a new explicit task. */
	run(id: string, options: PluginAgentInputOptions): Promise<PluginAgentSnapshot>;
	/** Request cooperative cancellation of an active run, retaining messages/pending
	 * inputs. Idle runs are unchanged. Does not await uncooperative tool code or undo
	 * external effects; unknown IDs and persistence failures throw. */
	abort(id: string): void;
	/** Deliver a detached snapshot synchronously, then live state/progress changes.
	 * Returns an unsubscribe function; unsubscribing never cancels execution.
	 * Unknown IDs throw; an initial listener throw removes the subscription. */
	subscribe(id: string, listener: (snapshot: PluginAgentSnapshot) => void): () => void;
	/** Cooperatively cancel owned runs and release definitions/listeners, retaining
	 * persisted records. Idempotent; does not wait for uncooperative plugin code.
	 * Rejects on cancellation persistence failure. Host disable also disposes. */
	dispose(): Promise<void>;
}
