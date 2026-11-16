import type { ToolResultMessage } from "@earendil-works/pi-ai";

import type { AdmittedCall, CliSession, CliTexts } from "./adapter.ts";
import type { CallAdmission } from "./call-admission.ts";
import type { CliTurn } from "./cli-turn.ts";
import type { CliEvent } from "./events.ts";

/** What the output router reads from and reports to its process. */
export type OutputHost = {
	readonly currentTurn: CliTurn;
	readonly stopping: boolean;
	fail(message: string): void;
	kill(): void;
	/** The turn has admitted these calls. */
	admitted(calls: readonly AdmittedCall[]): void;
};

/** Routes one child's stdout events to the current turn and admits held calls. */
export class CliOutput {
	constructor(
		readonly session: CliSession,
		private readonly admission: CallAdmission,
		private readonly texts: CliTexts,
		private readonly host: OutputHost,
	) {}

	handleLine(line: string): void {
		if (this.host.stopping || !line.trim()) return;
		this.handleEvents(this.session.readLine(line));
	}

	handleEvents(events: readonly CliEvent[]): void {
		for (const event of events) {
			if (this.host.stopping) return;
			this.handleEvent(event);
		}
	}

	/** Returns the results of the calls admitted in the previous turn, then admits what is pending. */
	resume(admitted: readonly AdmittedCall[], results: ToolResultMessage[]): void {
		for (const call of admitted) this.session.channel.resolve(call.held, results.find((result) => result.toolCallId === call.intent.id)!);
		this.flush();
	}

	/** Only calls held by the call channel, never stdout intent alone, admit side effects. */
	flush(): void {
		const turn = this.host.currentTurn;
		if (this.host.stopping || turn.finished || !this.admission.sourceComplete) return;
		const admitted = this.admission.take(this.session.channel.pending());
		if (!admitted) { this.host.fail(this.texts.callMismatch); return; }
		if (admitted.length === 0) return;
		turn.admit(admitted.map((call) => call.intent));
		this.host.admitted(admitted);
	}

	private handleEvent(event: CliEvent): void {
		const turn = this.host.currentTurn;
		if (event.type === "toolResults") {
			if (event.ids.some((id) => this.admission.isQueued(id))) this.host.fail(this.texts.refusedBeforeAdmission);
			return;
		}
		// Moving on before held calls were answered means the CLI did not
		// honor this tool wait. Never execute further stdout-only intentions.
		if (turn.finished) { this.host.fail(this.texts.movedOnWhileWaiting); return; }
		if (event.type === "messageStart" && this.admission.hasUnadmittedSource()) { this.host.fail(this.texts.movedOnWithoutAdmitting); return; }
		if (event.type === "messageStart") this.session.onMessageStart();
		turn.handle(event);
		if (turn.finished) { this.host.kill(); return; }
		if (event.type === "messageStop" && turn.waitingForAdmission) this.collectIntents(turn);
	}

	private collectIntents(turn: CliTurn): void {
		const intents = turn.getIntents();
		// Only rejected bare calls: keep the turn open for the model's retry in its next message.
		if (intents.length === 0 && turn.skippedBareCall) return;
		if (intents.length === 0 || new Set(intents.map((call) => call.id)).size !== intents.length) {
			this.host.fail(this.texts.invalidToolBatch);
			return;
		}
		this.admission.setSource(intents);
		this.flush();
	}
}
