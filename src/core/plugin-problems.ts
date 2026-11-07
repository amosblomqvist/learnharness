/** Plugin-defined practice problems share the native problem/conclude lifecycle. */
import type { Static, TSchema } from "typebox";
import type { PluginCleanup } from "./plugins.ts";
import type { LhMessage } from "./native-messages.ts";
import { preparePluginProblemSubmissionImages, type PluginProblemSubmissionImages } from "./plugin-submissions.ts";
import {
  clonePluginQuestionJson, freezePluginQuestionValue, preparePluginQuestionType, preparePluginQuestionSchema, createPluginQuestionParameters,
  type JsonValue, type PluginQuestionEditorKey, type PluginQuestionOccurrence, type PluginQuestionValidationResult,
} from "./plugin-questions.ts";
import { validatePluginSchema } from "./plugin-validation.ts";
import { practiceProblemInputSchema } from "./practice-problems.ts";

export interface PluginProblemInput<Q = JsonValue> {
  statement: string;
  mode: "recall" | "discrimination" | "composition";
  target?: string[];
  modelSolution: string;
  payload: Q;
}
export interface PluginProblemValidationContext<Q = JsonValue> {
  readonly chatId: string;
  readonly contractVersion: number;
  readonly input: PluginProblemInput<Q>;
}
export interface PluginProblemSubmissionValidationContext<Q = JsonValue, S = JsonValue> extends PluginProblemValidationContext<Q> {
  readonly problemId: string;
  readonly submission: S;
}
export interface PluginProblemProcessingContext<Q = JsonValue, S = JsonValue> extends PluginProblemSubmissionValidationContext<Q, S> {
  readonly thinking: string;
  readonly images?: PluginProblemSubmissionImages;
  readonly signal: AbortSignal;
}
/** Per-submission observations, never the model's final problem assessment. */
export type PluginProblemProcessingOutcome = { result: JsonValue } | { error: string };
export interface PluginProblemTypeDefinition<Q extends TSchema = TSchema, S extends TSchema = TSchema> {
  id: string;
  label: string;
  contractVersion: number;
  incompatibleContractVersions?: number[];
  tool: { toolName: string; description: string };
  problemSchema: Q;
  submissionSchema: S;
  validateProblem?: (context: PluginProblemValidationContext<Static<Q>>) => undefined | string[];
  validateSubmission?: (context: PluginProblemSubmissionValidationContext<Static<Q>, Static<S>>) => undefined | string[];
  processSubmission?: (context: PluginProblemProcessingContext<Static<Q>, Static<S>>) => JsonValue | Promise<JsonValue>;
}
export type PluginProblemSubmissionState = { status: "empty" } | { status: "unready" | "ready"; value: JsonValue };
export interface PluginProblemMountContext<Q = JsonValue> extends PluginProblemValidationContext<Q> {
  readonly problemId: string;
  readonly signal: AbortSignal;
}
export interface PluginProblemEditorProps<Q = JsonValue> extends PluginProblemMountContext<Q> {
  readonly active: boolean;
  readonly submission: PluginProblemSubmissionState;
  onChange(submission: PluginProblemSubmissionState): void;
}
export interface PluginProblemEditorHandle {
  update(props: { submission: PluginProblemSubmissionState; active: boolean }): void;
  focus(): void;
  handleKeyDown?(key: PluginQuestionEditorKey): "handled" | "pass";
  appendTranscript?(text: string): void | Promise<void>;
  dispose(): void;
}
export interface PluginProblemRenderer<Q = JsonValue, S = JsonValue> {
  id: string;
  supportedContractVersions: number[];
  mountSubmissionEditor(container: HTMLElement, context: PluginProblemEditorProps<Q>): PluginProblemEditorHandle | Promise<PluginProblemEditorHandle>;
  mountSubmitted?(container: HTMLElement, context: PluginProblemMountContext<Q> & {
    readonly submission: S;
    readonly processing?: PluginProblemProcessingOutcome;
    readonly headerContainer?: HTMLElement;
    /** Generation-owned block after host submission images/thinking. */
    readonly footerContainer?: HTMLElement;
  }): void | PluginCleanup | Promise<void | PluginCleanup>;
}
/** The host persists this in the genuine pose acknowledgment, never model arguments. */
export interface PluginProblemSnapshot {
  protocolVersion: 1;
  problemId: string;
  pluginId: string;
  typeId: string;
  label: string;
  contractVersion: number;
  input: PluginProblemInput;
  problemSchema: TSchema;
  submissionSchema: TSchema;
  requiresSubmissionRefinement: boolean;
  requiresProcessing: boolean;
}
export interface PluginProblemSubmission {
  kind: "plugin-problem-submission";
  problemId: string;
  pluginId: string;
  typeId: string;
  contractVersion: number;
  submission: JsonValue;
  thinking: string;
  images?: PluginProblemSubmissionImages;
  processing?: PluginProblemProcessingOutcome;
  submittedAt: string;
}

