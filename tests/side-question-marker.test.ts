import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	asAgentMessages,
	endsInDismissal,
	endsInQuestionRecovery,
	isSideQuestionMarker,
	nativeInputCause,
	needsContinuation,
	newAnswerResult,
	newUserMessage,
	reconstructRequestCause,
	toLlmMessages,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { endsInFailedTurn, failedResponseAtEnd, retryDrops } from "../src/core/input-events.ts";
import { compactionCutIndex, serializeForSummary } from "../src/core/compaction.ts";
import { projectView } from "../src/core/view.ts";
import { dismissedAnswer } from "../src/core/question-core.ts";
import { newSideQuestionMarker, newSideQuestionToldMarker, sideTranscript } from "../src/core/side-questions.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(id: string, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse", errorMessage?: string): LhMessage {
	return { id, role: "assistant", content, api: "faux", provider: "faux", model: "m", usage, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: 1 } as LhMessage;
}
const quiz = { question: "Q?", options: [{ label: "a" }, { label: "b" }], explanation: "e", correctAnswer: "a" };
const details = (toldTutor: boolean) => ({ thread: [{ question: "Why?", answer: "Because." }], note: "Already clarified in a side question: why.", toldTutor });
const told = () => newSideQuestionMarker("side_told", details(true)) as LhMessage;
const quiet = () => newSideQuestionMarker("side_quiet", details(false)) as LhMessage;

const posed = (): LhMessage[] => [newUserMessage("go") as LhMessage, assistant("a1", [{ type: "toolCall", id: "c1", name: "quiz", arguments: quiz }])];
const answeredBatch = (): LhMessage[] => [...posed(), newAnswerResult("c1", "quiz", { kind: "quiz", questionText: "Q?", answers: ["a"], dontKnow: false, answeredAt: "t" }) as LhMessage];
const dismissedTail = (): LhMessage[] => [...posed(), newAnswerResult("c1", "quiz", dismissedAnswer("quiz", "Q?")) as LhMessage];
const failure = (): LhMessage[] => [newUserMessage("go") as LhMessage, assistant("a_fail", [{ type: "text", text: "par" }], "error", "boom")];

describe("the side-question marker on the wire", () => {
	it("an untold marker is absent; a told one is user text carrying the note", () => {
		const wire = toLlmMessages(asAgentMessages([newUserMessage("hi") as LhMessage, quiet(), told()]));
		assert.equal(wire.length, 2);
		assert.deepEqual(wire[1]!.content, [{ type: "text", text: "Already clarified in a side question: why." }]);
	});
	it("an untold marker never reaches the side agent's transcript either", () => {
		assert.doesNotMatch(sideTranscript([newUserMessage("hi") as LhMessage, quiet()]), /Already clarified/);
	});
	it("is a neutral input and changes no request cause", () => {
		assert.equal(nativeInputCause(asAgentMessages([told()])[0]!, []), "neutral");
		const base = answeredBatch();
		assert.equal(reconstructRequestCause([...base, told()]), reconstructRequestCause(base));
		assert.equal(isSideQuestionMarker(told()), true);
		assert.equal(isSideQuestionMarker(base[0]), false);
	});
});

describe("side-question markers are transparent at the record's tail", () => {
	it("keeps a dismissal pause", () => {
		assert.equal(endsInDismissal([...dismissedTail(), quiet(), told()]), true);
	});
	it("keeps a continuation owed", () => {
		assert.equal(needsContinuation([...answeredBatch(), told()]), true);
		assert.equal(needsContinuation([...dismissedTail(), told()]), false);
	});
	it("keeps a question recovery tail", () => {
		const recovery: LhMessage = { id: "r1", role: "toolResult", toolCallId: "c1", toolName: "quiz", content: [{ type: "text", text: "x" }], details: { questionRecovery: true }, isError: true, timestamp: 1 } as LhMessage;
		assert.equal(endsInQuestionRecovery([...posed(), recovery, told()]), true);
	});
	it("keeps Retry available and drops only the failure", () => {
		const record = [...failure(), told()];
		assert.equal(endsInFailedTurn(record), true);
		assert.deepEqual([...retryDrops(record)], ["a_fail"]);
		assert.equal(failedResponseAtEnd(record)?.id, "a_fail");
	});
});

