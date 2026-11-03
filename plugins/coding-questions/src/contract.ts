import type { PluginQuestionTypeDefinition } from "learnharness-plugin-api";

export const QUESTION_TYPE_ID = "code";
export type CodingQuestionPayload = {
  language: string;
  starterCode?: string;
};

export const instructions = "When a teaching prediction or understanding check calls for writing or editing code, you may use coding_question. Specify the language and optionally supply starter code. Any language is permitted; highlighting depends on the bundled catalog. After submission, review the learner’s code and thinking in this conversation. This tool does not execute code or automatically grade it.";

export const definition = {
  id: QUESTION_TYPE_ID,
  label: "Coding question",
  contractVersion: 1,
  showThinking: true,
  questionSchema: {
    type: "object",
    properties: {
      language: {
        type: "string",
        pattern: "\\S",
        description: "Language name or alias, such as python, javascript, typescript, c, cpp, or sql. Any language is permitted; unknown languages use a plain-text editor.",
      },
      starterCode: {
        type: "string",
        description: "Optional code for the learner to edit. Omit or leave empty for a code-writing answer from scratch.",
      },
    },
    required: ["language"],
    additionalProperties: false,
  },
  answerSchema: { type: "string", pattern: "\\S" },
  teach: {
    toolName: "coding_question",
    description: "Ask the learner to write or edit code. Supply a language and optionally starter code. The learner submits their full code with separate thinking for you to review. No code execution or automatic grading is provided.",
  },
} satisfies PluginQuestionTypeDefinition;

/** Readiness is not correctness, and must never trim the actual answer. */
export function isReady(code: string): boolean {
  return /\S/.test(code);
}

export function normalizeLineEndings(code: string): string {
  return code.replace(/\r\n?/g, "\n");
}