/** Internal heterogeneous registry; public registration remains schema-generic. */
export type NativePluginProblemDefinition = Omit<PluginProblemTypeDefinition, "validateProblem" | "validateSubmission" | "processSubmission"> & {
  validateProblem?: (context: PluginProblemValidationContext<any>) => undefined | string[];
  validateSubmission?: (context: PluginProblemSubmissionValidationContext<any, any>) => undefined | string[];
  processSubmission?: (context: PluginProblemProcessingContext<any, any>) => JsonValue | Promise<JsonValue>;
};
function questionAdapter(definition: PluginProblemTypeDefinition) {
  return { id: definition.id, label: definition.label, contractVersion: definition.contractVersion,
    incompatibleContractVersions: definition.incompatibleContractVersions, showThinking: true,
    probe: definition.tool, questionSchema: definition.problemSchema, answerSchema: definition.submissionSchema,
    validateQuestion: definition.validateProblem as never, validateAnswer: definition.validateSubmission as never,
    gradeAnswer: definition.processSubmission as never };
}
export function preparePluginProblemType<Q extends TSchema, S extends TSchema>(definition: PluginProblemTypeDefinition<Q, S>): PluginProblemTypeDefinition<Q, S> {
  const prepared = preparePluginQuestionType(questionAdapter(definition));
  return freezePluginQuestionValue({ id: prepared.id, label: prepared.label, contractVersion: prepared.contractVersion,
    ...(prepared.incompatibleContractVersions ? { incompatibleContractVersions: prepared.incompatibleContractVersions } : {}),
    tool: prepared.probe!, problemSchema: prepared.questionSchema as Q, submissionSchema: prepared.answerSchema as S,
    ...(definition.validateProblem ? { validateProblem: definition.validateProblem } : {}),
    ...(definition.validateSubmission ? { validateSubmission: definition.validateSubmission } : {}),
    ...(definition.processSubmission ? { processSubmission: definition.processSubmission } : {}) });
}
export function createPluginProblemParameters(definition: PluginProblemTypeDefinition): TSchema {
  // Reuse the existing JSON-schema admission and local-reference rebasing.
  const base = createPluginQuestionParameters(questionAdapter(definition), "probe") as TSchema & { properties: Record<string, TSchema> };
  const common = preparePluginQuestionSchema(practiceProblemInputSchema) as TSchema & { properties: Record<string, TSchema>; required: string[] };
  return freezePluginQuestionValue({ ...common, additionalProperties: false,
    properties: { ...common.properties, payload: base.properties.payload }, required: [...common.required, "payload"] }) as TSchema;
}
function refinement(callback: ((context: never) => unknown) | undefined, context: unknown): string[] {
  if (!callback) return [];
  try {
    const result = callback(freezePluginQuestionValue(context) as never);
    if (result === undefined) return [];
    if (result && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => {});
      return ["Problem validation must be synchronous."];
    }
    return Array.isArray(result) && result.every(item => typeof item === "string" && item.trim()) ? result : ["Problem validation must return readable problems or undefined."];
  } catch { return ["Problem validation failed."]; }
}
const failed = <T>(message: string): PluginQuestionValidationResult<T> => ({ ok: false, problems: [message] });
export function validatePluginProblemInput(definition: PluginProblemTypeDefinition, context: { chatId: string; input: unknown }): PluginQuestionValidationResult<PluginProblemInput> {
  try {
    const input = freezePluginQuestionValue(clonePluginQuestionJson(context.input)) as unknown as PluginProblemInput;
    if (!validatePluginSchema(createPluginProblemParameters(definition)).Check(input)) return failed("Problem does not satisfy its input contract.");
    const errors = refinement(definition.validateProblem as never, { chatId: context.chatId, contractVersion: definition.contractVersion, input });
    return errors.length ? { ok: false, problems: errors } : { ok: true, value: input };
  } catch { return failed("Problem must be finite JSON satisfying its input contract."); }
}
export function readPluginProblemSnapshot(value: unknown): PluginProblemSnapshot | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const fields: Record<string, unknown> = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return null;
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) return null;
      Object.defineProperty(fields, key, { enumerable: true, value: key === "problemSchema" || key === "submissionSchema"
        ? preparePluginQuestionSchema(descriptor.value) : descriptor.value });
    }
    const copy = clonePluginQuestionJson(fields) as unknown as PluginProblemSnapshot;
    if (!copy || copy.protocolVersion !== 1 || typeof copy.problemId !== "string" || !copy.problemId.trim() ||
      typeof copy.pluginId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(copy.pluginId) ||
      typeof copy.requiresSubmissionRefinement !== "boolean" || typeof copy.requiresProcessing !== "boolean") return null;
    const definition = preparePluginProblemType({ id: copy.typeId, label: copy.label, contractVersion: copy.contractVersion,
      tool: { toolName: "saved_problem", description: "Saved problem" }, problemSchema: copy.problemSchema, submissionSchema: copy.submissionSchema });
    const accepted = validatePluginProblemInput(definition, { chatId: "", input: copy.input });
    if (!accepted.ok) return null;
    return freezePluginQuestionValue({ protocolVersion: 1, problemId: copy.problemId, pluginId: copy.pluginId,
      typeId: definition.id, label: definition.label, contractVersion: definition.contractVersion, input: accepted.value,
      problemSchema: definition.problemSchema, submissionSchema: definition.submissionSchema,
      requiresSubmissionRefinement: copy.requiresSubmissionRefinement, requiresProcessing: copy.requiresProcessing });
  } catch { return null; }
}
export function validatePluginProblemSubmission(snapshot: PluginProblemSnapshot, context: { chatId: string; submission: unknown }, definition?: PluginProblemTypeDefinition): PluginQuestionValidationResult<JsonValue> {
  try {
    const saved = readPluginProblemSnapshot(snapshot);
    if (!saved) return failed("Problem contract is unreadable.");
    const submission = freezePluginQuestionValue(clonePluginQuestionJson(context.submission));
    if (!validatePluginSchema(saved.submissionSchema).Check(submission)) return failed("Submission does not satisfy the saved problem contract.");
    if (saved.requiresSubmissionRefinement && (!definition || definition.id !== saved.typeId || definition.contractVersion !== saved.contractVersion || !definition.validateSubmission)) return failed("Required submission validation is unavailable.");
    const errors = saved.requiresSubmissionRefinement ? refinement(definition!.validateSubmission as never,
      { chatId: context.chatId, problemId: saved.problemId, contractVersion: saved.contractVersion, input: saved.input, submission }) : [];
    return errors.length ? { ok: false, problems: errors } : { ok: true, value: submission };
  } catch { return failed("Submission must be finite JSON satisfying its saved problem contract."); }
}

