import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import test from "node:test";

test("portable SDK exposes whole-view context and deeply readonly drafts without submission capabilities", () => {
  const root = path.resolve(import.meta.dirname, ".."), home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-view-types-"));
  try {
    const output = path.join(home, "api");
    const build = spawnSync(process.execPath, [path.join(root, "scripts/build-plugin-types.mjs"), output], { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.equal(build.status, 0, String(build.stdout) + String(build.stderr));
    assert.equal(fs.existsSync(path.join(output, "src/server")), false);
    fs.symlinkSync(path.join(root, "node_modules"), path.join(home, "node_modules"), "dir");
    const consumer = path.join(home, "consumer.mts");
    fs.writeFileSync(consumer, `
import type { PluginFrontendContext, PluginSessionViewContext, PluginSessionViewInput, PluginNativeQuestionViewDraft, PluginSurfaceTarget } from "./api/index.d.ts";
declare const frontend: PluginFrontendContext;
frontend.registerAction({ id:"read-view",name:"Read view",run(context){
  if(context.surface!=="session") {
    // @ts-expect-error Non-session placements have no host session content.
    context.view;
    return;
  }
  const view:PluginSessionViewContext=context.view;
  const title:string=view.title;
  const count:number=view.messages.length;
  const rendered:number=view.transcript.length;
  // @ts-expect-error A view snapshot never acknowledges a submission.
  view.onAccepted(()=>{});
  // @ts-expect-error The host owns snapshot identity.
  context.view=view;
  // @ts-expect-error History is immutable.
  view.messages.push(view.messages[0]);
  // @ts-expect-error Projected transcript parts are immutable too.
  view.transcript[0].parts[0].type="changed";
  // @ts-expect-error The composer draft is a detached readonly value.
  view.composer.text="replace learner input";
  const input:PluginSessionViewInput=view.input;
  if(input.type==="answer") {
    const draft:PluginNativeQuestionViewDraft=input.draft;
    const option:string=input.question.options[0].value;
    const target:PluginSurfaceTarget=input.surfaceTarget;
    // @ts-expect-error Actual displayed options are immutable.
    input.question.options.reverse();
    // @ts-expect-error Selected values cannot be modified through view access.
    draft.values.push(option);
    // @ts-expect-error Learner-facing question projection has no answer keys.
    input.question.correctIndices;
    void target;
  }
  if(input.type==="plugin-question-answer") {
    const question:string=input.input.question;
    if(input.draft.answer.status!=="empty") {
      // @ts-expect-error Editor values are readonly snapshot data, not a setter.
      input.draft.answer.value={newValue:true};
    }
    void question;
  }
  if(input.type==="plugin-problem-submission") {
    const statement:string=input.input.statement;
    // @ts-expect-error A custom saved input is immutable.
    input.input.target?.push("another proposition");
    void statement;
  }
  void [title,count,rendered];
}});
`);
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const check = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "false", "--allowImportingTsExtensions", "--target", "ES2022", "--lib", "ES2023,DOM,DOM.Iterable", "--module", "ESNext", "--moduleResolution", "bundler", consumer], { cwd: home, encoding: "utf8", timeout: 30000 });
    assert.equal(check.status, 0, String(check.stdout) + String(check.stderr));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
