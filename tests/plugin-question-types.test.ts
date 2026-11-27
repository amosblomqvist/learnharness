import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { it } from "node:test";

it("packaged question SDK contracts support strict consumers without exposing host authority APIs", () => {
	const root = path.resolve(import.meta.dirname, "..");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-question-types-test-"));
	try {
		const output = path.join(home, "api");
		const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-plugin-types.mjs"), output], { cwd: root, encoding: "utf8", timeout: 120_000 });
		assert.equal(build.status, 0, String(build.stdout) + String(build.stderr));
		assert.ok(fs.existsSync(path.join(output, "src/core/plugin-questions.d.ts")));
		assert.equal(fs.existsSync(path.join(output, "src/server")), false);
		fs.symlinkSync(path.join(root, "node_modules"), path.join(home, "node_modules"), "dir");
		const consumer = path.join(home, "consumer.mts");
		fs.writeFileSync(consumer, `
import { Type } from "typebox";
import type { PluginBackendContext, PluginFrontendContext, PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionRenderer, PluginQuestionTypeDefinition, PluginQuestionGradingContext, PluginQuestionGradingOutcome } from "./api/index.d.ts";
declare const backend: PluginBackendContext;
declare const frontend: PluginFrontendContext;
const payload = Type.Object({ source: Type.String() });
const answer = Type.Union([Type.String(), Type.Null(), Type.Boolean(), Type.Integer()]);
const typed: PluginQuestionTypeDefinition<typeof payload, typeof answer> = {
  id: "example", label: "Example", contractVersion: 1, showThinking: false,
  questionSchema: payload, answerSchema: answer,
  probe: { toolName: "example_probe", description: "Ask an example" },
  validateQuestion(context) { const source: string = context.input.payload.source; void source; return undefined; },
  validateAnswer(context) { const value: string | null | boolean | number = context.answer; void value; return []; },
  async gradeAnswer(context) {
    const source: string = context.input.payload.source;
    const value: string | null | boolean | number = context.answer;
    const signal: AbortSignal = context.signal;
    const base: PluginQuestionGradingContext<{source:string}, string | null | boolean | number> = context;
    // @ts-expect-error Grading cancellation signal is readonly.
    context.signal = new AbortController().signal;
    void [source, value, signal, base]; return false;
  }
};
backend.registerQuestionType(typed);
backend.registerQuestionType({
  id: "example", label: "Example", contractVersion: 1, showThinking: false,
  questionSchema: payload, answerSchema: answer,
  teach: { toolName: "example_teach", description: "Ask a teaching example" },
  validateQuestion(context) { void [context.chatId, context.variant, context.contractVersion, context.input]; return []; },
  validateAnswer(context) { void [context.questionId, context.answer]; return undefined; }
});
const syncGrading: PluginQuestionTypeDefinition<typeof payload, typeof answer> = { ...typed, gradeAnswer(context) { return {source:context.input.payload.source, answer:context.answer}; } };
const gradingResult: PluginQuestionGradingOutcome = {result:null};
const gradingError: PluginQuestionGradingOutcome = {error:"Runner failed"};
// @ts-expect-error Grading must return JSON, not undefined.
const invalidGrading: PluginQuestionTypeDefinition = { ...typed, gradeAnswer: async () => undefined };
// @ts-expect-error Grading uses gradeAnswer; no separate assess hook exists on question definitions.
const grading: PluginQuestionTypeDefinition = { ...typed, assess: () => true };
// @ts-expect-error Refinements must be synchronous, not async grading stages.
const asynchronous: PluginQuestionTypeDefinition = { ...typed, validateAnswer: async () => undefined };
// @ts-expect-error showThinking is an explicit required contract property.
backend.registerQuestionType({ id: "missing-thinking", label: "Missing", contractVersion: 1, questionSchema: payload, answerSchema: answer, probe: {toolName:"missing_thinking", description:"Missing"} });
const renderer: PluginQuestionRenderer = {
  id: "example", supportedContractVersions: [1],
  async mountAnswerEditor(container, props) {
    const state: PluginQuestionAnswerState = {status:"ready", value:false};
    props.onChange(state);
    void [props.input.question, props.chatId, props.questionId, props.contractVersion, props.variant, props.signal];
    // @ts-expect-error Footer capability is answered-only.
    void props.footerContainer;
    const handle: PluginQuestionEditorHandle = {
      update({answer, active}) { void [answer, active]; },
      focus() { container.focus(); },
      handleKeyDown(key) { return key === "Tab" ? "handled" : "pass"; },
      async appendTranscript(text) { props.onChange({status:"unready", value:text}); },
      dispose() { container.replaceChildren(); }
    };
    return handle;
  },
  mountQuestion(container, props) { container.textContent = props.input.question; return () => container.replaceChildren(); },
  mountAnswered(container, props) {
    const grading: PluginQuestionGradingOutcome | undefined = props.grading;
    const footer: HTMLElement | undefined = props.footerContainer;
    // @ts-expect-error The generation-owned footer reference is readonly, not its DOM content.
    props.footerContainer = container;
    void footer;
    // @ts-expect-error Saved grading context is readonly.
    props.grading = {result:false};
    container.textContent = JSON.stringify([props.answer, grading]); return async () => container.replaceChildren();
  }
};
frontend.registerQuestionRenderer(renderer);
// @ts-expect-error Every renderer explicitly lists supported historical versions.
frontend.registerQuestionRenderer({id:"missing-support", mountAnswerEditor:renderer.mountAnswerEditor});
// @ts-expect-error An empty state cannot retain a draft value.
const empty: PluginQuestionAnswerState = {status:"empty", value:"draft"};
// @ts-expect-error Ready requires an explicit finite-JSON-shaped value.
const ready: PluginQuestionAnswerState = {status:"ready"};
// @ts-expect-error The SDK has no frontend assessment registration surface.
frontend.registerQuestionAssessment({id:"example"});
void [typed, grading, asynchronous, empty, ready, syncGrading, gradingResult, gradingError, invalidGrading];
`);
		const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
		const check = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "--allowImportingTsExtensions", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", consumer], { cwd: home, encoding: "utf8", timeout: 120_000 });
		assert.equal(check.status, 0, String(check.stdout) + String(check.stderr));
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});
