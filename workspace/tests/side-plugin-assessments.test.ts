import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { sideChatLessonDocument, sideEntryPoints, sideSegmentId } from "../src/core/side-chat.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";
import { projectView } from "../src/core/view.ts";
import type { LhMarkerMessage, LhMessage } from "../src/core/native-messages.ts";
import type { PluginQuestionSnapshot } from "../src/core/plugin-questions.ts";
import type { PluginProblemSnapshot } from "../src/core/plugin-problems.ts";

const at = "2026-11-08T00:00:00.000Z";
const question: PluginQuestionSnapshot = {
	protocolVersion: 2, requiresGrading: true, pluginId: "fixture", typeId: "code", label: "Code", variant: "teach", questionId: "question", contractVersion: 1,
	occurrence: { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "custom_code" },
	input: { type: "check", nodeId: "node", question: "Explain the public code question.", payload: { private: "SECRET-PAYLOAD" } },
	questionSchema: Type.Object({ private: Type.String() }), answerSchema: Type.Object({ private: Type.String() }), showThinking: true, requiresAnswerRefinement: false,
};
const pose = () => ({ ...fauxAssistantMessage([fauxToolCall("custom_code", { question: question.input.question, type: "check", nodeId: "node", payload: question.input.payload }, { id: "call" })], { stopReason: "toolUse" }), id: "pose", lhQuestions: { "0": question } }) as LhMessage;
const teacher = (id: string, text: string) => ({ ...fauxAssistantMessage(text), id }) as LhMessage;
const answer = () => ({ id: "answer", role: "toolResult", toolName: "custom_code", toolCallId: "call", content: [{ type: "text", text: "SECRET-CONTENT" }], isError: false, timestamp: 0,
	lhQuestionOccurrence: question.occurrence, details: { kind: "plugin-question", questionId: question.questionId, pluginId: question.pluginId, typeId: question.typeId, contractVersion: 1,
		answer: { private: "SECRET-ANSWER" }, grading: { result: { private: "SECRET-GRADING" } }, thinking: "Public learner thinking", readingThinking: "Public reading thinking", answeredAt: at } }) as unknown as LhMessage;
const problem: PluginProblemSnapshot = {
	protocolVersion: 1, problemId: "problem", pluginId: "fixture", typeId: "code", label: "Code", contractVersion: 1,
	input: { statement: "Solve the public practice statement.", mode: "composition", modelSolution: "SECRET-SOLUTION", payload: { private: "SECRET-PROBLEM-PAYLOAD" } },
	problemSchema: Type.Object({ private: Type.String() }), submissionSchema: Type.Object({ private: Type.String() }), requiresSubmissionRefinement: false, requiresProcessing: true,
};
const problemMessages = (): LhMessage[] => [
	{ ...fauxAssistantMessage([fauxToolCall("custom_problem", { ...problem.input }, { id: "problem-call" })], { stopReason: "toolUse" }), id: "problem-pose" } as LhMessage,
	{ id: "problem-ack", role: "toolResult", toolCallId: "problem-call", toolName: "custom_problem", content: [{ type: "text", text: "SECRET-ACK" }], details: { pluginProblem: problem }, isError: false, timestamp: 0 } as unknown as LhMessage,
];
const submission = (): LhMarkerMessage => ({ id: "submission", role: "custom", customType: "plugin-problem-submission", content: "SECRET-MARKER-CONTENT", display: true, timestamp: 0,
	details: { kind: "plugin-problem-submission", problemId: problem.problemId, pluginId: problem.pluginId, typeId: problem.typeId, contractVersion: 1,
		submission: { private: "SECRET-SUBMISSION" }, thinking: "Public practice thinking", processing: { result: { private: "SECRET-PROCESSING" } }, submittedAt: at } });

function noPrivateData(document: string) { assert.doesNotMatch(document, /SECRET-|"payload"|"answer"|"submission"|"processing"|"grading"/); }

test("plugin questions create helper entries even without prose; only exact host answers/cancellations split the segment", () => {
	const messages = [pose()];
	const points = [...sideEntryPoints(messages, projectView(messages)).values()].flatMap(entries => [...entries.values()]);
	assert.deepEqual(points, ["pose"]);
	const forged = { ...answer(), lhQuestionOccurrence: { ...question.occurrence, messageId: "another-pose" } } as LhMessage;
	assert.equal(sideSegmentId([...messages, forged, teacher("after-forged", "Still this question")]), "pose");
	assert.equal(sideSegmentId([...messages, answer(), teacher("reaction", "Next step")]), "reaction");
	const cancelled = { ...answer(), details: { kind: "plugin-question-cancelled", questionId: question.questionId, occurrence: question.occurrence, reason: "dismissed" } } as LhMessage;
	assert.equal(sideSegmentId([...messages, cancelled, teacher("after-skip", "Next step")]), "after-skip");
});

test("open and answered plugin question context contains common text and Thinking, never custom answer/grading/payload JSON", () => {
	const open = sideChatLessonDocument([pose()]);
	assert.match(open, /OPEN question/); assert.match(open, /Explain the public code question/); noPrivateData(open);
	const answered = sideChatLessonDocument([pose(), answer()]);
	assert.match(answered, /answered/); assert.match(answered, /Explain the public code question/);
	assert.match(answered, /Public learner thinking/); assert.match(answered, /Public reading thinking/); noPrivateData(answered);
	const forged = { ...answer(), lhQuestionOccurrence: { ...question.occurrence, contentIndex: 2 } } as LhMessage;
	assert.doesNotMatch(sideChatLessonDocument([pose(), forged]), /Public learner thinking/);
	const unreadable = { ...pose(), lhQuestions: { "0": { ...question, protocolVersion: 99 } } } as unknown as LhMessage;
	const hidden = sideChatLessonDocument([unreadable, answer()]);
	assert.doesNotMatch(hidden, /Explain the public code question|Public learner thinking/); noPrivateData(hidden);
});

test("plugin practice keeps the statement and bound plain-text Thinking, creates boundaries, and excludes private submission/processing", () => {
	const messages = problemMessages();
	const entries = [...sideEntryPoints(messages, projectView(messages)).values()].flatMap(points => [...points.values()]);
	assert.deepEqual(entries, ["problem-pose"]);
	const document = sideChatLessonDocument([...messages, submission()]);
	assert.match(document, /OPEN problem/); assert.match(document, /Solve the public practice statement/); assert.match(document, /Public practice thinking/); noPrivateData(document);
	assert.equal(sideSegmentId([...messages, submission(), teacher("reaction", "Next attempt")]), "reaction");
	const forged = { ...submission(), details: { ...submission().details as object, problemId: "another-problem" } } as LhMessage;
	assert.doesNotMatch(sideChatLessonDocument([...messages, forged]), /Public practice thinking/);
	assert.equal(sideSegmentId([...messages, forged, teacher("same-problem", "Still working")]), "problem-pose");
});

test("compaction preserves common text for still-open plugin assessments without recovering private summaries or completed history", () => {
	const tail = teacher("retained", "Retained prose");
	const marker = newCompactionMarker("SECRET-SUMMARY", { firstKeptMessageId: tail.id, tokensBefore: 1, at });
	for (const prefix of [[pose()], problemMessages()]) {
		const document = sideChatLessonDocument([...prefix, tail, marker]);
		assert.match(document, /public code question|public practice statement/); assert.match(document, /Retained prose/); noPrivateData(document);
	}
	const completed = sideChatLessonDocument([pose(), answer(), tail, marker]);
	assert.doesNotMatch(completed, /public code question|Public learner thinking/); noPrivateData(completed);
});