describe("compaction and side-question markers", () => {
	it("an untold marker is never a cut point and never summarized; a told one is a system note", () => {
		// UI-only metadata rides with the kept message after it.
		const record: LhMessage[] = [newUserMessage("x".repeat(400)) as LhMessage, quiet(), assistant("a1", [{ type: "text", text: "y".repeat(400) }], "stop")];
		assert.equal(compactionCutIndex(record, 1), 1);
		const summary = serializeForSummary([quiet(), told()]);
		assert.doesNotMatch(summary, /^\[SYSTEM NOTE\] $/m);
		assert.match(summary, /\[SYSTEM NOTE\] Already clarified in a side question: why\./);
		assert.equal(summary.split("\n\n").length, 1);
	});
});

describe("the side-question view", () => {
	it("projects one user message with a data-side-question part", () => {
		const view = projectView([newUserMessage("hi") as LhMessage, told()]);
		const last = view.at(-1)!;
		assert.equal(last.id, "side_told");
		assert.equal(last.role, "user");
		assert.deepEqual(last.parts, [{ type: "data-side-question", id: "sq_side_told", data: details(true) }]);
	});
});

describe("telling the tutor later (side-question-told)", () => {
	const toldLater = () => newSideQuestionToldMarker("side_quiet", "Already clarified in a side question: why.") as LhMessage;
	it("carries the note to the tutor at its own position", () => {
		const m = toldLater();
		assert.equal(m.id, "side_quiet_told");
		const wire = toLlmMessages(asAgentMessages([newUserMessage("hi") as LhMessage, quiet(), toldLater()]));
		assert.equal(wire.length, 2);
		assert.deepEqual(wire[1]!.content, [{ type: "text", text: "Already clarified in a side question: why." }]);
		assert.match(sideTranscript([quiet(), toldLater()]), /\[NOTE\] Already clarified/);
	});
	it("is neutral and transparent at the tail", () => {
		assert.equal(nativeInputCause(asAgentMessages([toldLater()])[0]!, []), "neutral");
		assert.equal(isSideQuestionMarker(toldLater()), true);
		assert.equal(endsInDismissal([...dismissedTail(), quiet(), toldLater()]), true);
		assert.equal(needsContinuation([...answeredBatch(), toldLater()]), true);
		assert.equal(endsInFailedTurn([...failure(), toldLater()]), true);
		assert.deepEqual([...retryDrops([...failure(), toldLater()])], ["a_fail"]);
	});
	it("renders nothing itself and marks the original chip as told", () => {
		const view = projectView([newUserMessage("hi") as LhMessage, quiet(), toldLater()]);
		assert.equal(view.length, 2);
		assert.deepEqual(view[1]!.parts, [{ type: "data-side-question", id: "sq_side_quiet", data: { ...details(false), toldTutor: true } }]);
	});
});

describe("continuing a closed thread", () => {
	it("hides the chip a continuation replaces, so the conversation shows once at its latest point", () => {
		const continued = newSideQuestionMarker("side_next", { thread: [{ question: "Why?", answer: "Because." }, { question: "And?", answer: "So." }], note: "both", toldTutor: false, continues: "side_quiet" }) as LhMessage;
		const view = projectView([newUserMessage("hi") as LhMessage, quiet(), newUserMessage("later") as LhMessage, continued]);
		const chips = view.flatMap((m) => m.parts.filter((p) => p.type === "data-side-question").map((p) => (p as { id: string }).id));
		assert.deepEqual(chips, ["sq_side_next"]);
	});
});
