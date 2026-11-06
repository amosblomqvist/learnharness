import type { PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import type { CodingTests } from "./test-result.ts";

export const QUESTION_TYPE_ID = "code";
export type CodingQuestionPayload = {
  language: string;
  starterCode?: string;
  tests: CodingTests;
};

export const instructions = "When a teaching prediction or understanding check calls for writing or editing code, you may use coding_question. Specify the language, optionally supply starter code, and always supply tests:{program,args,code}. On submission the exact learner code is written to answer.txt in a fresh working directory, and tests.code is sent unchanged to the standard input of tests.program with tests.args. Choose arguments that read a program from stdin, such as python3 with ['-'], node with ['-'], or a shell with ['-s']; use the test code to load answer.txt, create any small driver files, compile if needed, and actually check the answer. Exit 0 only when the supplied tests pass; a nonzero exit means tests failed. Runtimes/compilers must already be installed; never install or download runtimes, compilers, or packages, or change machine configuration. Executables are resolved through the application's PATH or an explicit path. The run has a 30-second limit and captures at most 64 KiB each of stdout and stderr. Temporary files are removed afterward. Any language is permitted; highlighting depends on the bundled catalog. After submission, review the learner's exact code, separate thinking, and recorded test outcome. Tests passed/failed are observations, not proof of correctness.";

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
      tests: {
        type: "object",
        description: "Required test process recipe. Runs automatically after a valid submission, using installed user tools; nothing is installed or bundled.",
        properties: {
          program: { type: "string", pattern: "\\S", description: "Installed executable name on the app's PATH or an explicit executable path. No implicit shell." },
          args: { type: "array", items: { type: "string" }, description: "Literal argument vector; include the program's stdin-reading option. No shell expansion is performed by the runner." },
          code: { type: "string", pattern: "\\S", description: "Complete test/driver code supplied to the program's stdin. Read the learner submission from answer.txt in the working directory. Exit 0 for tests passed; nonzero for tests failed. Handle any compilation in this code. No runtime/package installs or downloads." },
        },
        required: ["program", "args", "code"],
        additionalProperties: false,
      },
    },
    required: ["language", "tests"],
    additionalProperties: false,
  },
  answerSchema: { type: "string", pattern: "\\S" },
  teach: {
    toolName: "coding_question",
    description: "Ask the learner to write or edit code. Supply a language, optional starter code, and required tests:{program,args,code}. On submission the tests run against answer.txt using installed user tools, then you receive the full code, separate thinking, and test outcome. Tests passed/failed do not mean correct/incorrect.",
  },
} satisfies PluginQuestionTypeDefinition;

/** Narrow the public plain-schema payload without relying on a TypeBox-only static brand. */
export function readTests(payload: unknown): CodingTests {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Coding question payload is unavailable.");
  const tests = (payload as Record<string, unknown>).tests;
  if (tests === null || typeof tests !== "object" || Array.isArray(tests)) throw new Error("Coding question test recipe is unavailable.");
  const recipe = tests as Record<string, unknown>;
  if (typeof recipe.program !== "string" || !/\S/.test(recipe.program) || !Array.isArray(recipe.args) || !recipe.args.every(arg => typeof arg === "string") || typeof recipe.code !== "string" || !/\S/.test(recipe.code)) throw new Error("Coding question test recipe is invalid.");
  return { program: recipe.program, args: recipe.args, code: recipe.code };
}

/** Readiness is not correctness, and must never trim the actual answer. */
export function isReady(code: string): boolean {
  return /\S/.test(code);
}

export function normalizeLineEndings(code: string): string {
  return code.replace(/\r\n?/g, "\n");
}
