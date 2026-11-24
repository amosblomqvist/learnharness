import type { Agent, AgentEvent, AgentMessage, AgentTool, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import {
	createPluginQuestionParameters, validatePluginQuestionInput, freezePluginQuestionValue,
	type PluginQuestionTypeDefinition, type PluginQuestionVariant, type PluginQuestionAttempt,
	type PluginQuestionSnapshot, type PluginQuestionInput, type PluginQuestionValidationContext, type PluginQuestionAnswerValidationContext,
	type PluginQuestionGradingContext, type JsonValue,
} from "../core/plugin-questions.ts";
import { newMessageId } from "../core/native-messages.ts";
import { invalidInputResult, questionResult } from "./tool-execute.ts";

/** Heterogeneous host registry: schemas are validated dynamically before these callbacks run.
 * TypeBox's Static<any> is unknown, so erase the callback payload explicitly, not the public SDK generic. */
export type NativePluginQuestionDefinition = Omit<PluginQuestionTypeDefinition, "validateQuestion" | "validateAnswer" | "gradeAnswer"> & {
	validateQuestion?: (context: PluginQuestionValidationContext<any>) => undefined | string[];
	validateAnswer?: (context: PluginQuestionAnswerValidationContext<any, any>) => undefined | string[];
	gradeAnswer?: (context: PluginQuestionGradingContext<any, any>) => JsonValue | Promise<JsonValue>;
};

/** The accepted, single-invocation contribution snapshot; never reconstruct it. */
export interface NativePluginQuestionContribution {
	pluginId: string;
	definition: NativePluginQuestionDefinition;
	variant: PluginQuestionVariant;
	signal: AbortSignal;
	requireActive(): void;
}
interface Pose {
	questionId: string;
	input: PluginQuestionInput;
	contribution: NativePluginQuestionContribution;
}
interface Epoch { poses: Map<number, Pose>; message?: AgentMessage }
const ledgers = new WeakMap<Agent, PluginQuestionLedger>();
export function pluginQuestionLedgerFor(agent: Agent): PluginQuestionLedger | undefined { return ledgers.get(agent); }

/** Private per-Agent proof of actual native execution, not a model-authored token. */
export class PluginQuestionLedger {
	private readonly definitions = new Map<string, NativePluginQuestionContribution>();
	private readonly epochs = new WeakMap<object, Epoch>();
	private readonly acknowledgments = new WeakSet<object>();
	private readonly validatedCalls = new WeakMap<object, { epoch: Epoch; index: number; toolCallId: string; toolName: string }>();
	private current?: Epoch;
	readonly tools: AgentTool<any>[];

	constructor(contributions: readonly NativePluginQuestionContribution[], private readonly chatId: string,
		private readonly nodeExists?: (nodeId: string) => boolean) {
		this.tools = contributions.map(contribution => {
			const { definition, variant } = contribution;
			const spec = definition[variant]!;
			this.definitions.set(spec.toolName, contribution);
			return {
				name: spec.toolName, label: definition.label, description: spec.description,
				parameters: createPluginQuestionParameters(definition, variant), executionMode: "sequential" as const,
				execute: async (toolCallId: string, input: unknown, signal?: AbortSignal) => {
					contribution.requireActive();
					if (signal?.aborted || contribution.signal.aborted) throw new Error("Operation aborted");
					const call = input && typeof input === "object" ? this.validatedCalls.get(input) : undefined;
					if (!call || call.toolName !== spec.toolName || call.toolCallId !== toolCallId) throw new Error("Question call occurrence unavailable");
					this.validatedCalls.delete(input as object);
					const accepted = validatePluginQuestionInput(definition, { chatId: this.chatId, variant, input });
					if (!accepted.ok) return invalidInputResult(spec.toolName, accepted.problems);
					if (variant === "teach" && (!accepted.value.nodeId || !this.nodeExists?.(accepted.value.nodeId)))
						return invalidInputResult(spec.toolName, ["nodeId must identify a live node in this session's plan map."]);
					contribution.requireActive();
					call.epoch.poses.set(call.index, { questionId: crypto.randomUUID(), input: accepted.value, contribution });
					const ack = { ...questionResult(), details: {} };
					this.acknowledgments.add(ack.details);
					return ack;
				},
			};
		});
	}

	/** SDK-provided raw call OBJECT and validated args identity bind execution to its exact content position. */
	validatedCall(context: BeforeToolCallContext): void {
		if (!this.definitions.has(context.toolCall.name)) return;
		const epoch = this.epochs.get(context.assistantMessage);
		const index = context.assistantMessage.content.indexOf(context.toolCall);
		if (!epoch || index < 0 || !context.args || typeof context.args !== "object") throw new Error("Question call occurrence unavailable");
		this.validatedCalls.set(context.args, { epoch, index, toolCallId: context.toolCall.id, toolName: context.toolCall.name });
	}

	bind(agent: Agent): void {
		ledgers.set(agent, this);
		agent.subscribe(event => {
			if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return;
			if (event.message.role !== "assistant") return;
			if (event.type === "message_start") this.current = { poses: new Map() };
			const epoch: Epoch = this.epochs.get(event.message) ?? this.current ?? { poses: new Map() };
			this.current = epoch;
			epoch.message = event.message;
			this.epochs.set(event.message, epoch);
		});
	}

	isAcknowledgment(value: unknown): boolean {
		if (!value || typeof value !== "object") return false;
		const result = value as { isError?: boolean; details?: unknown };
		return !result.isError && !!result.details && typeof result.details === "object" && this.acknowledgments.has(result.details);
	}

	private decorate(source: AgentMessage, mapped: AgentMessage, canonical: boolean): AgentMessage {
		if (mapped.role !== "assistant") return mapped;
		const annotations: Record<string, PluginQuestionAttempt | PluginQuestionSnapshot> = {};
		const epoch = this.epochs.get(source);
		if (!epoch) return mapped; // historical records are never reclassified by current tool names
		const id = canonical ? (mapped as AgentMessage & { id?: string }).id ?? newMessageId() : undefined;
		mapped.content.forEach((call, index) => {
			if (call.type !== "toolCall") return;
			const contribution = this.definitions.get(call.name);
			if (!contribution) return;
			const { definition, pluginId, variant } = contribution;
			const attempt: PluginQuestionAttempt = { ...(definition.gradeAnswer ? { protocolVersion: 2 as const, requiresGrading: true as const } : { protocolVersion: 1 as const }), pluginId, typeId: definition.id, label: definition.label, variant };
			const pose = canonical ? epoch?.poses.get(index) : undefined;
			annotations[String(index)] = freezePluginQuestionValue(pose ? {
				...attempt, questionId: pose.questionId,
				occurrence: { messageId: id!, contentIndex: index, toolCallId: call.id, toolName: call.name },
				contractVersion: definition.contractVersion, input: pose.input,
				questionSchema: definition.questionSchema, answerSchema: definition.answerSchema,
				showThinking: definition.showThinking, requiresAnswerRefinement: !!definition.validateAnswer,
			} : attempt);
		});
		if (!Object.keys(annotations).length) return mapped;
		return { ...mapped, ...(id ? { id } : {}), lhQuestions: Object.freeze(annotations) } as AgentMessage;
	}

	/** Called only AFTER admission and the uniquifier saw the original SDK event. */
	wire(original: AgentEvent, mapped: AgentEvent): AgentEvent | undefined {
		if (original.type === "tool_execution_end" && this.isAcknowledgment(original.result)) return undefined;
		if (original.type === "message_start" || original.type === "message_update" || original.type === "message_end") {
			if (this.isAcknowledgment(original.message)) return undefined;
			const e = mapped as typeof original;
			return { ...e, message: this.decorate(original.message, e.message, false) } as AgentEvent;
		}
		if (original.type === "turn_end" && mapped.type === "turn_end") return {
			...mapped, message: this.decorate(original.message, mapped.message, false),
			toolResults: mapped.toolResults.filter((_, index) => !this.isAcknowledgment(original.toolResults[index])),
		};
		if (original.type === "agent_end" && mapped.type === "agent_end") return {
			...mapped, messages: mapped.messages.flatMap((message, index) => this.isAcknowledgment(original.messages[index]) ? [] : [this.decorate(original.messages[index]!, message, false)]),
		};
		return mapped;
	}

	settled(original: readonly AgentMessage[], mapped: readonly AgentMessage[]): AgentMessage[] {
		return mapped.flatMap((message, index) => this.isAcknowledgment(original[index]) ? [] : [this.decorate(original[index]!, message, true)]);
	}
}
