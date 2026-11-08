import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE, LOCALES, dirOf, isLocale, resolveLocale } from "../lib/i18n/locales.ts";
import { en } from "../lib/i18n/messages/en.ts";
import { fa } from "../lib/i18n/messages/fa.ts";
import { formatNumber, translate } from "../lib/i18n/translate.ts";

const slots = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");

describe("i18n catalogs", () => {
	it("fa has exactly the keys en has", () => {
		assert.deepEqual(Object.keys(fa).sort(), Object.keys(en).sort());
	});
	it("every {slot} in en appears in fa, and vice versa", () => {
		for (const key of Object.keys(en) as Array<keyof typeof en>) {
			assert.equal(slots(fa[key]), slots(en[key]), key);
		}
	});
	it("no fa message is empty", () => {
		for (const [key, value] of Object.entries(fa)) assert.ok(value.trim().length > 0, key);
	});
});

describe("locale helpers", () => {
	it("fa is RTL, en is LTR", () => {
		assert.equal(dirOf("fa"), "rtl");
		assert.equal(dirOf("en"), "ltr");
	});
	it("unknown values fall back to the default locale", () => {
		assert.equal(resolveLocale("de"), DEFAULT_LOCALE);
		assert.equal(resolveLocale(undefined), DEFAULT_LOCALE);
		assert.equal(resolveLocale("fa"), "fa");
		assert.equal(isLocale("fa") && LOCALES.includes("fa"), true);
	});
});

describe("translate", () => {
	it("interpolates and leaves unknown slots intact", () => {
		assert.equal(translate("en", "time.minutesAgo", { n: 5 }), "5m ago");
		assert.equal(translate("en", "time.minutesAgo"), "{n}m ago");
	});
	it("formats Persian digits for fa and plain digits for en", () => {
		assert.equal(formatNumber("fa", 5), "۵");
		assert.equal(formatNumber("en", 12345), "12345");
	});
	it("translates into Persian", () => {
		assert.equal(translate("fa", "settings.title"), "تنظیمات");
	});
});
