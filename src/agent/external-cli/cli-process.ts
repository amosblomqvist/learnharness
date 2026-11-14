import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
	createAssistantMessageEventStream,
	type Api,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

import type { AdmittedCall, CliAdapter, CliChild, CliLaunch, HeldCall, RunCli } from "./adapter.ts";
import { CallAdmission } from "./call-admission.ts";
import { ChildControl } from "./child-control.ts";
import { CliOutput, type OutputHost } from "./cli-output.ts";
import { ABORT_MESSAGE, CliTurn } from "./cli-turn.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "./live-processes.ts";
import { configurationForReuse, conversationForReuse } from "./reuse-context.ts";
import { ReuseScope } from "./reuse-scope.ts";

/** One CLI child process across the pi turns that reuse it. */
export class CliProcess implements LiveProcess, OutputHost {
	toolCallIds: string[] = [];
	private readonly control: ChildControl;
	private readonly admission: CallAdmission;
	private output: CliOutput | undefined;
	private pendingError: string | undefined;
	private contextWindow: number | undefined;

	constructor(
		child: ChildProcessWithoutNullStreams,
		private readonly launch: CliLaunch,
		private readonly adapter: CliAdapter,
		private turn: CliTurn,
		private readonly scope: ReuseScope,
	) {
		this.control = new ChildControl(child, adapter.texts.label, () => { this.turn.fail(ABORT_MESSAGE, "aborted"); this.kill(); });
		this.admission = new CallAdmission(adapter.matcher);
	}

	start(signal: AbortSignal | undefined): void {
		const session = this.launch.open({
			write: (line) => this.control.write(line),
			endInput: () => this.control.endInput(),
			stopping: () => this.control.stopping,
			emit: (events) => { try { this.output?.handleEvents(events); } catch { this.fail(this.adapter.texts.malformedOutput); } },
			onContextWindow: (tokens) => { this.contextWindow = tokens; this.turn.setContextWindow(tokens); },
		});
		this.output = new CliOutput(session, this.admission, this.adapter.texts, this);
		this.control.attach({
			onExit: (message) => this.handleClose(message),
			onError: () => { this.turn.fail(this.adapter.texts.startFailed, "error"); this.handleClose(this.adapter.texts.startFailed); },
			onLine: (line) => { try { this.output?.handleLine(line); } catch { this.fail(this.adapter.texts.malformedOutput); } },
		});
		this.control.setSignal(signal);
		if (!this.control.stopping) session.begin();
	}

	get owner(): symbol { return this.scope.owner; }
	get sessionId(): string | undefined { return this.scope.sessionId; }
	get currentTurn(): CliTurn { return this.turn; }
	get stopping(): boolean { return this.control.stopping; }

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		return !this.control.stopping && this.scope.matches(owner, sessionId, configuration, messages, this.admission.admitted.length) && this.admission.answeredBy(results);
	}

	continueTurn(turn: CliTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admission.beginContinuation();
		this.scope.reset(messages);
		this.turn = turn;
		this.turn.setContextWindow(this.contextWindow);
		this.control.setSignal(signal);
		if (this.control.stopping) return;
		this.output?.resume(admitted, results);
	}

	kill(): void {
		removeLiveProcess(this);
		if (!this.control.beginStop()) return;
		this.output?.session.close();
		this.control.terminate();
	}

	fail(message: string): void {
		// Keep a failure after the admitted calls went to Pi for their continuation, not hidden by a replay.
		if (this.sessionId && this.turn.finished && this.toolCallIds.length > 0) this.pendingError = message;
		this.turn.fail(message, "error");
		this.kill();
		if (this.pendingError) addLiveProcess(this);
	}

	consumeFailure(owner: symbol, turn: CliTurn): boolean {
		if (owner !== this.owner || !this.pendingError) return false;
		const message = this.pendingError;
		this.pendingError = undefined;
		this.kill();
		turn.fail(message, "error");
		return true;
	}

	cancelCall(call: HeldCall): void { this.admission.cancel(call); }

	flushAdmissions(): void { this.output?.flush(); }

	admitted(calls: readonly AdmittedCall[]): void {
		this.toolCallIds = calls.map((call) => call.intent.id);
		this.scope.append(this.turn.getMessage());
		if (this.sessionId) addLiveProcess(this);
		else this.kill(); // No trusted scope: return the batch, then use fresh replay.
	}

	private handleClose(message: string): void {
		if (!this.control.markClosed()) return;
		this.output?.session.close();
		removeLiveProcess(this);
		if (this.pendingError) addLiveProcess(this);
		this.control.logStderr();
		this.turn.fail(message, "error");
		this.launch.dispose().catch((error: unknown) => console.error(`${this.adapter.texts.label} cleanup failed:`, error));
	}
}

/** Hands the tool results to the live process that holds their calls; false when none can take them. */
export function continueLiveProcess(turn: CliTurn, owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], signal: AbortSignal | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
	const process = getLiveProcess(ids, owner, sessionId);
	if (!(process instanceof CliProcess)) return false;
	if (process.consumeFailure(owner, turn)) return true;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.kill();
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

type StartInput = {
	adapter: CliAdapter;
	run: RunCli;
	turn: CliTurn;
	model: Model<Api>;
	context: TranscriptContext;
	options: SimpleStreamOptions | undefined;
	owner: symbol;
	configuration: unknown;
	env: NodeJS.ProcessEnv;
};

async function startProcess({ adapter, run, turn, model, context, options, owner, configuration, env }: StartInput): Promise<void> {
	if (options?.signal?.aborted) { turn.fail(ABORT_MESSAGE, "aborted"); return; }
	let cliProcess: CliProcess | undefined;
	const launch = await adapter.launch({
		model,
		context,
		options,
		hooks: {
			onCall: () => cliProcess?.flushAdmissions(),
			onError: (error) => cliProcess?.fail(error.message),
			onCancel: (call) => cliProcess?.cancelCall(call),
		},
	});
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await launch.dispose();
		return;
	}

	let child: CliChild;
	try {
		child = await run(launch.args, { cwd: launch.cwd, env: launch.env ? { ...env, ...launch.env } : env, signal: options?.signal });
	} catch (error) {
		await launch.dispose();
		throw error;
	}

	if (!child) {
		turn.fail(adapter.texts.cliNotFound, "error");
		await launch.dispose();
		return;
	}

	const scope = new ReuseScope(owner, options?.sessionId, configuration, structuredClone(conversationForReuse(context.messages)));
	cliProcess = new CliProcess(child, launch, adapter, turn, scope);
	cliProcess.start(options?.signal);
}

/** A pi stream function that runs the CLI described by `adapter` through `run`. */
export function createCliStreamFunction(adapter: CliAdapter, run: RunCli): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol(adapter.ownerName);
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new CliTurn(stream, model, new Set(getCurrentTools(context.messages).map((tool) => tool.name)), adapter);

		const env = adapter.env();
		// An existing child must not retain stale authentication/routing after env changes.
		const configuration = { request: configurationForReuse(model, context, adapter.reuseEffort(options)), env };
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) return stream;

		startProcess({ adapter, run, turn, model, context, options, owner, configuration, env }).catch((error: unknown) => {
			console.error(`${adapter.texts.label} turn failed:`, error);
			const aborted = options?.signal?.aborted;
			turn.fail(aborted ? ABORT_MESSAGE : adapter.startErrorMessage(error), aborted ? "aborted" : "error");
		});

		return stream;
	};
}
