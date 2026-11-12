import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { it } from "node:test";

it("portable public SDK supports typed generic grading without exposing host authority or presentation policy", () => {
	const root = path.resolve(import.meta.dirname, "..");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-grading-types-test-"));
	try {
		const output = path.join(home, "api");
		const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-plugin-types.mjs"), output], { cwd: root, encoding: "utf8", timeout: 120_000 });
		assert.equal(build.status, 0, String(build.stdout) + String(build.stderr));
		assert.equal(fs.existsSync(path.join(output, "src/server")), false);
		fs.symlinkSync(path.join(root, "node_modules"), path.join(home, "node_modules"), "dir");
		const consumer = path.join(home, "consumer.mts");
		fs.writeFileSync(consumer, `
import { Type } from "typebox";
import type {
  JsonValue, PluginBackendContext, PluginFrontendContext, PluginQuestionAnswer,
  PluginQuestionAnswerValidationContext, PluginQuestionGradingContext,
  PluginQuestionGradingOutcome, PluginQuestionRenderer, PluginQuestionTypeDefinition,
} from "./api/index.d.ts";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type OutcomeIsGeneric = Assert<Equal<PluginQuestionGradingOutcome, { result: JsonValue } | { error: string }>>;
type AnswerHasOptionalOutcome = Assert<Equal<PluginQuestionAnswer["grading"], PluginQuestionGradingOutcome | undefined>>;
type GraderHasExactShape = Assert<Equal<PluginQuestionTypeDefinition["gradeAnswer"],
  ((context: PluginQuestionGradingContext<unknown, unknown>) => JsonValue | Promise<JsonValue>) | undefined>>;
type ContextAddsOnlySignal = Assert<Equal<keyof PluginQuestionGradingContext,
  keyof PluginQuestionAnswerValidationContext | "signal">>;
type AnsweredProps = Parameters<NonNullable<PluginQuestionRenderer["mountAnswered"]>>[1];
type RendererReceivesOutcome = Assert<Equal<AnsweredProps["grading"], PluginQuestionGradingOutcome | undefined>>;
type AnsweredHeaderIsOptionalElement = Assert<Equal<AnsweredProps["headerContainer"], HTMLElement | undefined>>;
type AnsweredHeaderIsOptional = Assert<Equal<{} extends Pick<AnsweredProps, "headerContainer"> ? true : false, true>>;
type QuestionProps = Parameters<NonNullable<PluginQuestionRenderer["mountQuestion"]>>[1];
type EditorProps = Parameters<PluginQuestionRenderer["mountAnswerEditor"]>[1];
type QuestionHasNoHeader = Assert<Equal<Extract<"headerContainer", keyof QuestionProps>, never>>;
type EditorHasNoHeader = Assert<Equal<Extract<"headerContainer", keyof EditorProps>, never>>;
declare const backend: PluginBackendContext;
declare const frontend: PluginFrontendContext;
const questionSchema = Type.Object({ expected: Type.Integer() });
const answerSchema = Type.Object({ value: Type.Integer() });
const definition: PluginQuestionTypeDefinition<typeof questionSchema, typeof answerSchema> = {
  id: "generic-grade", label: "Generic grade", contractVersion: 1, showThinking: false,
  questionSchema, answerSchema,
  probe: { toolName: "generic_grade_probe", description: "Ask a graded question" },
  validateAnswer(context) { const value: number = context.answer.value; void value; return undefined; },
  async gradeAnswer(context) {
    const expected: number = context.input.payload.expected;
    const value: number = context.answer.value;
    const signal: AbortSignal = context.signal;
    const validation: PluginQuestionAnswerValidationContext<{ expected: number }, { value: number }> = context;
    void [context.chatId, context.questionId, context.variant, context.contractVersion, validation];
    // @ts-expect-error The host-owned cancellation signal is readonly.
    context.signal = new AbortController().signal;
    // @ts-expect-error Typed answers are inferred from answerSchema.
    const wrong: string = context.answer.value;
    // @ts-expect-error Grading is not given a private history/turn controller.
    context.messages;
    signal.throwIfAborted();
    return { matched: value === expected, details: [false, null, 0, ""] };
  },
};
backend.registerQuestionType(definition);
const textQuestionSchema = Type.Object({ expected: Type.String(), attempts: Type.Integer() });
backend.registerQuestionType({
  id: "inline-sync-grade", label: "Inline sync", contractVersion: 1, showThinking: false,
  questionSchema: textQuestionSchema, answerSchema: Type.String(),
  probe: { toolName: "inline_sync_grade_probe", description: "Ask a typed text question" },
  gradeAnswer(context): JsonValue {
    type ExactAnswer = Assert<Equal<typeof context.answer, string>>;
    type ExactPayload = Assert<Equal<typeof context.input.payload, { expected: string; attempts: number }>>;
    const answer: string = context.answer;
    const expected: string = context.input.payload.expected;
    const attempts: number = context.input.payload.attempts;
    const result: JsonValue = { matched: answer === expected, attempts, details: [false, null, 0] };
    // @ts-expect-error Registration must infer a string answer, not any or number.
    const wrong: number = context.answer;
    // @ts-expect-error Only fields from the question schema are inferred.
    context.input.payload.missing;
    return result;
  },
});
backend.registerQuestionType({
  id: "inline-async-grade", label: "Inline async", contractVersion: 1, showThinking: false,
  questionSchema: textQuestionSchema, answerSchema: Type.String(),
  teach: { toolName: "inline_async_grade_teach", description: "Ask a typed text question" },
  async gradeAnswer(context): Promise<JsonValue> {
    type ExactAnswer = Assert<Equal<typeof context.answer, string>>;
    type ExactPayload = Assert<Equal<typeof context.input.payload, { expected: string; attempts: number }>>;
    const answer: string = context.answer;
    const expected: string = context.input.payload.expected;
    const attempts: number = context.input.payload.attempts;
    const signal: AbortSignal = context.signal;
    signal.throwIfAborted();
    const result: JsonValue = { matched: answer === expected, attempts, details: [false, null, 0] };
    // @ts-expect-error Async registration must also infer the exact string answer.
    const wrong: number = context.answer;
    // @ts-expect-error Async registration cannot widen the payload to arbitrary fields.
    context.input.payload.missing;
    return result;
  },
});
const falseDefinition: typeof definition = { ...definition, gradeAnswer: () => false };
const nullDefinition: typeof definition = { ...definition, gradeAnswer: async () => null };
const textDefinition: typeof definition = { ...definition, gradeAnswer: () => "plugin-owned result" };
backend.registerQuestionType(falseDefinition);
backend.registerQuestionType(nullDefinition);
backend.registerQuestionType(textDefinition);
const ungraded: PluginQuestionTypeDefinition<typeof questionSchema, typeof answerSchema> = {
  ...definition, gradeAnswer: undefined,
};
const success: PluginQuestionGradingOutcome = { result: false };
const nullSuccess: PluginQuestionGradingOutcome = { result: null };
const failure: PluginQuestionGradingOutcome = { error: "Plugin grading failed" };
// @ts-expect-error No host correctness/status vocabulary is required or accepted as an outcome envelope.
const status: PluginQuestionGradingOutcome = { status: "correct" };
// @ts-expect-error A grader returns JSON, not undefined.
const undefinedGrader: typeof definition = { ...definition, gradeAnswer: () => undefined };
// @ts-expect-error A grader cannot return a function.
const functionGrader: typeof definition = { ...definition, gradeAnswer: () => () => true };
// @ts-expect-error A grader cannot return a Date object.
const dateGrader: typeof definition = { ...definition, gradeAnswer: async () => new Date() };
// @ts-expect-error Validation stays synchronous; grading does not change its contract.
const asyncValidation: typeof definition = { ...definition, validateAnswer: async () => [] };
const renderer: PluginQuestionRenderer<{ expected: number }, { value: number }> = {
  id: "generic-grade", supportedContractVersions: [1],
  mountAnswerEditor(container, context) {
    // @ts-expect-error Header access is answered-only, not an editor capability.
    context.headerContainer;
    context.onChange({ status: "ready", value: { value: 0 } });
    return { update() {}, focus() { container.focus(); }, dispose() {} };
  },
  mountQuestion(_container, context) {
    // @ts-expect-error Header access is answered-only, not a question capability.
    context.headerContainer;
  },
  mountAnswered(container, context) {
    const header: HTMLElement | undefined = context.headerContainer;
    const badgeTarget: HTMLElement = context.headerContainer ?? container;
    badgeTarget.append(document.createElement("span"));
    void header;
    // @ts-expect-error The optional host-owned header capability is readonly.
    context.headerContainer = container;
    const answer: number = context.answer.value;
    const grading: PluginQuestionGradingOutcome | undefined = context.grading;
    if (grading && "result" in grading) {
      const result: JsonValue = grading.result;
      container.textContent = JSON.stringify(result); // Presentation is plugin-owned.
    } else if (grading) {
      const message: string = grading.error;
      container.textContent = message;
    }
    // @ts-expect-error The accepted outcome property is readonly.
    context.grading = { result: answer };
    // @ts-expect-error No built-in status is inferred from generic JSON.
    context.grading?.status;
  },
};
frontend.registerQuestionRenderer(renderer);
// @ts-expect-error No separate frontend assessment registration is added.
frontend.registerQuestionAssessment({ id: "generic-grade" });
// @ts-expect-error No public grading-job queue is added.
backend.gradingJobs;
void [ungraded, success, nullSuccess, failure, status, undefinedGrader, functionGrader, dateGrader, asyncValidation];
`);
		const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
		const check = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "false", "--allowImportingTsExtensions", "--target", "ES2022", "--lib", "ES2023,DOM,DOM.Iterable", "--module", "ESNext", "--moduleResolution", "bundler", consumer], { cwd: home, encoding: "utf8", timeout: 120_000 });
		assert.equal(check.status, 0, String(check.stdout) + String(check.stderr));
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});
