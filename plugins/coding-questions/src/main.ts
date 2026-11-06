import type { PluginFrontendContext, PluginQuestionRenderer } from "learnharness-plugin-api";
import { QUESTION_TYPE_ID, type CodingQuestionPayload } from "./contract.ts";
import { mountAnswered, mountAnswerEditor } from "./editor.ts";
import { mountTestResult } from "./result-view.ts";
import { readTestResult, type CodingTestResult } from "./test-result.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  return ctx.registerQuestionRenderer({
    id: QUESTION_TYPE_ID,
    supportedContractVersions: [1],
    mountAnswerEditor,
    mountAnswered(container, props) {
      if (props.signal.aborted) return;
      let resultCleanup: (() => void) | undefined;
      if (props.grading !== undefined) {
        const result = "result" in props.grading ? readTestResult(props.grading.result) : null;
        const failure: CodingTestResult = {
          status: "error", exitCode: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
          message: "error" in props.grading ? props.grading.error : "Saved test result is unavailable.",
        };
        resultCleanup = mountTestResult(container, ctx.ui, result ?? failure, props.signal, props.headerContainer);
      }
      try {
        const codeCleanup = mountAnswered(container, props);
        return () => { codeCleanup(); resultCleanup?.(); };
      } catch (error) {
        resultCleanup?.();
        throw error;
      }
    },
  } satisfies PluginQuestionRenderer<CodingQuestionPayload, string>);
}
