import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginAction, PluginActionPlacement, PluginDialogProps, PluginFrontendContext } from "learnharness-plugin-api";
import { activate, present } from "../src/main.ts";

function fakeContext(results: Record<string, unknown> = {}) {
	const actions: PluginAction[] = [], placements: PluginActionPlacement[] = [], dialogs: PluginDialogProps[] = [], calls: string[] = [];
	let settings = 0;
	const controller = new AbortController();
	const context = {
		signal: controller.signal,
		registerAction(value: PluginAction) { actions.push(value); return () => {}; },
		placeAction(value: PluginActionPlacement) { placements.push(value); return () => {}; },
		registerSettings() { settings++; return () => {}; },
		async call(operation: string) { calls.push(operation); return results[operation]; },
		ui: {
			openDialog(props: PluginDialogProps) {
				dialogs.push(props);
				queueMicrotask(() => void props.onClose?.());
				return { update() {}, dispose() {} };
			},
		},
	} as unknown as PluginFrontendContext;
	return { context, actions, placements, dialogs, calls, settings: () => settings };
}

test("activation registers Sync, Pull and Push in the sidebar plus settings", () => {
	const f = fakeContext();
	activate(f.context, { reload() {} });
	assert.deepEqual(f.actions.map(action => [action.id, action.name]), [
		["sync", "GitHub: Sync now"], ["pull", "GitHub: Pull"], ["push", "GitHub: Push"],
	]);
	assert.deepEqual(f.placements, [
		{ id: "sync-sidebar", actionId: "sync", location: "sidebar" },
		{ id: "pull-sidebar", actionId: "pull", location: "sidebar" },
		{ id: "push-sidebar", actionId: "push", location: "sidebar" },
	]);
	assert.equal(f.settings(), 1);
});

test("a result that changed files reloads the window without a dialog", async () => {
	const f = fakeContext({ pull: { status: "done", changed: true, message: "Pulled." } });
	let reloads = 0;
	activate(f.context, { reload: () => reloads++ });
	await f.actions.find(action => action.id === "pull")!.run({ placement: "sidebar", surface: "sidebar" } as never);
	assert.deepEqual(f.calls, ["pull"]);
	assert.equal(reloads, 1);
	assert.equal(f.dialogs.length, 0);
});

test("unchanged results and behind results are shown in a dialog", async () => {
	for (const result of [
		{ status: "done", changed: false, message: "Synced with GitHub." },
		{ status: "behind", changed: false, message: "GitHub has changes." },
	] as const) {
		const f = fakeContext();
		let reloads = 0;
		await present(f.context, result, { reload: () => reloads++ });
		assert.equal(reloads, 0);
		assert.equal(f.dialogs.length, 1);
		assert.equal(f.dialogs[0]!.title, "GitHub Sync");
	}
});

test("a conflict opens the choice dialog and does nothing when closed", async () => {
	const f = fakeContext();
	await present(f.context, { status: "conflict", changed: false, message: "Both changed.", branch: "main", remote: "a".repeat(40) }, { reload() {} });
	assert.deepEqual(f.dialogs.map(dialog => dialog.title), ["GitHub Sync conflict"]);
	assert.deepEqual(f.calls, []);
});
