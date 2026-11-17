import React from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { FACTORY_SETTINGS, resolveSettings, sanitizeUserSettings } from "../src/core/index.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";
import { resolveAppearance } from "../components/settings/appearance.tsx";

(globalThis as Record<string, unknown>).React = React;

const FACTORY = { userThinking: true, why: false, agentThinking: false };

it("factory: your thinking expanded, Why and agent thinking collapsed, on both resolution paths", () => {
	assert.deepEqual(FACTORY_SETTINGS.appearance.expandByDefault, FACTORY);
	for (const appearance of [undefined, {}, { proseFontSize: 20 }, { expandByDefault: {} }]) {
		assert.deepEqual(resolveSettings({ version: 1, appearance }).appearance.expandByDefault, FACTORY);
		assert.deepEqual(resolveAppearance(appearance).expandByDefault, FACTORY);
	}
	assert.deepEqual(resolveSettings(null).appearance.expandByDefault, FACTORY);
});

it("each stored kind overrides only itself", () => {
	const appearance = { expandByDefault: { why: true } };
	const expected = { userThinking: true, why: true, agentThinking: false };
	assert.deepEqual(resolveSettings({ version: 1, appearance }).appearance.expandByDefault, expected);
	assert.deepEqual(resolveAppearance(appearance).expandByDefault, expected);
	const all = { userThinking: false, why: true, agentThinking: true };
	assert.deepEqual(resolveSettings({ version: 1, appearance: { expandByDefault: all } }).appearance.expandByDefault, all);
});

it("the sanitizer keeps known kinds with boolean values and drops everything else", () => {
	const record = sanitizeUserSettings({
		version: 1,
		appearance: { proseFontSize: 20, expandByDefault: { why: true, agentThinking: "yes", userThinking: null, planThinking: true } },
	});
	assert.deepEqual(record?.appearance, { proseFontSize: 20, expandByDefault: { why: true } });
	assert.deepEqual(resolveSettings(record).appearance.expandByDefault, { userThinking: true, why: true, agentThinking: false });
	for (const expandByDefault of [null, true, "why", ["why"]]) {
		const dropped = sanitizeUserSettings({ version: 1, appearance: { proseFontSize: 20, expandByDefault } });
		assert.deepEqual(dropped?.appearance, { proseFontSize: 20 }, JSON.stringify(expandByDefault));
	}
});

it("the appearance PUT accepts per-kind booleans and rejects unknown kinds and non-booleans", () => {
	const body = { fontFamily: "Georgia", expandByDefault: { userThinking: false, why: true, agentThinking: true } };
	const parsed = parseAppearanceSettingsBody(body);
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.settings, body);
	for (const expandByDefault of [null, true, [], { planThinking: true }, { why: "true" }, { why: null }]) {
		assert.equal(parseAppearanceSettingsBody({ expandByDefault }).ok, false, JSON.stringify(expandByDefault));
	}
});
