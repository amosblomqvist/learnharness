import type { PluginFrontendContext, PluginQuestionRenderer } from "learnharness-plugin-api";
import { QUESTION_TYPE_ID, type CodingQuestionPayload } from "./contract.ts";
import { mountAnswered, mountAnswerEditor } from "./editor.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  return ctx.registerQuestionRenderer({
    id: QUESTION_TYPE_ID,
    supportedContractVersions: [1],
    mountAnswerEditor,
    mountAnswered,
  } satisfies PluginQuestionRenderer<CodingQuestionPayload, string>);
}
