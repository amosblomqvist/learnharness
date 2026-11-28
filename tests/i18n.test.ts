import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tr, uiLanguage } from "../src/core/i18n.ts";
import { OUTPUT_LANGUAGE_RULE, withOutputLanguage } from "../src/agent/output-language.ts";

describe("interface language", () => {
	it("defaults to zh; LH_LANG=en switches tr() and drops the output-language rule", () => {
		const saved = process.env.LH_LANG;
		try {
			delete process.env.LH_LANG;
			assert.equal(uiLanguage(), "zh");
			assert.equal(tr("中文", "English"), "中文");
			assert.equal(withOutputLanguage("P"), `P\n\n${OUTPUT_LANGUAGE_RULE}`);
			process.env.LH_LANG = "en";
			assert.equal(uiLanguage(), "en");
			assert.equal(tr("中文", "English"), "English");
			assert.equal(withOutputLanguage("P"), "P");
		} finally {
			if (saved === undefined) delete process.env.LH_LANG; else process.env.LH_LANG = saved;
		}
	});
});
