import type { AgentTool } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { createPluginProblemParameters, validatePluginProblemInput, readPluginProblemSnapshot,
  type NativePluginProblemDefinition, type PluginProblemSnapshot } from "../core/plugin-problems.ts";
import { freezePluginQuestionValue } from "../core/plugin-questions.ts";
import { resolveTargetId } from "../core/chains.ts";
import { admitPracticeProblem, type PracticeGate, type PracticeToolContext } from "./tools/practice.ts";
import { healEncodedArguments } from "./tools/heal.ts";
import { invalidInputResult, problemResult } from "./tool-execute.ts";

export interface NativePluginProblemContribution {
  pluginId: string;
  definition: NativePluginProblemDefinition;
  signal: AbortSignal;
  requireActive(): void;
}
export function pluginProblemTools(contributions: readonly NativePluginProblemContribution[], chatId: string,
  gate: PracticeGate, graphNodes?: PracticeToolContext["graphNodes"]): AgentTool<any>[] {
  return contributions.map(contribution => {
    const { definition, pluginId } = contribution;
    const parameters = createPluginProblemParameters(definition);
    return {
      name: definition.tool.toolName, label: definition.label, description: definition.tool.description,
      parameters, executionMode: "sequential" as const,
      prepareArguments(args: unknown) {
        contribution.requireActive();
        const healed = healEncodedArguments(args, parameters) as Record<string, unknown>;
        if (!graphNodes || !Array.isArray(healed.target)) return healed;
        const nodes = graphNodes();
        return { ...healed, target: healed.target.map(target => typeof target === "string" ? resolveTargetId(target, nodes) ?? target : target) };
      },
      async execute(_toolCallId: string, input: unknown, signal?: AbortSignal) {
        contribution.requireActive();
        if (signal?.aborted || contribution.signal.aborted) throw new Error("Operation aborted");
        const accepted = validatePluginProblemInput(definition, { chatId, input });
        if (!accepted.ok) return invalidInputResult(definition.tool.toolName, accepted.problems);
        const pluginProblem: PluginProblemSnapshot = freezePluginQuestionValue({
          protocolVersion: 1, problemId: randomUUID(), pluginId, typeId: definition.id, label: definition.label,
          contractVersion: definition.contractVersion, input: accepted.value,
          problemSchema: definition.problemSchema, submissionSchema: definition.submissionSchema,
          requiresSubmissionRefinement: !!definition.validateSubmission, requiresProcessing: !!definition.processSubmission,
        });
        contribution.requireActive();
        const refused = admitPracticeProblem(gate, accepted.value, graphNodes, definition.tool.toolName);
        return refused ?? { ...problemResult(), details: { pluginProblem } };
      },
    };
  });
}
/** Practice ACKs persist; a successful host snapshot also stops mixed tool batches. */
export function isPluginProblemPoseAcknowledgment(value: unknown): boolean {
  const result = value as { isError?: boolean; details?: { pluginProblem?: unknown } } | undefined;
  return !!result && !result.isError && !!readPluginProblemSnapshot(result.details?.pluginProblem);
}
