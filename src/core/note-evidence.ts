import { failedOutputCallIds, userFacingTextOf, type LhMessage } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import type { ChatKind } from "./contracts/chat.ts";
import type { NotePassage } from "./session-notes.ts";

function answerEvidence(details: unknown): string {
	const answer = details as Partial<QuestionAnswerData> | undefined;
	if (!answer || answer.dismissed) return "";
	const correctLabels =
		answer.options?.filter(option => answer.correctIndices?.includes(option.index)).map(o => o.label) ?? [];
	const explanation = [answer.committed, answer.explanation, ...correctLabels].filter(
		t => typeof t === "string" && t.trim(),
	);
	return explanation.length ? [answer.questionText, ...explanation].filter(Boolean).join("\n") : "";
}

interface PosedProblem {
	id: string;
	statement: NotePassage;
	solution: string;
	discussion: NotePassage[];
}
function practiceEvidence(messages: readonly LhMessage[], failed: ReadonlySet<string>) {
	const completed: NotePassage[] = [];
	const accepted = new Set(messages.flatMap(m => (m.role === "toolResult" && !m.isError ? [m.toolCallId] : [])));
	let problem: PosedProblem | undefined;
	let lastCompleted: string | undefined;

	for (const m of messages) {
		if (m.role === "custom" && m.customType === "problem-dismissed") {
			problem = undefined;
			lastCompleted = undefined;
		}
		if (problem && m.role === "custom" && m.customType === "practice-thinking") {
			const thinking = m.details as { problemCallId?: string; text?: string } | null;
			if (thinking?.problemCallId === problem.id && thinking.text) {
				problem.discussion.push({ messageId: m.id, topic: problem.id, text: "Learner attempt: " + thinking.text });
			}
		}
		if (problem && m.role === "user") {
			const text = userFacingTextOf(m.content).join("\n");
			if (text) problem.discussion.push({ messageId: m.id, topic: problem.id, text: "Learner attempt: " + text });
		}
		if (m.role !== "assistant") continue;
		const prose = userFacingTextOf(m.content, failed).join("\n");
		const calls = m.content.filter(part => part.type === "toolCall" && accepted.has(part.id));
		const pose = calls.find(call => call.type === "toolCall" && call.name === "problem");
		if (pose?.type === "toolCall") {
			const { statement, modelSolution, target } = pose.arguments;
			const graphNodeIds = Array.isArray(target) ? target.filter((t): t is string => typeof t === "string") : [];
			problem = {
				id: pose.id,
				solution: typeof modelSolution === "string" ? modelSolution : "",
				discussion: [],
				statement: {
					messageId: m.id,
					topic: pose.id,
					text: [prose, statement].filter(Boolean).join("\n"),
					...(graphNodeIds.length ? { graphNodeIds } : {}),
				},
			};
			lastCompleted = undefined;
		}
		const end = calls.find(call => call.type === "toolCall" && call.name === "conclude");
		if (problem && end?.type === "toolCall") {
			if (end.arguments.outcome !== "dismissed") {
				lastCompleted = problem.id;
				if (problem.statement.text) completed.push(problem.statement);
				completed.push(...problem.discussion);
				const text = [prose, problem.solution, end.arguments.verdict].filter(Boolean).join("\n");
				if (text) completed.push({ messageId: m.id, topic: problem.id, text });
			}
			problem = undefined;
		} else if (!pose && prose) {
			if (problem) problem.discussion.push({ messageId: m.id, topic: problem.id, text: prose });
			else if (lastCompleted) completed.push({ messageId: m.id, topic: lastCompleted, text: prose });
		}
	}
	return { all: completed, closed: completed };
}

/** Live consumes closed spans. Final also sees the current, partially taught topic. */
export function noteEvidence(
	messages: readonly LhMessage[],
	kind: ChatKind = "teach",
): { all: NotePassage[]; closed: NotePassage[] } {
	const failed = failedOutputCallIds(messages);
	if (kind === "practice") return practiceEvidence(messages, failed);

	const structured = messages.some(
		m =>
			m.role === "assistant" &&
			m.content.some(
				p =>
					p.type === "toolCall" && ["probe", "recall", "probe_done", "plan_init", "quiz", "explain"].includes(p.name),
			),
	);
	const refused = new Set(messages.flatMap(m => (m.role === "toolResult" && m.isError ? [m.toolCallId] : [])));
	const passages: { span: number; passage: NotePassage }[] = [];
	const checks = new Map<string, { topic: string; span: number }>();
	let current = { topic: structured ? "" : "lesson", span: 0 };
	let awaitingFirstCheck = false;
	let introduction: { messageId: string; text: string }[] = [];
	const toolProse: { messageId: string; text: string }[] = [];
	function append(messageId: string, text: string, at = current) {
		if (at.topic && text.trim()) passages.push({ span: at.span, passage: { messageId, topic: at.topic, text } });
	}
	function flushToolProse(at = current) {
		for (const p of toolProse) append(p.messageId, p.text, at);
		toolProse.length = 0;
	}

	for (const m of messages) {
		if (m.role === "user") {
			flushToolProse();
			if (awaitingFirstCheck) introduction = [];
			const text = userFacingTextOf(m.content).join("\n");
			if (passages.length && text) append(m.id, "Learner contribution: " + text);
		}
		if (m.role === "toolResult" && !m.isError) {
			if (m.toolName === "plan_init") awaitingFirstCheck = !current.topic;
			const at = checks.get(m.toolCallId);
			if (at) {
				flushToolProse();
				append(m.id, answerEvidence(m.details), at);
			}
		}
		if (m.role !== "assistant") continue;
		let firstCheck: typeof current | undefined;
		for (const part of m.content) {
			if (part.type !== "toolCall" || refused.has(part.id) || (part.name !== "quiz" && part.name !== "explain"))
				continue;
			const topic = part.arguments.nodeId;
			if (typeof topic !== "string" || !topic.trim()) continue;
			if (topic !== current.topic) current = { topic, span: current.span + 1 };
			firstCheck ??= current;
			checks.set(part.id, current);
			if (awaitingFirstCheck) {
				for (const p of introduction) append(p.messageId, p.text);
				introduction = [];
				awaitingFirstCheck = false;
			}
		}
		const text = userFacingTextOf(m.content, failed).join("\n");
		if (awaitingFirstCheck && text.trim()) introduction.push({ messageId: m.id, text });
		else if (
			!firstCheck &&
			current.topic &&
			m.stopReason === "toolUse" &&
			m.content.some(p => p.type === "toolCall" && p.name === "send_to_user")
		) {
			// Explicit-output providers can send the explanation in a separate step of the same turn before tagging its check.
			if (text) toolProse.push({ messageId: m.id, text });
		} else {
			if (firstCheck || text) flushToolProse(firstCheck);
			append(m.id, text, firstCheck);
		}
	}
	flushToolProse();
	return {
		all: passages.map(p => p.passage),
		closed: passages.filter(p => p.span < current.span).map(p => p.passage),
	};
}
