/**
 * The language directive (i18n foundation, 2026-11-19): a Chinese app
 * composes ONE extra appendix that makes the agents teach in Simplified
 * Chinese, while the English composition stays byte-identical to the
 * pre-i18n prompts (the doctrine sources are English and are NOT
 * duplicated). Data-dir isolation mirrors prompt-overrides.test.ts: the
 * agent modules load config.ts, which evaluates LH_DATA_DIR at module load.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-i18n-prompts-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { composeSideChatInstructions } = await import("../src/agent/side-chat.ts");
const { languageDirective } = await import("../src/agent/prompt-language.ts");

describe("the agent language directive", () => {
	it("is empty for English — the composed prompts are unchanged", () => {
		assert.equal(languageDirective("en"), "");
		for (const kind of ["prober", "teacher", "practice"] as const) {
			assert.equal(composeInstructions(kind, {}, "en"), composeInstructions(kind));
			assert.ok(!composeInstructions(kind, {}, "en").includes("Teaching language"));
		}
	});

	it("appends a Simplified Chinese instruction without touching the doctrine", () => {
		const english = composeInstructions("teacher");
		const chinese = composeInstructions("teacher", {}, "zh-CN");
		assert.ok(chinese.includes("简体中文"), "the directive does not name the language");
		assert.ok(chinese.endsWith(languageDirective("zh-CN").trim()), "the directive is not the appendix");
		// The doctrine stayed English and intact: dropping the appendix yields
		// exactly the English composition.
		const withoutDirective = chinese.slice(0, chinese.length - languageDirective("zh-CN").trim().length).replace(/\n\n---\n\n$/, "");
		assert.equal(withoutDirective, english);
	});

	it("keeps tool names, identifiers and math delimiters verbatim", () => {
		const chinese = composeInstructions("prober", {}, "zh-CN");
		for (const identifier of ["probe_done", "plan_init", "$...$"]) {
			if (!composeInstructions("prober").includes(identifier)) continue;
			assert.ok(chinese.includes(identifier), "identifier lost: " + identifier);
		}
	});

	it("applies to side questions too", () => {
		assert.ok(!composeSideChatInstructions({}).includes("简体中文"));
		assert.ok(composeSideChatInstructions({}, "zh-CN").includes("简体中文"));
	});
});
