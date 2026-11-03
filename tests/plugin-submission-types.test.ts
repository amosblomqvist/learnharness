import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { it } from "node:test";

it("portable submission SDK exposes readonly learner input and opaque native surfaces without backend hooks", () => {
	const root = path.resolve(import.meta.dirname, "..");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-submission-types-"));
	try {
		const output = path.join(home, "api");
		const build = spawnSync(process.execPath, [path.join(root, "scripts/build-plugin-types.mjs"), output], { cwd: root, encoding: "utf8", timeout: 30_000 });
		assert.equal(build.status, 0, String(build.stdout) + String(build.stderr));
		assert.ok(fs.existsSync(path.join(output, "src/core/plugin-submissions.d.ts")));
		assert.equal(fs.existsSync(path.join(output, "src/server")), false);
		fs.symlinkSync(path.join(root, "node_modules"), path.join(home, "node_modules"), "dir");
		const consumer = path.join(home, "consumer.mts");
		fs.writeFileSync(consumer, `
import type { PluginSubmission, PluginSubmissionContext, PluginSubmissionTarget, PluginSubmissionImages, PluginSubmissionOccurrence, PluginSubmissionInterceptor, PluginFrontendContext, PluginBackendContext, PluginActionContext } from "./api/index.d.ts";
import type { PluginSurfaceTarget, PluginSurfaceProps } from "./api/index.d.ts";
declare const frontend: PluginFrontendContext;
declare const backend: PluginBackendContext;
declare const target: PluginSubmissionTarget;
declare const input: PluginSubmission;
declare const context: PluginSubmissionContext;
const hook: PluginSubmissionInterceptor = {
 id: "drawing", priority: 2,
 hasPendingInput(target) { return target.type === "answer"; },
 async intercept(input, context) {
   context.onAccepted(async () => {});
   void [context.messages, context.signal, context.surfaceTarget, context.channels];
   // @ts-expect-error Input is readonly.
   input.type = input.type;
   if (input.type === "answer") {
     // @ts-expect-error Nested learner selections are readonly.
     input.answer.values?.push("a");
     // @ts-expect-error Nested native image blocks are readonly.
     input.answer.images[0]!.data = "changed";
     // @ts-expect-error No derived grading authority on hook input.
     input.answer.correct = true;
   }
   if (input.type === "plugin-question-answer" && input.answer && typeof input.answer === "object") {
     // @ts-expect-error JSON answer is recursively readonly, including arrays.
     input.answer.extra = true;
   }
   if (context.type === "answer") {
     const occurrence: PluginSubmissionOccurrence = context.question.occurrence;
     // @ts-expect-error Presentation is recursively readonly.
     context.question.options[0]!.label = "changed";
     // @ts-expect-error Presentation has no answer key.
     void context.question.correctIndices;
     void occurrence;
   }
   const message = context.messages[0];
   if (message?.role === "user" && Array.isArray(message.content)) {
     // @ts-expect-error History is recursively readonly.
     message.timestamp = 2;
   }
   return input;
 }
};
frontend.registerSubmissionInterceptor(hook)();
frontend.refreshSubmissions();
const props: PluginSurfaceProps = { title: "Drawing", content: document.createElement("div"), onClose: async () => {} };
frontend.ui.openSurface(target.surfaceTarget, props, { signal: context.signal }).update({ title: "Updated" });
// @ts-expect-error Surface targets cannot be manufactured from session IDs.
const forged: PluginSurfaceTarget = { sessionId: "s" };
// @ts-expect-error Surface API does not take an arbitrary DOM parent.
frontend.ui.openSurface(document.body, props, { signal: context.signal });
// @ts-expect-error Backend hooks are intentionally absent.
backend.registerSubmissionInterceptor(hook);
// @ts-expect-error No generic send capability.
frontend.send(input);
// @ts-expect-error Readiness is synchronous.
const asynchronous: PluginSubmissionInterceptor = { ...hook, hasPendingInput: async () => true };
// @ts-expect-error Registration ID is required.
frontend.registerSubmissionInterceptor({ intercept() {} });
declare const action: PluginActionContext;
if (action.placement === "top-bar" && action.surface === "session") frontend.ui.openSurface(action.surfaceTarget, props, { signal: context.signal });
const images: PluginSubmissionImages = { answer: [{type:"image", data:"aGVsbG8=", mimeType:"image/png"}] };
// @ts-expect-error Transport images are readonly too.
images.answer?.push({type:"image",data:"aA==",mimeType:"image/png"});
void [forged, asynchronous];
`);
		const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
		const check = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "--allowImportingTsExtensions", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", consumer], { cwd: home, encoding: "utf8", timeout: 30_000 });
		assert.equal(check.status, 0, String(check.stdout) + String(check.stderr));
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});
