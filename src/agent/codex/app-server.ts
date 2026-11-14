import type { JsonObject } from "@earendil-works/pi-ai";

import type { CliEvent } from "../external-cli/events.ts";

/**
 * `codex app-server` speaks JSON-RPC 2.0 without the `jsonrpc` field, one JSON object per line
 * (shapes from `codex app-server generate-json-schema`, Codex CLI 0.165.0).
 */
export type RpcId = string | number;
export type RpcError = { code: number; message: string };
export type RpcResponse = { result?: unknown; error?: RpcError };

export type RpcMessage =
	| ({ kind: "response"; id: RpcId } & RpcResponse)
	| { kind: "request"; id: RpcId; method: string; params: JsonObject }
	| { kind: "notification"; method: string; params: JsonObject };

/** The server's request ids are its own: a request is a line with a method and an id. */
export function parseRpcLine(line: string): RpcMessage {
	const value: unknown = JSON.parse(line);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("app-server line is not an object");
	const { id, method, params, result, error } = value as { id?: RpcId; method?: string; params?: JsonObject; result?: unknown; error?: RpcError };
	if (typeof method === "string") {
		if (id === undefined) return { kind: "notification", method, params: params ?? {} };
		return { kind: "request", id, method, params: params ?? {} };
	}
	if (id === undefined) throw new Error("app-server line has neither a method nor an id");
	return { kind: "response", id, result, error };
}

/** Numbers our requests, waits for their responses and writes the answers to the server's requests. */
export class RpcClient {
	private nextId = 1;
	private readonly waiting = new Map<RpcId, (response: RpcResponse) => void>();

	constructor(private readonly write: (line: string) => void) {}

	request(method: string, params: object, onResponse: (response: RpcResponse) => void): void {
		const id = this.nextId++;
		this.waiting.set(id, onResponse);
		this.write(JSON.stringify({ id, method, params }));
	}

	notify(method: string, params?: object): void {
		this.write(JSON.stringify(params === undefined ? { method } : { method, params }));
	}

	respond(id: RpcId, result: unknown): void {
		this.write(JSON.stringify({ id, result }));
	}

	respondError(id: RpcId, code: number, message: string): void {
		this.write(JSON.stringify({ id, error: { code, message } }));
	}

	/** Hands a response to whoever waits for it; false when no request of ours has that id. */
	handleResponse(message: { id: RpcId } & RpcResponse): boolean {
		const onResponse = this.waiting.get(message.id);
		if (!onResponse) return false;
		this.waiting.delete(message.id);
		onResponse({ result: message.result, error: message.error });
		return true;
	}
}

/** JSON-RPC methods of `codex app-server` (names from `codex app-server generate-json-schema`). */
export const RpcMethod = {
	INITIALIZE: "initialize",
	INITIALIZED: "initialized",
	CONFIG_READ: "config/read",
	THREAD_START: "thread/start",
	TURN_START: "turn/start",
	TOOL_CALL: "item/tool/call",
	AGENT_MESSAGE_DELTA: "item/agentMessage/delta",
	REASONING_TEXT_DELTA: "item/reasoning/textDelta",
	REASONING_SUMMARY_DELTA: "item/reasoning/summaryTextDelta",
	ITEM_STARTED: "item/started",
	ITEM_COMPLETED: "item/completed",
	TURN_COMPLETED: "turn/completed",
	ERROR: "error",
	COMMAND_APPROVAL: "item/commandExecution/requestApproval",
	FILE_CHANGE_APPROVAL: "item/fileChange/requestApproval",
	PERMISSIONS_APPROVAL: "item/permissions/requestApproval",
	APPLY_PATCH_APPROVAL: "applyPatchApproval",
	EXEC_COMMAND_APPROVAL: "execCommandApproval",
	USER_INPUT_REQUEST: "item/tool/requestUserInput",
	ELICITATION_REQUEST: "mcpServer/elicitation/request",
} as const;
export type RpcMethod = (typeof RpcMethod)[keyof typeof RpcMethod];

/** `turn.status` of the turn/completed notification. */
export const TurnStatus = { COMPLETED: "completed", FAILED: "failed", INTERRUPTED: "interrupted" } as const;
export type TurnStatus = (typeof TurnStatus)[keyof typeof TurnStatus];

/** Item types of Codex's own tools; the lesson never runs them. */
export const NativeItemType = {
	COMMAND_EXECUTION: "commandExecution",
	FILE_CHANGE: "fileChange",
	MCP_TOOL_CALL: "mcpToolCall",
	COLLAB_AGENT_TOOL_CALL: "collabAgentToolCall",
	SUB_AGENT_ACTIVITY: "subAgentActivity",
	WEB_SEARCH: "webSearch",
	IMAGE_VIEW: "imageView",
	SLEEP: "sleep",
	IMAGE_GENERATION: "imageGeneration",
} as const;
export type NativeItemType = (typeof NativeItemType)[keyof typeof NativeItemType];

