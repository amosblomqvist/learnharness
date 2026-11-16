import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type {
	Api,
	JsonObject,
	Model,
	SimpleStreamOptions,
	StopReason,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
} from "@earendil-works/pi-ai";

import type { CallMatcher } from "./call-matching.ts";
import type { CliEvent } from "./events.ts";

export type CliChild = ChildProcessWithoutNullStreams | null;
export type RunCliOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };
/** Spawns the CLI; null when its binary cannot be found. */
export type RunCli = (args: string[], options: RunCliOptions) => CliChild | Promise<CliChild>;

/** A call the child process holds until it gets a result (for example an MCP tools/call or a JSON-RPC request). */
export type HeldCall = { id: string; name: string; arguments: JsonObject };
/** An admitted call: the intent handed to pi and the held call its result goes back to. */
export type AdmittedCall = { intent: ToolCall; held: HeldCall };

/** Where held calls wait for their results. Resolving one also writes the continuing input. */
export type CallChannel = {
	pending(): HeldCall[];
	resolve(call: HeldCall, result: ToolResultMessage): void;
};

/** Notifications from the call channel to the shared process. */
export type CallHooks = { onCall(): void; onError(error: Error): void; onCancel(call: HeldCall): void };

export const ToolUseKind = { HARNESS: "harness", RETRY_BARE: "retryBare", NATIVE: "native" } as const;
export type ToolUseKind = (typeof ToolUseKind)[keyof typeof ToolUseKind];
/** HARNESS: a harness tool under `name`. RETRY_BARE: a harness tool the CLI rejects itself, so the model retries. NATIVE: unsupported. */
export type ToolUseVerdict =
	| { kind: typeof ToolUseKind.HARNESS; name: string }
	| { kind: typeof ToolUseKind.RETRY_BARE }
	| { kind: typeof ToolUseKind.NATIVE };

/** Writes to the child process and reads the shared state. */
export type SessionIo = {
	/** Writes one line to stdin; the newline is added. */
	write(line: string): void;
	/** Closes stdin, for a CLI that reads its whole input before it starts. */
	endInput(): void;
	stopping(): boolean;
	/** Hands events the session produced outside a stdout line (a timer, a result that releases a queued call) to the turn. */
	emit(events: readonly CliEvent[]): void;
	onContextWindow(tokens: number): void;
};

/** The CLI-specific state of one child process: its stdin framing, stdout reading and context window. */
export type CliSession = {
	readonly channel: CallChannel;
	/** Writes the first input. */
	begin(): void;
	/** Events in one stdout line; [] for a control line. Throwing marks the output malformed. */
	readLine(line: string): readonly CliEvent[];
	onMessageStart(): void;
	close(): void;
};

/** What is ready before spawning. */
export type CliLaunch = {
	args: string[];
	cwd: string;
	/** Added to the adapter's env for this child (for example the path of a file written for this turn). */
	env?: Record<string, string>;
	open(io: SessionIo): CliSession;
	/** Releases what the launch holds (for example a tool bridge and temp directories). */
	dispose(): Promise<void>;
};

export type LaunchInput = { model: Model<Api>; context: TranscriptContext; options: SimpleStreamOptions | undefined; hooks: CallHooks };

/** Error texts and the console prefix of one CLI. */
export type CliTexts = {
	/** Prefix of console lines and of the exit message. */
	label: string;
	startFailed: string;
	noStopReason: string;
	nativeToolCall: string;
	malformedOutput: string;
	callMismatch: string;
	refusedBeforeAdmission: string;
	movedOnWhileWaiting: string;
	movedOnWithoutAdmitting: string;
	invalidToolBatch: string;
	cliNotFound: string;
};

/** The parts of an external CLI provider that differ per CLI. */
export type CliAdapter = {
	/** Description of the stream function's owner symbol. */
	readonly ownerName: string;
	readonly texts: CliTexts;
	readonly stopReasons: Readonly<Record<string, StopReason>>;
	readonly matcher: CallMatcher;
	env(): NodeJS.ProcessEnv;
	/** The effort that must match for a live process to be reused. */
	reuseEffort(options: SimpleStreamOptions | undefined): string;
	classifyToolUse(name: string, harnessToolNames: ReadonlySet<string>): ToolUseVerdict;
	assistantErrorMessage(error: string, text: string): string;
	startErrorMessage(error: unknown): string;
	launch(input: LaunchInput): Promise<CliLaunch>;
};
