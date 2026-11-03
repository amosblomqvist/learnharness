import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { ChatInputError } from "../core/input-events.ts";
import { newMessageId, nativeAnswerContent, pendingPluginQuestionOf, pluginQuestionCallsOf, type LhMessage } from "../core/native-messages.ts";
import { validatePluginSubmissionImages, type PluginSubmissionImages } from "../core/plugin-submissions.ts";
import {
	samePluginQuestionOccurrence, validatePluginQuestionAnswer,
	type PluginQuestionAnswer, type PluginQuestionCancellation, type PluginQuestionOccurrence,
	type PluginQuestionSnapshot,
} from "../core/plugin-questions.ts";
import type { NativePluginQuestionDefinition } from "../agent/plugin-question-tools.ts";
import type { ChatStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { getPluginHost } from "./plugins.ts";

export type QuestionTypeResolution =
	| { status: "available"; definition: NativePluginQuestionDefinition; signal: AbortSignal; requireActive(): void }
	| { status: "incompatible" | "unavailable" };
export type QuestionTypeResolver = (pluginId: string, typeId: string, contractVersion: number) => QuestionTypeResolution;
export interface PluginQuestionAnswerInput {
	type: "plugin-question-answer";
	questionId: string;
	occurrence: PluginQuestionOccurrence;
	answer: unknown;
	thinking?: string;
	readingThinking?: string;
	images?: PluginSubmissionImages;
}
export interface PluginQuestionDismissInput {
	type: "dismiss-plugin-question";
	questionId?: string;
	occurrence: PluginQuestionOccurrence;
}

function nativeResult(occurrence: PluginQuestionOccurrence, details: PluginQuestionAnswer | PluginQuestionCancellation, text: string): LhMessage {
	return {
		id: newMessageId(), role: "toolResult", toolCallId: occurrence.toolCallId, toolName: occurrence.toolName,
		lhQuestionOccurrence: occurrence, details: details as unknown as ToolResultMessage["details"],
		content: nativeAnswerContent(text, details.kind === "plugin-question" ? details.images : undefined), isError: false, timestamp: Date.now(),
	} as LhMessage;
}
function requireCurrent(messages: readonly LhMessage[], input: { questionId?: string; occurrence: PluginQuestionOccurrence }): PluginQuestionSnapshot {
	const pending = pendingPluginQuestionOf(messages);
	if (!pending || input.questionId !== pending.questionId || !samePluginQuestionOccurrence(input.occurrence, pending.occurrence))
		throw new ChatInputError("This question is no longer pending. Sync the saved session before trying again.");
	return pending;
}

/** Host validation only. The caller owns the existing single write-ahead and turn claim. */
export function preparePluginQuestionAnswer(record: { id: string; messages: LhMessage[] }, input: PluginQuestionAnswerInput, resolve: QuestionTypeResolver): LhMessage[] {
	const snapshot = requireCurrent(record.messages, input);
	const resolution = resolve(snapshot.pluginId, snapshot.typeId, snapshot.contractVersion);
	if (resolution.status !== "available") throw new ChatInputError("Question unavailable");
	resolution.requireActive();
	if (resolution.signal.aborted) throw new ChatInputError("Question unavailable");
	const readingApplicable = snapshot.variant === "teach" && snapshot.input.type === "check";
	let images: PluginSubmissionImages | undefined;
	try { images = input.images === undefined ? undefined : validatePluginSubmissionImages(input.images); }
	catch (error) { throw new ChatInputError(error instanceof Error ? error.message : "Invalid submitted images"); }
	if (Object.hasOwn(input, "thinking") && (!snapshot.showThinking || typeof input.thinking !== "string"))
		throw new ChatInputError("Thinking is not applicable to this question");
	if (Object.hasOwn(input, "readingThinking") && (!readingApplicable || typeof input.readingThinking !== "string"))
		throw new ChatInputError("Reading thinking is not applicable to this question");
	if (!snapshot.showThinking && images?.thinking?.length)
		throw new ChatInputError("Thinking images are not applicable to this question");
	if (!readingApplicable && images?.readingThinking?.length)
		throw new ChatInputError("Reading thinking images are not applicable to this question");
	const answer = validatePluginQuestionAnswer(snapshot, { chatId: record.id, answer: input.answer }, resolution.definition);
	if (!answer.ok) throw new ChatInputError(answer.problems.join("\n"));
	resolution.requireActive();
	const envelope: PluginQuestionAnswer = {
		kind: "plugin-question", questionId: snapshot.questionId, pluginId: snapshot.pluginId,
		typeId: snapshot.typeId, contractVersion: snapshot.contractVersion, answer: answer.value,
		...(snapshot.showThinking ? { thinking: input.thinking ?? "" } : {}),
		...(readingApplicable ? { readingThinking: input.readingThinking ?? "" } : {}),
		...(images && Object.values(images).some(channel => channel?.length) ? { images: {
			...(images.answer?.length ? { answer: images.answer } : {}),
			...(snapshot.showThinking && images.thinking?.length ? { thinking: images.thinking } : {}),
			...(readingApplicable && images.readingThinking?.length ? { readingThinking: images.readingThinking } : {}),
		} } : {}),
		answeredAt: new Date().toISOString(),
	};
	return [nativeResult(snapshot.occurrence, envelope, JSON.stringify({ ...envelope, images: undefined }))];
}

function cancellation(occurrence: PluginQuestionOccurrence, questionId: string | undefined, reason: PluginQuestionCancellation["reason"]): LhMessage {
	const details: PluginQuestionCancellation = { kind: "plugin-question-cancelled", ...(questionId ? { questionId } : {}), occurrence, reason };
	const text = reason === "dismissed" ? "The learner dismissed this question without submitting an answer."
		: reason === "incompatible" ? "The host cancelled this question because its plugin explicitly declared the saved contract incompatible."
		: "The host cancelled this question because its saved host protocol is unreadable.";
	return nativeResult(occurrence, details, text);
}

/** Projection verifies real native occurrence and genuine bound results, never metadata alone. */
function unreadablePending(messages: readonly LhMessage[]): { occurrence: PluginQuestionOccurrence; questionId?: string; quietEligible: boolean } | undefined {
	const call = pluginQuestionCallsOf(messages).find(call => call.status === "unreadable");
	if (!call || call.annotation.status !== "unreadable") return undefined;
	const binding = call.annotation.binding;
	const questionId = binding?.questionId ?? call.annotation.identity?.questionId;
	return {
		occurrence: call.occurrence,
		...(questionId ? { questionId } : {}),
		// Explicit dismissal supplies the exact actual occurrence even when the map is malformed.
		// Quiet cancellation has no such human target: require readable saved identity as well.
		quietEligible: !!binding && samePluginQuestionOccurrence(binding.occurrence, call.occurrence),
	};
}

export function preparePluginQuestionDismissal(record: { messages: LhMessage[] }, input: PluginQuestionDismissInput): LhMessage[] {
	const pending = pendingPluginQuestionOf(record.messages);
	if (pending) {
		const snapshot = requireCurrent(record.messages, input);
		return [cancellation(snapshot.occurrence, snapshot.questionId, "dismissed")];
	}
	const unreadable = unreadablePending(record.messages);
	if (!unreadable || !samePluginQuestionOccurrence(unreadable.occurrence, input.occurrence) ||
		(input.questionId !== undefined && input.questionId !== unreadable.questionId))
		throw new ChatInputError("This question is no longer pending. Sync the saved session before trying again.");
	return [cancellation(unreadable.occurrence, unreadable.questionId, "dismissed")];
}

/** Response-only readiness. Never persisted and never grants authority independently. */
export function pluginQuestionAvailabilityOf(record: { messages: LhMessage[] }, resolve?: QuestionTypeResolver): { questionId: string; status: "available" | "unavailable" } | undefined {
	const pending = pendingPluginQuestionOf(record.messages);
	if (!pending) return undefined;
	let available = false;
	try {
		const current = resolve?.(pending.pluginId, pending.typeId, pending.contractVersion);
		if (current?.status === "available" && !current.signal.aborted && (!pending.requiresAnswerRefinement || typeof current.definition.validateAnswer === "function")) {
			current.requireActive();
			available = true;
		}
	} catch { /* unavailable remains a readable pending question */ }
	return { questionId: pending.questionId, status: available ? "available" : "unavailable" };
}

export function pluginQuestionCompatibilityAppends(record: { messages: LhMessage[] }, resolve: QuestionTypeResolver): LhMessage[] {
	const pending = pendingPluginQuestionOf(record.messages);
	if (pending) {
		const resolution = resolve(pending.pluginId, pending.typeId, pending.contractVersion);
		return resolution.status === "incompatible" ? [cancellation(pending.occurrence, pending.questionId, "incompatible")] : [];
	}
	const unreadable = unreadablePending(record.messages);
	return unreadable?.quietEligible ? [cancellation(unreadable.occurrence, unreadable.questionId, "unreadable-protocol")] : [];
}

/** Re-read after startup awaits; never write over an active native turn. No migration or wake. */
export async function reconcilePluginQuestionCompatibility(chatStore: ChatStore, chatId: string): Promise<void> {
	if (isTurnRunning(chatId)) return;
	const initial = chatStore.getChat(chatId);
	if (!initial || (!pendingPluginQuestionOf(initial.messages) && !unreadablePending(initial.messages))) return;
	let host: Awaited<ReturnType<typeof getPluginHost>>;
	try { host = await getPluginHost(); } catch { return; } // unavailable keeps the saved question pending
	if (isTurnRunning(chatId)) return;
	const record = chatStore.getChat(chatId);
	if (!record) return;
	const appends = pluginQuestionCompatibilityAppends(record, (pluginId, typeId, version) => host.resolveQuestionType(pluginId, typeId, version));
	if (!appends.length) return;
	chatStore.saveMessages(chatId, [...record.messages, ...appends]);
	emit("record-changed", { chatId });
}
