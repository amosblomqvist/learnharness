import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import test from "node:test";

test("portable public SDK infers practice payload/submission schemas and exposes processing, not assessment authority", () => {
  const root = path.resolve(import.meta.dirname, ".."), home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-problem-types-"));
  try {
    const output = path.join(home, "api");
    const build = spawnSync(process.execPath, [path.join(root, "scripts/build-plugin-types.mjs"), output], { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.equal(build.status, 0, String(build.stdout) + String(build.stderr));
    assert.equal(fs.existsSync(path.join(output, "src/server")), false);
    fs.symlinkSync(path.join(root, "node_modules"), path.join(home, "node_modules"), "dir");
    const consumer = path.join(home, "consumer.mts");
    fs.writeFileSync(consumer, `
import { Type } from "typebox";
import type { PluginBackendContext, PluginFrontendContext, PluginProblemRenderer, PluginProblemInput, PluginProblemProcessingOutcome, PluginSubmission, PluginSubmissionTarget, JsonValue } from "./api/index.d.ts";
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true:false;
type Assert<T extends true> = T;
type GenericObservations = Assert<Equal<PluginProblemProcessingOutcome, {result:JsonValue}|{error:string}>>;
declare const backend: PluginBackendContext;
declare const frontend: PluginFrontendContext;
backend.registerProblemType({
  id:"code", label:"Code", contractVersion:1,
  tool:{toolName:"code_problem",description:"Pose a coding practice problem"},
  problemSchema:Type.Object({starter:Type.String(),expected:Type.Integer()}), submissionSchema:Type.String(),
  validateProblem(context) {const starter:string=context.input.payload.starter; void starter; return undefined;},
  validateSubmission(context) {
    type ExactSubmission = Assert<Equal<typeof context.submission,string>>;
    const expected:number=context.input.payload.expected;
    // @ts-expect-error Submission inference must not widen to any.
    const wrong:number=context.submission;
    // @ts-expect-error Only the problem payload's declared fields exist.
    context.input.payload.missing;
    return undefined;
  },
  async processSubmission(context) {
    const value:string=context.submission;
    const thinking:string=context.thinking;
    const signal:AbortSignal=context.signal;
    // @ts-expect-error The host owns cancellation.
    context.signal=new AbortController().signal;
    // @ts-expect-error Processing has no conclude capability.
    context.conclude({outcome:"solved"});
    // @ts-expect-error Private conversation/turn ownership is not exposed.
    context.messages;
    signal.throwIfAborted();
    return {passed:value.length>0,observations:[false,null,thinking]};
  },
});
const renderer:PluginProblemRenderer<{starter:string},string>={id:"code",supportedContractVersions:[1],
  mountSubmissionEditor(container,context){
    const starter:string=context.input.payload.starter;
    context.onChange({status:"ready",value:starter});
    // @ts-expect-error Header slots are submitted-presentation capabilities only.
    context.headerContainer;
    return {update(props){const active:boolean=props.active;void active;},focus(){container.focus();},dispose(){}};
  },
  mountSubmitted(container,context){
    const value:string=context.submission;
    const observations:PluginProblemProcessingOutcome|undefined=context.processing;
    const header:HTMLElement=context.headerContainer??container;
    // @ts-expect-error The host-owned submitted header reference is readonly.
    context.headerContainer=container;
    // @ts-expect-error No grading/correctness vocabulary is supplied.
    context.grading;
    header.textContent=value;void observations;
  },
};
frontend.registerProblemRenderer(renderer);
// @ts-expect-error All plugin poses must commit a model solution.
const missingSolution:PluginProblemInput={statement:"Code",mode:"composition",payload:{}};
const falseObservation:PluginProblemProcessingOutcome={result:false};
// @ts-expect-error The processing envelope does not assess correctness.
const verdict:PluginProblemProcessingOutcome={correct:true};
declare const target:Extract<PluginSubmissionTarget,{type:"plugin-problem-submission"}>;
type ExactChannels=Assert<Equal<typeof target.channels,readonly ["submission","thinking"]>>;
const intercepted:Extract<PluginSubmission,{type:"plugin-problem-submission"}>={type:"plugin-problem-submission",submission:"code",submissionImages:[],thinking:{text:"reasoning",images:[]}};
void [missingSolution,falseObservation,verdict,intercepted];
`);
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const check = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "false", "--allowImportingTsExtensions", "--target", "ES2022", "--lib", "ES2023,DOM,DOM.Iterable", "--module", "ESNext", "--moduleResolution", "bundler", consumer], { cwd: home, encoding: "utf8", timeout: 30000 });
    assert.equal(check.status, 0, String(check.stdout) + String(check.stderr));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