const NATIVE_ITEM_TYPES: ReadonlySet<string> = new Set(Object.values(NativeItemType));

/** Server requests that ask to run, change or reach something with Codex's own tools. */
const NATIVE_REQUEST_METHODS: ReadonlySet<string> = new Set<string>([
	RpcMethod.COMMAND_APPROVAL, RpcMethod.FILE_CHANGE_APPROVAL, RpcMethod.PERMISSIONS_APPROVAL,
	RpcMethod.APPLY_PATCH_APPROVAL, RpcMethod.EXEC_COMMAND_APPROVAL, RpcMethod.USER_INPUT_REQUEST, RpcMethod.ELICITATION_REQUEST,
]);

export function isNativeRequest(method: string): boolean {
	return NATIVE_REQUEST_METHODS.has(method);
}

type OpenBlock = { kind: "text" | "thinking" | "toolUse"; index: number };

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Turns the app-server notifications of one turn into the CLI events the shared turn code reads. */
export class TurnMapper {
	private messageOpen = false;
	private nextIndex = 0;
	private block: OpenBlock | undefined;

	notification(method: string, params: JsonObject): CliEvent[] {
		switch (method) {
			case RpcMethod.AGENT_MESSAGE_DELTA: return this.delta("text", str(params.delta));
			case RpcMethod.REASONING_TEXT_DELTA:
			case RpcMethod.REASONING_SUMMARY_DELTA: return this.delta("thinking", str(params.delta));
			case RpcMethod.ITEM_STARTED: {
				const type = str((params.item as JsonObject | undefined)?.type);
				return NATIVE_ITEM_TYPES.has(type) ? this.nativeAttempt(type) : [];
			}
			case RpcMethod.ITEM_COMPLETED: return this.closeBlock();
			case RpcMethod.TURN_COMPLETED: return this.turnCompleted((params.turn ?? {}) as JsonObject);
			case RpcMethod.ERROR: {
				if (params.willRetry === true) return [];
				return [{ type: "resultError", text: str((params.error as JsonObject | undefined)?.message) || "Codex reported an error" }];
			}
			default: return [];
		}
	}

	/** A dynamic tool call: its intent (id = callId) as blocks of the open message; `endToolBatch` ends the message. */
	toolCall(callId: string, name: string, args: JsonObject): CliEvent[] {
		const events = [...this.closeBlock(), ...this.ensureMessage()];
		const index = this.nextIndex++;
		events.push(
			{ type: "blockStart", index, block: { type: "toolUse", id: callId, name } },
			{ type: "toolInputDelta", index, partialJson: JSON.stringify(args) },
			{ type: "blockStop", index },
		);
		return events;
	}

	/** Ends the message that carries the tool calls collected so far; it stops for their results. */
	endToolBatch(): CliEvent[] {
		const events: CliEvent[] = [{ type: "messageDelta", stopReason: "tool_use", usage: {} }, { type: "messageStop" }];
		this.reset();
		return events;
	}

	/** Codex tried its own tool: a tool-use block the adapter classifies as native, which fails the turn. */
	nativeAttempt(name: string): CliEvent[] {
		const events = [...this.closeBlock(), ...this.ensureMessage()];
		events.push({ type: "blockStart", index: this.nextIndex++, block: { type: "toolUse", id: `native-${name}`, name } });
		return events;
	}

	private turnCompleted(turn: JsonObject): CliEvent[] {
		const status = str(turn.status);
		if (status === TurnStatus.FAILED) return [{ type: "resultError", text: str((turn.error as JsonObject | undefined)?.message) || "Codex turn failed" }];
		if (status === TurnStatus.INTERRUPTED) return [{ type: "resultError", text: "Codex turn was interrupted" }];
		const events = [...this.closeBlock(), ...this.ensureMessage(), { type: "messageDelta", stopReason: "end_turn", usage: {} } as const, { type: "messageStop" } as const];
		this.reset();
		return events;
	}

	private delta(kind: "text" | "thinking", value: string): CliEvent[] {
		if (!value) return [];
		const events: CliEvent[] = [];
		if (this.block?.kind !== kind) {
			events.push(...this.closeBlock(), ...this.ensureMessage());
			this.block = { kind, index: this.nextIndex++ };
			events.push({ type: "blockStart", index: this.block.index, block: { type: kind } });
		}
		const { index } = this.block!;
		events.push(kind === "text" ? { type: "textDelta", index, text: value } : { type: "thinkingDelta", index, thinking: value });
		return events;
	}

	private ensureMessage(): CliEvent[] {
		if (this.messageOpen) return [];
		this.messageOpen = true;
		return [{ type: "messageStart", usage: {} }];
	}

	private closeBlock(): CliEvent[] {
		if (!this.block) return [];
		const { index } = this.block;
		this.block = undefined;
		return [{ type: "blockStop", index }];
	}

	private reset(): void {
		this.messageOpen = false;
		this.nextIndex = 0;
		this.block = undefined;
	}
}
