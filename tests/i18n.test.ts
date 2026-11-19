/**
 * i18n foundation tests (2026-11-19): the app-language registry, the
 * English-keyed dictionary seam, the settings coordinate that selects a
 * language, and the ONE maintenance rule the dictionary must satisfy — every
 * literal the shell renders through t("…") has a translation, every
 * translation keeps its placeholders, and no English string is owned by two
 * surface files (two translations for one source is always a mistake).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
	APP_LANGUAGES,
	DEFAULT_APP_LANGUAGE,
	DICTIONARIES,
	htmlLangFor,
	interpolate,
	isAppLanguage,
	isKnownLanguageTag,
	languageLabel,
	pickLocalized,
	resolveAppLanguage,
	translate,
} from "../src/core/i18n.ts";
import { COMMON } from "../src/core/i18n/zh-CN/common.ts";
import { SIDEBAR } from "../src/core/i18n/zh-CN/sidebar.ts";
import { CHAT } from "../src/core/i18n/zh-CN/chat.ts";
import { QUESTION } from "../src/core/i18n/zh-CN/question.ts";
import { GRAPH } from "../src/core/i18n/zh-CN/graph.ts";
import { SETTINGS } from "../src/core/i18n/zh-CN/settings.ts";
import { DIALOGS } from "../src/core/i18n/zh-CN/dialogs.ts";
import { ARTIFACTS } from "../src/core/i18n/zh-CN/artifacts.ts";
import { PLUGINS } from "../src/core/i18n/zh-CN/plugins.ts";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";

const SURFACES: [string, Readonly<Record<string, string>>][] = [
	["common", COMMON],
	["sidebar", SIDEBAR],
	["chat", CHAT],
	["question", QUESTION],
	["graph", GRAPH],
	["settings", SETTINGS],
	["dialogs", DIALOGS],
	["artifacts", ARTIFACTS],
	["plugins", PLUGINS],
];

describe("app-language registry", () => {
	it("ships English as the source language and Simplified Chinese as the first translation", () => {
		assert.deepEqual(APP_LANGUAGES.map((entry) => entry.id), ["en", "zh-CN"]);
		assert.equal(DEFAULT_APP_LANGUAGE, "en");
		assert.equal(htmlLangFor("zh-CN"), "zh-CN");
		assert.equal(htmlLangFor("en"), "en");
		assert.equal(languageLabel("zh-CN"), "简体中文");
	});

	it("resolves BCP 47 aliases and falls back to English for anything unknown", () => {
		assert.equal(resolveAppLanguage("zh"), "zh-CN");
		assert.equal(resolveAppLanguage("zh-Hans"), "zh-CN");
		assert.equal(resolveAppLanguage("zh-hans-cn"), "zh-CN");
		assert.equal(resolveAppLanguage("en-GB"), "en");
		assert.equal(resolveAppLanguage("fr"), "en");
		assert.equal(resolveAppLanguage(42), "en");
		assert.equal(resolveAppLanguage(""), "en");
		assert.ok(isKnownLanguageTag("zh-Hans"));
		assert.ok(!isKnownLanguageTag("de"));
		assert.ok(isAppLanguage("zh-CN"));
		assert.ok(!isAppLanguage("zh"));
	});

	it("translate falls back to the English source and interpolates placeholders", () => {
		assert.equal(translate("zh-CN", "Cancel"), "取消");
		assert.equal(translate("en", "Cancel"), "Cancel");
		// Missing key: the English source, never an empty string.
		assert.equal(translate("zh-CN", "Not a real string in this app"), "Not a real string in this app");
		assert.equal(translate("zh-CN", "Version {version}", { version: "1.2.3" }), "版本 1.2.3");
		// Unknown placeholder survives verbatim — a visible {name} beats "undefined".
		assert.equal(interpolate("{a} and {b}", { a: "x" }), "x and {b}");
		assert.equal(pickLocalized("zh-CN", "English", "简体中文"), "简体中文");
		assert.equal(pickLocalized("en", "English", "简体中文"), "English");
	});
});

describe("Simplified Chinese dictionary", () => {
	it("has no empty translations and no English string owned by two surfaces", () => {
		const owners = new Map<string, string>();
		for (const [surface, entries] of SURFACES) {
			for (const [key, value] of Object.entries(entries)) {
				assert.ok(value.trim().length > 0, surface + " translates " + JSON.stringify(key) + " to nothing");
				const previous = owners.get(key);
				assert.equal(previous, undefined, JSON.stringify(key) + " is owned by " + previous + " and " + surface);
				owners.set(key, surface);
			}
		}
		// The merged dictionary is exactly the union — nothing is dropped.
		assert.equal(Object.keys(DICTIONARIES["zh-CN"] ?? {}).length, owners.size);
	});

	it("keeps every {placeholder} of the English source", () => {
		for (const [surface, entries] of SURFACES) {
			for (const [key, value] of Object.entries(entries)) {
				const placeholders = (text: string) => [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
				assert.deepEqual(placeholders(value), placeholders(key), surface + " changed placeholders for " + JSON.stringify(key));
			}
		}
	});

	it("translates every literal the shell renders through t(…)", () => {
		const roots = ["components", "app", "src"].map((dir) => path.join(process.cwd(), dir));
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.tsx?$/.test(entry.name)) files.push(full);
			}
		};
		for (const root of roots) if (fs.existsSync(root)) walk(root);
		const dictionary = DICTIONARIES["zh-CN"] ?? {};
		const missing = new Set<string>();
		for (const file of files) {
			// The dictionary itself and this test's own fixtures are not sources.
			if (file.includes(path.join("src", "core", "i18n"))) continue;
			const text = fs.readFileSync(file, "utf8");
			for (const match of text.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
				const literal = JSON.parse('"' + match[1] + '"') as string;
				if (!(literal in dictionary)) missing.add(path.relative(process.cwd(), file) + " → " + JSON.stringify(literal));
			}
		}
		assert.deepEqual([...missing].sort(), [], "untranslated UI literals (add them to src/core/i18n/zh-CN)");
	});
});

describe("the language setting", () => {
	it("factory default is English; an absent key resolves to it", () => {
		assert.equal(FACTORY_SETTINGS.general.language, "en");
		assert.equal(resolveSettings(null).general.language, "en");
		assert.equal(resolveSettings({ version: 1 }).general.language, "en");
	});

	it("read side is tolerant: aliases resolve, junk drops back to English", () => {
		assert.equal(sanitizeUserSettings({ version: 1, general: { language: "zh-CN" } })?.general?.language, "zh-CN");
		assert.equal(sanitizeUserSettings({ version: 1, general: { language: "zh" } })?.general?.language, "zh-CN");
		assert.equal(sanitizeUserSettings({ version: 1, general: { language: "klingon" } })?.general?.language, undefined);
		assert.equal(resolveSettings(sanitizeUserSettings({ version: 1, general: { language: "zh-Hans" } })).general.language, "zh-CN");
	});

	it("write side is strict: only registered ids pass the PUT parser", () => {
		assert.deepEqual(parseGeneralSettingsBody({ language: "zh-CN" }), { ok: true, settings: { language: "zh-CN" } });
		const rejected = parseGeneralSettingsBody({ language: "zh" });
		assert.equal(rejected.ok, false);
		if (!rejected.ok) assert.match(rejected.error, /language must be/);
		assert.equal(parseGeneralSettingsBody({ autoUpdate: false }).ok, true);
	});
});
