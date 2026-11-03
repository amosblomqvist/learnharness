import type { PluginBackendContext } from "learnharness-plugin-api";
import { definition, instructions } from "./contract.ts";

export function activate(ctx: PluginBackendContext): () => void {
  const unregisterQuestion = ctx.registerQuestionType(definition);
  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: instructions });
  return () => {
    unregisterInstructions();
    unregisterQuestion();
  };
}
