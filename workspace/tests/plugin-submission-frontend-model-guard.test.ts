import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginSubmissionRunner, SubmissionModelEpoch } from "../components/plugin-submission-runner.ts";
import type { PluginSubmissionTarget, PluginSurfaceTarget } from "../src/core/index.ts";
const target: PluginSubmissionTarget = { type: "text", channels: ["content"], sessionId: "chat", sessionKind: "teaching", surfaceTarget: {} as PluginSurfaceTarget };

test("known session model change during finalization refuses before capture/hooks/POST, while first read and catalog refresh do not", async () => {
	const epoch = new SubmissionModelEpoch(), runner = new PluginSubmissionRunner();
	const initial = epoch.capture(); epoch.observe(undefined); epoch.observe("provider:first"); assert.equal(epoch.isCurrent(initial), true);
	epoch.observe(undefined); epoch.observe("provider:first"); assert.equal(epoch.isCurrent(initial), true);
	let finish!: () => void, hooks = 0;
	const final = new Promise<void>(resolve => { finish = resolve; }); const revision = epoch.capture();
	const attempt = runner.begin(target, [{ pluginId: "fixture", pluginName: "Fixture", signal: new AbortController().signal, isCurrent: () => true, report() {}, interceptor: { id: "hook", intercept() { hooks++; } } }], () => epoch.isCurrent(revision))!;
	const pending = attempt.finalize(async () => { await final; return { type: "text" as const, content: { text: "retained", images: [] } }; });
	epoch.observe("provider:replacement"); finish(); await assert.rejects(pending, { name: "AbortError" });
	assert.equal(hooks, 0); assert.equal(runner.occupied, false);
});
