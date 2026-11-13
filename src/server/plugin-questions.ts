import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { ChatInputError } from "../core/input-events.ts";
import { newMessageId, nativeAnswerContent, pendingPluginQuestionOf, pluginQuestionCallsOf, type LhMessage } from "../core/native-messages.ts";
import { validatePluginSubmissionImages, type PluginSubmissionImages } from "../core/plugin-submissions.ts";
import {
	samePluginQuestionOccurrence, validatePluginQuestionAnswer, clonePluginQuestionJson, freezePluginQuestionValue,
	type PluginQuestionAnswer, type PluginQuestionCancellation, type PluginQuestionOccurrence,
	type PluginQuestionSnapshot, type PluginQuestionGradingOutcome,
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

function requiresGrading(snapshot: PluginQuestionSnapshot): boolean {
	return snapshot.protocolVersion === 2 && snapshot.requiresGrading === true;
}
function hasRequiredGrader(snapshot: PluginQuestionSnapshot, definition: NativePluginQuestionDefinition): boolean {
	return !requiresGrading(snapshot) || (definition.id === snapshot.typeId && definition.contractVersion === snapshot.contractVersion && typeof definition.gradeAnswer === "function");
}
function gradingOutcome(value: unknown): PluginQuestionGradingOutcome {
	let copy;
	try { copy = clonePluginQuestionJson(value); }
	catch { throw new ChatInputError("Invalid question grading outcome"); }
	if (!copy || typeof copy !== "object" || Array.isArray(copy) || Object.keys(copy).length !== 1 ||
		!(Object.hasOwn(copy, "result") || (Object.hasOwn(copy, "error") && typeof copy.error === "string")))
		throw new ChatInputError("Invalid question grading outcome");
	return freezePluginQuestionValue(copy) as PluginQuestionGradingOutcome;
}
function gradingError(error: unknown): string {
	// A plugin may throw any value, including an object with a throwing message getter.
	try { if (error instanceof Error && typeof error.message === "string") return error.message; } catch { /* safe generic below */ }
	return "An error occurred.";
}

export interface PreparedPluginQuestionSubmission {
	snapshot: PluginQuestionSnapshot;
	signal: AbortSignal;
	grade?: (signal: AbortSignal) => Promise<PluginQuestionGradingOutcome>;
	finish(record: { id: string; messages: LhMessage[] }, grading?: PluginQuestionGradingOutcome): LhMessage[];
}

/** Synchronous validation/capture only. The caller owns session exclusion and the single write-ahead. */
export function preparePluginQuestionSubmission(record: { id: string; messages: LhMessage[] }, input: PluginQuestionAnswerInput, resolve: QuestionTypeResolver): PreparedPluginQuestionSubmission {
	const snapshot = requireCurrent(record.messages, input);
	const savedContract = JSON.stringify(snapshot), chatId = record.id;
	const resolution = resolve(snapshot.pluginId, snapshot.typeId, snapshot.contractVersion);
	if (resolution.status !== "available" || !hasRequiredGrader(snapshot, resolution.definition)) throw new ChatInputError("Question unavailable");
	const { signal: activationSignal, requireActive } = resolution;
	const gradeAnswer = resolution.definition.gradeAnswer;
	const requireAuthority = (signal?: AbortSignal) => {
		// This exact captured closure proves activation AND registration identity, even after re-registration.
		try { requireActive.call(resolution); }
		catch { throw new ChatInputError("Question unavailable"); }
		if (activationSignal.aborted || signal?.aborted) throw new ChatInputError("Question unavailable");
	};
	requireAuthority();
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
	requireAuthority();
	const accepted: Omit<PluginQuestionAnswer, "answeredAt" | "grading"> = {
		kind: "plugin-question", questionId: snapshot.questionId, pluginId: snapshot.pluginId,
		typeId: snapshot.typeId, contractVersion: snapshot.contractVersion, answer: answer.value,
		...(snapshot.showThinking ? { thinking: input.thinking ?? "" } : {}),
		...(readingApplicable ? { readingThinking: input.readingThinking ?? "" } : {}),
		...(images && Object.values(images).some(channel => channel?.length) ? { images: {
			...(images.answer?.length ? { answer: images.answer } : {}),
			...(snapshot.showThinking && images.thinking?.length ? { thinking: images.thinking } : {}),
			...(readingApplicable && images.readingThinking?.length ? { readingThinking: images.readingThinking } : {}),
		} } : {}),
	};
	let gradingSignal: AbortSignal | undefined;
	let gradingSettled = false;
	return {
		snapshot, signal: activationSignal,
		...(requiresGrading(snapshot) ? { grade: async (signal: AbortSignal): Promise<PluginQuestionGradingOutcome> => {
			const combined = AbortSignal.any([signal, activationSignal]);
			gradingSignal = combined;
			gradingSettled = false;
			requireAuthority(combined);
			let outcome: PluginQuestionGradingOutcome;
			try {
				// Freeze only our owned JSON. Deep freezing this context would freeze a LIVE AbortSignal.
				const context = Object.freeze({ chatId, questionId: snapshot.questionId, variant: snapshot.variant,
					contractVersion: snapshot.contractVersion, input: snapshot.input, answer: answer.value, signal: combined });
				// Do not race cancellation: ownership must remain held until the underlying callback settles.
				const result = await gradeAnswer!(context);
				requireAuthority(combined);
				outcome = { result: freezePluginQuestionValue(clonePluginQuestionJson(result)) };
			} catch (error) {
				// Only our signal/authority determines cancellation, never a callback error's name.
				requireAuthority(combined);
				outcome = { error: gradingError(error) };
			}
			requireAuthority(combined);
			gradingSettled = true;
			return Object.freeze(outcome);
		} } : {}),
		finish(current, grading) {
			requireAuthority(gradingSignal);
			const pending = requireCurrent(current.messages, snapshot);
			if (current.id !== chatId || JSON.stringify(pending) !== savedContract)
				throw new ChatInputError("This question changed. Sync the saved session before trying again.");
			if (requiresGrading(snapshot) && !gradingSettled) throw new ChatInputError("Question grading has not completed");
			const outcome = requiresGrading(snapshot) ? gradingOutcome(grading) : undefined;
			const envelope: PluginQuestionAnswer = { ...accepted,
				...(outcome ? { grading: outcome } : {}), answeredAt: new Date().toISOString() };
			return [nativeResult(snapshot.occurrence, envelope, JSON.stringify({ ...envelope, images: undefined }))];
		},
	};
}

/** Historical synchronous callers can only submit saved ungraded questions. */
export function preparePluginQuestionAnswer(record: { id: string; messages: LhMessage[] }, input: PluginQuestionAnswerInput, resolve: QuestionTypeResolver): LhMessage[] {
	const prepared = preparePluginQuestionSubmission(record, input, resolve);
	if (prepared.grade) throw new ChatInputError("This question requires grading before acceptance");
	return prepared.finish(record);
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
		if (current?.status === "available" && !current.signal.aborted && (!pending.requiresAnswerRefinement || typeof current.definition.validateAnswer === "function") && hasRequiredGrader(pending, current.definition)) {
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
