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
	requestId: string;
	purpose?: PluginCallPurpose;
}
export interface PluginAgentService {
	register(definition: PluginAgentDefinition): () => void;
	create(definitionId: string): PluginAgentSnapshot;
	list(): PluginAgentSnapshot[];
	get(id: string): PluginAgentSnapshot;
	send(id: string, text: string, options: PluginAgentInputOptions): Promise<PluginAgentSnapshot>;
	answer(id: string, toolCallId: string, value: unknown, options: PluginAgentInputOptions): Promise<PluginAgentSnapshot>;
	run(id: string, options: PluginAgentInputOptions): Promise<PluginAgentSnapshot>;
	abort(id: string): void;
	/** Snapshot first, then live changes. Unsubscribing never cancels execution. */
	subscribe(id: string, listener: (snapshot: PluginAgentSnapshot) => void): () => void;
	/** Cooperative cancellation of all owned work, retaining persisted records. */
	dispose(): Promise<void>;
}
