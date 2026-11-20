import assert from "node:assert/strict";
import test from "node:test";
import { isPluginShortcutBinding, preparePluginShortcut, pluginShortcutId, pluginShortcutScopesOverlap, pluginShortcutMatches, resolvePluginShortcuts, type PluginShortcutCandidate } from "../src/core/plugin-shortcuts.ts";

const candidate = (pluginId: string, actionId = "draw", scope: unknown = { sessions: ["teaching", "practice"] }, binding = "mod+shift+d"): PluginShortcutCandidate => ({
	id: pluginShortcutId(pluginId, actionId), pluginId, actionId, name: actionId, pluginName: pluginId,
	shortcut: preparePluginShortcut({ scope, defaultBinding: binding }),
});
const core = new Map([["mod+d", "Toggle dictation"]]);

test("plugin shortcuts accept canonical modified single chords and function keys only", () => {
	for (const binding of ["mod+d", "alt+shift+x", "mod+alt+shift+arrowdown", "f1", "f24", "shift+f3", "mod++", "mod+,", "mod+ "]) assert.equal(isPluginShortcutBinding(binding), true, binding);
	for (const binding of ["", "d", "?", "arrowdown", "shift+d", "mod+enter", "alt+tab", "mod+escape", "Escape", "ctrl+d", "cmd+d", "mod+shift", "f25", "mod+d mod+x", "shift+mod+d", "mod+unidentified", "mod+space"]) assert.equal(isPluginShortcutBinding(binding), false, binding);
});

test("shortcut scope is explicit, validated and detached from author arrays", () => {
	const sessions = ["teaching"], views = ["board"];
	const definition = preparePluginShortcut({ scope: { sessions, views } });
	sessions.push("practice"); views.push("other");
	assert.deepEqual(definition, { scope: { sessions: ["teaching"], views: ["board"] } });
	assert.ok(Object.isFrozen(definition)); assert.ok(Object.isFrozen(definition.scope));
	assert.deepEqual(preparePluginShortcut({ scope: "app" }), { scope: "app" });
	for (const value of [{}, { scope: {} }, { scope: { sessions: [] } }, { scope: "global" }, { scope: { sessions: ["quiz"] } }, { scope: { views: [""] } }, { scope: "app", defaultBinding: "d" }, { scope: "app", defaultBinding: "" }]) assert.throws(() => preparePluginShortcut(value), /shortcut/i);
});

test("scope overlap is static and plugin view IDs are owner-scoped", () => {
	const teaching = candidate("one", "a", { sessions: ["teaching"] });
	const practice = candidate("two", "b", { sessions: ["practice"] });
	const own = candidate("one", "c", { views: ["board"] });
	const foreign = candidate("two", "d", { views: ["board"] });
	assert.equal(pluginShortcutScopesOverlap(teaching, practice), false);
	assert.equal(pluginShortcutScopesOverlap(own, foreign), false);
	assert.equal(pluginShortcutScopesOverlap(own, candidate("one", "e", { views: ["board"] })), true);
	assert.equal(pluginShortcutScopesOverlap(teaching, candidate("any", "global", "app")), true);
	assert.equal(pluginShortcutMatches(teaching, { surface: "session", kind: "teaching" }), true);
	assert.equal(pluginShortcutMatches(teaching, { surface: "session", kind: "practice" }), false);
	assert.equal(pluginShortcutMatches(own, { surface: "plugin-view", pluginId: "two", viewId: "board" }), false);
	assert.equal(pluginShortcutMatches(own, { surface: "plugin-view", pluginId: "one", viewId: "board" }), true);
	assert.equal(pluginShortcutMatches(candidate("any", "g", "app"), { surface: "app" }), true);
});

test("core wins and competing defaults have no load-order winner", () => {
	const one = candidate("one"), two = candidate("two");
	for (const entries of [[one, two], [two, one]]) assert.ok(resolvePluginShortcuts(entries, {}, core).every(row => row.status === "conflict"));
	const blocked = resolvePluginShortcuts([candidate("one", "draw", "app", "mod+d")], {}, core)[0]!;
	assert.equal(blocked.status, "conflict"); assert.match(blocked.reason!, /Toggle dictation/);
});

test("user assignments beat plugin defaults but conflicting user assignments fail closed", () => {
	const one = candidate("one"), two = candidate("two");
	const rows = resolvePluginShortcuts([one, two], { [one.id]: "mod+shift+d" }, core);
	assert.equal(rows[0]!.status, "active"); assert.equal(rows[1]!.status, "conflict");
	assert.ok(resolvePluginShortcuts([one, two], { [one.id]: "mod+shift+d", [two.id]: "mod+shift+d" }, core).every(row => row.status === "conflict"));
});

test("nonoverlapping shortcuts share chords; clear differs from reset; corrupt overrides fail closed", () => {
	const one = candidate("one", "a", { sessions: ["teaching"] }), two = candidate("two", "b", { sessions: ["practice"] });
	assert.ok(resolvePluginShortcuts([one, two], {}, core).every(row => row.status === "active"));
	assert.equal(resolvePluginShortcuts([one], { [one.id]: "" }, core)[0]!.status, "unbound");
	assert.equal(resolvePluginShortcuts([one], {}, core)[0]!.status, "active");
	assert.equal(resolvePluginShortcuts([one], { [one.id]: "tab" }, core)[0]!.status, "invalid");
});