export function readPluginProblemSubmission(value: unknown): PluginProblemSubmission | null {
  try {
    const copy = clonePluginQuestionJson(value) as unknown as PluginProblemSubmission;
    if (!copy || copy.kind !== "plugin-problem-submission" || typeof copy.problemId !== "string" || !copy.problemId ||
      typeof copy.pluginId !== "string" || typeof copy.typeId !== "string" || !Number.isSafeInteger(copy.contractVersion) || copy.contractVersion < 1 ||
      !Object.hasOwn(copy, "submission") || typeof copy.thinking !== "string" || typeof copy.submittedAt !== "string") return null;
    if (copy.images !== undefined) copy.images = preparePluginProblemSubmissionImages(copy.images);
    if (copy.processing !== undefined) {
      const outcome = copy.processing;
      if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) || Object.keys(outcome).length !== 1 ||
        !(Object.hasOwn(outcome, "result") || (Object.hasOwn(outcome, "error") && typeof (outcome as { error: unknown }).error === "string"))) return null;
    }
    return freezePluginQuestionValue(copy);
  } catch { return null; }
}

export function pluginProblemById(messages: readonly LhMessage[], problemId: string): PluginProblemSnapshot | null {
  for (const message of messages) if (message.role === "assistant") for (const [contentIndex, call] of message.content.entries()) {
    if (call.type !== "toolCall") continue;
    const snapshot = pluginProblemForCall(messages, { messageId: message.id, contentIndex, toolCallId: call.id, toolName: call.name });
    if (snapshot?.problemId === problemId) return snapshot;
  }
  return null;
}

/** Associate only the actual result batch belonging to this physical call occurrence.
 * Pose ACKs persist in practice, so no second annotation/stream-ledger protocol is needed.
 */
export function pluginProblemForCall(messages: readonly LhMessage[], occurrence: PluginQuestionOccurrence): PluginProblemSnapshot | null {
  const mi = messages.findIndex(message => message.id === occurrence.messageId && message.role === "assistant");
  if (mi < 0) return null;
  const owner = messages[mi] as { content: { type: string; id?: string; name?: string }[] };
  const call = owner.content[occurrence.contentIndex];
  if (call?.type !== "toolCall" || call.id !== occurrence.toolCallId || call.name !== occurrence.toolName) return null;
  for (let index = mi + 1; index < messages.length; index++) {
    const result = messages[index] as LhMessage & { toolCallId?: string; toolName?: string; isError?: boolean; details?: { pluginProblem?: unknown } };
    if (result.role === "assistant") break;
    if (result.role === "toolResult" && result.toolCallId === call.id && result.toolName === call.name) {
      return result.isError ? null : readPluginProblemSnapshot(result.details?.pluginProblem);
    }
  }
  return null;
}
