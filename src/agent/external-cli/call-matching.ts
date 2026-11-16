import { isDeepStrictEqual } from "node:util";

import type { ToolCall } from "@earendil-works/pi-ai";

import type { AdmittedCall, HeldCall } from "./adapter.ts";

/** Pairs streamed tool intents with the calls the child process holds. */
export type CallMatcher = {
	/** Pairs for every pending call, or null when any pending call has no matching intent. */
	pair(intents: readonly ToolCall[], pending: readonly HeldCall[]): AdmittedCall[] | null;
	/** The intents left after removing the one a cancelled call stands for. */
	withoutCancelled(intents: readonly ToolCall[], call: HeldCall): ToolCall[];
};

function sameCall(intent: ToolCall, call: HeldCall): boolean {
	return intent.name === call.name && isDeepStrictEqual(intent.arguments, call.arguments);
}

/** The held call carries the intent's id. */
export const matchById: CallMatcher = {
	pair(intents, pending) {
		const pairs: AdmittedCall[] = [];
		for (const held of pending) {
			const intent = intents.find((candidate) => candidate.id === held.id);
			if (!intent || !sameCall(intent, held)) return null;
			pairs.push({ intent, held });
		}
		return pairs;
	},
	withoutCancelled(intents, call) {
		return intents.filter((intent) => intent.id !== call.id);
	},
};

/** The held call has its own id: pair by name and arguments, in arrival order. */
export const matchInOrder: CallMatcher = {
	pair(intents, pending) {
		const used = new Set<ToolCall>();
		const pairs: AdmittedCall[] = [];
		for (const held of pending) {
			const intent = intents.find((candidate) => !used.has(candidate) && sameCall(candidate, held));
			if (!intent) return null;
			used.add(intent);
			pairs.push({ intent, held });
		}
		return pairs;
	},
	withoutCancelled(intents, call) {
		const index = intents.findIndex((intent) => sameCall(intent, call));
		return index < 0 ? [...intents] : intents.filter((_, position) => position !== index);
	},
};
