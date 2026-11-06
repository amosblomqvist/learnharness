import type { PluginBackendContext } from "learnharness-plugin-api";
import { definition, instructions, readTests } from "./contract.ts";
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
  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: instructions });
  return () => {
    unregisterInstructions();
    unregisterQuestion();
  };
}
