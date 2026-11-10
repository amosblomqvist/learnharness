import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import { PluginSubmissionRunner } from "../components/plugin-submission-runner.ts";
import type { PluginFrontendContext, PluginInfo, PluginSubmissionTarget, PluginSurfaceTarget } from "../src/core/index.ts";

const target: PluginSubmissionTarget = { type: "text", sessionId: "chat", sessionKind: "teaching", channels: ["content"], surfaceTarget: {} as PluginSurfaceTarget };
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const info = (id: string): PluginInfo => ({ id, origin: "community", enabled: true, status: "active", revision: "1", manifest: { apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.3.7", main: "index.js" } });
function fixture() {
	const contexts = new Map<string, PluginFrontendContext>();
	const manager = new PluginFrontendManager({ fetch: async () => Response.json({}), pathname: () => "/", navigate() {}, importModule: async () => ({ activate(context) { contexts.set(context.manifest.id, context); } }) });
	manager.reconcile([info("zulu"), info("alpha")]);
	return { manager, contexts };
}

test("priority descending, default zero, plugin ID then interceptor ID; serial replacement composition", async () => {
	const { manager, contexts } = fixture(); await tick();
	const seen: string[] = [];
	for (const [pluginId, id, priority] of [["zulu", "second", undefined], ["alpha", "zeta", 0], ["alpha", "first", 0], ["zulu", "high", 10], ["alpha", "low", -2]] as const) {
		contexts.get(pluginId)!.registerSubmissionInterceptor({ id, priority, intercept(input) { assert.equal(input.type, "text"); if (input.type !== "text") return; seen.push(`${pluginId}/${id}`); return { type: "text", content: { text: `${input.content.text}:${id}`, images: [] } }; } });
	}
	const runner = new PluginSubmissionRunner(); const attempt = runner.begin(target, manager.captureSubmissionInterceptors(), () => true)!;
	const result = await attempt.prepare({ type: "text", content: { text: "start", images: [] } }, []);
	assert.deepEqual(seen, ["zulu/high", "alpha/first", "alpha/zeta", "zulu/second", "alpha/low"]);
	assert.equal(result?.type === "text" && result.content.text, "start:high:first:zeta:second:low"); attempt.cancel(); manager.dispose();
});

test("registration validation, owner binding, readiness refresh and predicate failures", async () => {
	const { manager, contexts } = fixture(); await tick(); const context = contexts.get("alpha")!;
	for (const definition of [{ id: "Upper", intercept() {} }, { id: "valid", priority: Infinity, intercept() {} }, { id: "valid", priority: 0.1, intercept() {} }, { id: "valid", intercept: null }]) assert.throws(() => context.registerSubmissionInterceptor(definition as never));
	let pending = false, notifications = 0;
	manager.subscribe(() => { notifications++; });
	const definition = { id: "pending", hasPendingInput(value: PluginSubmissionTarget) { assert.equal(this.id, "pending"); assert.ok(Object.isFrozen(value)); return pending; }, intercept() { assert.equal(this.id, "pending"); } };
	const off = context.registerSubmissionInterceptor(definition);
	assert.throws(() => context.registerSubmissionInterceptor(definition), /Duplicate/);
	assert.equal(manager.hasPendingSubmissionInput(target), false); pending = true;
	const before = notifications; context.refreshSubmissions(); assert.ok(notifications > before); assert.equal(manager.hasPendingSubmissionInput(target), true);
	context.registerSubmissionInterceptor({ id: "broken", hasPendingInput() { throw new Error("readiness failed"); }, intercept() {} });
	off(); assert.equal(manager.hasPendingSubmissionInput(target), false); await tick();
	assert.match(manager.getSnapshot().plugins.find(p => p.info.id === "alpha")?.error ?? "", /readiness failed/);
	const count = notifications; assert.equal(manager.hasPendingSubmissionInput(target), false); await tick(); assert.equal(notifications, count);
	manager.dispose();
});

test("an attempt captures registrations once; new hooks join only the next attempt and unregister aborts ownership", async () => {
	const { manager, contexts } = fixture(); await tick(); const context = contexts.get("alpha")!; let called = 0;
	const off = context.registerSubmissionInterceptor({ id: "first", intercept() { called++; } });
	const runner = new PluginSubmissionRunner(), attempt = runner.begin(target, manager.captureSubmissionInterceptors(), () => true)!;
	context.registerSubmissionInterceptor({ id: "new", intercept() { called += 100; } });
	await attempt.prepare({ type: "text", content: { text: "one", images: [] } }, []); assert.equal(called, 1);
	off(); assert.equal(attempt.signal.aborted, true); assert.equal(runner.occupied, false);
	const next = runner.begin(target, manager.captureSubmissionInterceptors(), () => true)!;
	await next.prepare({ type: "text", content: { text: "two", images: [] } }, []); assert.equal(called, 101);
	manager.reconcile([info("zulu")]); assert.equal(next.signal.aborted, true); assert.equal(runner.occupied, false); manager.dispose();
});
