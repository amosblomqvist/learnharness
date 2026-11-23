import { ChatInputError, type PluginProblemSubmissionInput } from "../core/input-events.ts";
import { activeProblemOf, activeProblemOccurrenceOf, newMessageId, type LhMessage } from "../core/native-messages.ts";
import { clonePluginQuestionJson, freezePluginQuestionValue, samePluginQuestionOccurrence } from "../core/plugin-questions.ts";
import { preparePluginProblemSubmissionImages } from "../core/plugin-submissions.ts";
import { validatePluginProblemSubmission, readPluginProblemSubmission, type PluginProblemSnapshot, type PluginProblemProcessingOutcome, type PluginProblemSubmission } from "../core/plugin-problems.ts";
import type { PluginProblemResolution } from "./plugin-host.ts";

export type ProblemTypeResolver = (pluginId: string, typeId: string, contractVersion: number) => PluginProblemResolution;
export function requirePluginProblemTarget(record: { kind?: string; messages: readonly LhMessage[] }, input: Pick<PluginProblemSubmissionInput, "problemId" | "occurrence">): PluginProblemSnapshot {
  const active = activeProblemOf(record.messages), occurrence = activeProblemOccurrenceOf(record.messages);
  if (record.kind !== "practice" || !active?.pluginProblem || active.pluginProblem.problemId !== input.problemId || !occurrence || !samePluginQuestionOccurrence(occurrence, input.occurrence))
    throw new ChatInputError("This problem is no longer active. Sync the saved session before trying again.");
  return active.pluginProblem;
}
export interface PreparedPluginProblemSubmission {
  snapshot: PluginProblemSnapshot;
  signal: AbortSignal;
  process?: (signal: AbortSignal) => Promise<PluginProblemProcessingOutcome>;
  finish(record: { id: string; kind?: string; messages: LhMessage[] }, processing?: PluginProblemProcessingOutcome): LhMessage[];
}
/** VALIDATE → optional PROCESS → SAVE → CONTINUE. Processing never concludes a problem. */
export function preparePluginProblemSubmission(record: { id: string; kind?: string; messages: LhMessage[] }, input: PluginProblemSubmissionInput, resolve: ProblemTypeResolver): PreparedPluginProblemSubmission {
  const snapshot = requirePluginProblemTarget(record, input), chatId = record.id, captured = JSON.stringify(snapshot);
  const target = { problemId: snapshot.problemId, occurrence: freezePluginQuestionValue(clonePluginQuestionJson(input.occurrence)) as unknown as PluginProblemSubmissionInput["occurrence"] };
  const resolution = resolve(snapshot.pluginId, snapshot.typeId, snapshot.contractVersion);
  if (resolution.status !== "available" || (snapshot.requiresProcessing && !resolution.definition.processSubmission)) throw new ChatInputError("Problem unavailable");
  const { signal: activationSignal, definition } = resolution;
  const requireAuthority = (signal?: AbortSignal) => {
    try { resolution.requireActive(); } catch { throw new ChatInputError("Problem unavailable"); }
    if (activationSignal.aborted || signal?.aborted) throw new ChatInputError("Problem unavailable");
  };
  requireAuthority();
  const accepted = validatePluginProblemSubmission(snapshot, { chatId, submission: input.submission }, definition);
  if (!accepted.ok) throw new ChatInputError(accepted.problems.join("\n"));
  if (input.thinking !== undefined && typeof input.thinking !== "string") throw new ChatInputError("Problem thinking must be text");
  let images;
  try { images = input.images === undefined ? undefined : preparePluginProblemSubmissionImages(input.images); }
  catch { throw new ChatInputError("Invalid problem submission images"); }
  const saved: Omit<PluginProblemSubmission, "submittedAt" | "processing"> = freezePluginQuestionValue({
    kind: "plugin-problem-submission", problemId: snapshot.problemId, pluginId: snapshot.pluginId,
    typeId: snapshot.typeId, contractVersion: snapshot.contractVersion, submission: accepted.value, thinking: input.thinking ?? "",
    ...(images && Object.keys(images).length ? { images } : {}),
  });
  requireAuthority();
  let processingSignal: AbortSignal | undefined, processingSettled = false;
  return {
    snapshot, signal: activationSignal,
    ...(snapshot.requiresProcessing ? { process: async (signal: AbortSignal): Promise<PluginProblemProcessingOutcome> => {
      const combined = AbortSignal.any([signal, activationSignal]); processingSignal = combined; processingSettled = false;
      requireAuthority(combined);
      let outcome: PluginProblemProcessingOutcome;
      try {
        const result = await definition.processSubmission!(Object.freeze({ chatId, problemId: snapshot.problemId,
          contractVersion: snapshot.contractVersion, input: snapshot.input, submission: accepted.value,
          thinking: saved.thinking, ...(saved.images ? { images: saved.images } : {}), signal: combined }));
        requireAuthority(combined);
        outcome = { result: freezePluginQuestionValue(clonePluginQuestionJson(result)) };
      } catch (error) {
        requireAuthority(combined);
        let message = "An error occurred.";
        try { if (error instanceof Error && typeof error.message === "string") message = error.message; } catch { /* safe generic */ }
        outcome = { error: message };
      }
      requireAuthority(combined); processingSettled = true;
      return Object.freeze(outcome);
    } } : {}),
    finish(current, processing) {
      requireAuthority(processingSignal);
      const pending = requirePluginProblemTarget(current, target);
      if (current.id !== chatId || JSON.stringify(pending) !== captured) throw new ChatInputError("This problem changed. Sync the saved session before trying again.");
      if (snapshot.requiresProcessing && !processingSettled) throw new ChatInputError("Submission processing has not completed");
      const envelope = readPluginProblemSubmission({ ...saved, ...(snapshot.requiresProcessing ? { processing } : {}), submittedAt: new Date().toISOString() });
      if (!envelope) throw new ChatInputError("Invalid problem submission outcome");
      return [{ id: newMessageId(), role: "custom", customType: "plugin-problem-submission", display: true,
        content: JSON.stringify({ ...envelope, images: undefined }), details: envelope, timestamp: Date.now() }];
    },
  };
}
/** Response-only readiness; disabled/missing/incompatible types never fall back to native thinking. */
export function pluginProblemAvailabilityOf(record: { messages: readonly LhMessage[] }, resolve?: ProblemTypeResolver): { problemId: string; status: "available" | "unavailable" } | undefined {
  const snapshot = activeProblemOf(record.messages)?.pluginProblem;
  if (!snapshot) return undefined;
  let available = false;
  try {
    const current = resolve?.(snapshot.pluginId, snapshot.typeId, snapshot.contractVersion);
    if (current?.status === "available" && !current.signal.aborted && (!snapshot.requiresSubmissionRefinement || current.definition.validateSubmission) && (!snapshot.requiresProcessing || current.definition.processSubmission)) {
      current.requireActive(); available = true;
    }
  } catch { /* unavailable is honest */ }
  return { problemId: snapshot.problemId, status: available ? "available" : "unavailable" };
}
