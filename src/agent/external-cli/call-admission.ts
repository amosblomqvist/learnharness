import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

import type { AdmittedCall, HeldCall } from "./adapter.ts";
import type { CallMatcher } from "./call-matching.ts";

/** Tool intents waiting for their held calls, and the calls admitted to pi. */
export class CallAdmission {
	private sourceCalls: ToolCall[] = [];
	private complete = false;
	private admittedCalls: AdmittedCall[] = [];
	private readonly cancelled: HeldCall[] = [];

	constructor(private readonly matcher: CallMatcher) {}

	get admitted(): readonly AdmittedCall[] { return this.admittedCalls; }

	/** The current message's intents are all known. */
	get sourceComplete(): boolean { return this.complete; }

	setSource(intents: ToolCall[]): void {
		this.sourceCalls = this.cancelled.reduce((calls, call) => this.matcher.withoutCancelled(calls, call), [...intents]);
		this.complete = true;
	}

	hasUnadmittedSource(): boolean { return this.complete && this.sourceCalls.length > 0; }

	isQueued(id: string): boolean { return this.sourceCalls.some((call) => call.id === id); }

	cancel(call: HeldCall): void {
		this.cancelled.push(call);
		// Already admitted work belongs to Pi and cannot be undone. A queued
		// request, however, must never become executable after cancellation.
		this.sourceCalls = this.matcher.withoutCancelled(this.sourceCalls, call);
	}

	/** Admits the pending calls: [] when none are pending, null when one does not match its intent. */
	take(pending: readonly HeldCall[]): AdmittedCall[] | null {
		if (pending.length === 0) return [];
		const pairs = this.matcher.pair(this.sourceCalls, pending);
		if (!pairs) return null;
		this.sourceCalls = this.sourceCalls.filter((call) => !pairs.some((pair) => pair.intent === call));
		this.admittedCalls = pairs;
		return pairs;
	}

	/** Every admitted call has exactly one result with its id and name. */
	answeredBy(results: ToolResultMessage[]): boolean {
		return results.length === this.admittedCalls.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admittedCalls.every(({ intent }) => results.some((result) => result.toolCallId === intent.id && result.toolName === intent.name));
	}

	/** Hands back the admitted calls and clears them for the next turn. */
	beginContinuation(): AdmittedCall[] {
		const admitted = this.admittedCalls;
		this.admittedCalls = [];
		this.complete = this.sourceCalls.length > 0;
		return admitted;
	}
}
