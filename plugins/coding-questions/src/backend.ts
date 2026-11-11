import type { PluginBackendContext } from "learnharness-plugin-api";
import { definition, instructions, practiceInstructions, problemDefinition, readTests } from "./contract.ts";
import { runTests } from "./runner.ts";

export function activate(ctx: PluginBackendContext): () => void {
  const unregisterQuestion = ctx.registerQuestionType({
    ...definition,
    gradeAnswer(context) {
      if (typeof context.answer !== "string") throw new Error("Coding answers must be strings.");
      return runTests({
        dataDirectory: ctx.dataDirectory,
        questionId: context.questionId,
        answer: context.answer,
        tests: readTests(context.input.payload),
        signal: context.signal,
      });
    },
  });
  const unregisterProblem = ctx.registerProblemType({
    ...problemDefinition,
    processSubmission(context) {
      if (typeof context.submission !== "string") throw new Error("Coding submissions must be strings.");
      return runTests({
        dataDirectory: ctx.dataDirectory,
        questionId: context.problemId,
        answer: context.submission,
        tests: readTests(context.input.payload),
        signal: context.signal,
      });
    },
  });
  const unregisterPracticeInstructions = ctx.registerInstructions({ agents: ["practice"], text: practiceInstructions });
  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: instructions });
  return () => {
    unregisterInstructions();
    unregisterPracticeInstructions();
    unregisterProblem();
    unregisterQuestion();
  };
}
