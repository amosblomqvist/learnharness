/** Pins Unicode search folding, script equivalences and original UTF-16 spans
 * through decomposition, removed marks, ignorables and case expansion. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeForSearch, normalizeWithMap } from "../src/core/text-search.ts";

describe("normalizeForSearch", () => {
	it("lowercases and folds accents while preserving English spacing and symbols", () => {
		assert.equal(normalizeForSearch("Node.js C++ 3.14 ÉCOLE\n  API"), "node.js c++ 3.14 ecole\n  api");
		assert.equal(normalizeForSearch("ΟΣ"), "οσ");
	});

	it("maps a final sigma to the medial form, so lowercase context never splits a word", () => {
		assert.equal(normalizeForSearch("ΟΔΟΣ"), "οδοσ");
		assert.equal(normalizeForSearch("οδός"), "οδοσ");
	});

	it("lowercases again after compatibility decomposition", () => {
		assert.equal(normalizeForSearch("𝐀bc"), "abc");
		assert.equal(normalizeForSearch("x ∈ ℝ"), "x ∈ r");
		assert.equal(normalizeForSearch("™"), "tm");
	});

	it("folds a spacing accent to nothing, never to a space", () => {
		for (const accent of ["´", "¨", "¸", "˜", "¯", "\uFE70", "\uFE76"]) assert.equal(normalizeForSearch(accent), "", accent);
		assert.equal(normalizeForSearch("a´b"), "ab");
		assert.equal(normalizeForSearch("a b"), "a b");
	});

	it("keeps marks that are part of the letter in kana, Indic and Thai text, and recomposes them", () => {
		for (const [a, b] of [["バス", "ハス"], ["がん", "かん"], ["पानी", "पन"], ["हिन्दी", "हनद"], ["กี่", "ก"]] as const) {
			assert.notEqual(normalizeForSearch(a), normalizeForSearch(b), `${a} is not ${b}`);
		}
		assert.equal(normalizeForSearch("ハ\u3099ス"), "バス");
		assert.equal(normalizeForSearch("ﾊﾞｽ"), "バス");
		assert.equal(normalizeForSearch("हिन्दी"), "हिन्दी");
		// Marks that are accents still go: tashkeel, niqqud and Latin diacritics.
		assert.equal(normalizeForSearch("أَحْمَدُ"), "احمد");
		assert.equal(normalizeForSearch("café ñ ạ"), "cafe n a");
	});

	it("names the folding rules: accents fold, Hangul stays jamo, Arabic pairs, scripts and digits stay apart", () => {
		assert.equal(normalizeForSearch("año"), "ano");
		assert.ok(normalizeForSearch("한").startsWith(normalizeForSearch("하")), "a syllable folds to jamo, so a partial syllable is a prefix search");
		assert.notEqual(normalizeForSearch("حياة"), normalizeForSearch("حياته"));
		assert.equal(normalizeForSearch("ئ ؤ"), "ي و");
		assert.notEqual(normalizeForSearch("ک"), normalizeForSearch("ك"), "Persian kaf is not Arabic kaf");
		assert.notEqual(normalizeForSearch("ی"), normalizeForSearch("ي"), "Persian yeh is not Arabic yeh");
		assert.notEqual(normalizeForSearch("٢٠٢٦"), "2026", "digits are not folded across scripts");
	});

	it("removes the complete specified tashkeel ranges and tatweel", () => {
		const marks = Array.from({ length: 0x065F - 0x064B + 1 }, (_, i) => String.fromCharCode(0x064B + i)).join("");
		assert.equal(normalizeForSearch(`ع${marks}\u0670ـلم`), "علم");
		assert.equal(normalizeForSearch("ع\u0610ل\u06D6م"), "علم");
	});

	it("folds alef variants, alef maqsura and ta marbuta in either operand", () => {
		for (const [query, text] of [["احمد", "أَحْمَد"], ["إبراهيم", "ابراهيم"], ["آدم", "ادم"], ["ٱسم", "اسم"], ["مدرسه", "مدرسة"], ["على", "علي"]] as const) {
			assert.equal(normalizeForSearch(query), normalizeForSearch(text));
		}
	});

	it("folds hamza on a seat to its seat letter and keeps digits and the lone hamza", () => {
		assert.equal(normalizeForSearch("ؤ ئ ء ١٢٣ 123"), "و ي ء ١٢٣ 123");
		assert.equal(normalizeForSearch(""), "");
	});

	it("folds Latin accents and Hebrew niqqud through the same pipeline", () => {
		assert.equal(normalizeForSearch("café"), "cafe");
		assert.equal(normalizeForSearch("cafe\u0301"), "cafe");
		assert.equal(normalizeForSearch("שָׁלוֹם"), "שלום");
	});

	it("drops joiners, directional formatting and other default ignorables", () => {
		const ignored = "ـ\u200B\u200C\u200D\u200E\u200F\u061C\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\uFEFF\u00AD";
		assert.equal(normalizeForSearch(`a${ignored}b`), "ab");
	});

	it("decomposes compatibility characters into searchable text", () => {
		assert.equal(normalizeForSearch("ﬃ ½ ① Ａ"), "ffi 1⁄2 1 a");
	});
});

describe("normalizeWithMap", () => {
	it("maps normalized characters to original spans with trailing diacritics", () => {
		const text = "أَحْمَدُ";
		assert.deepEqual(normalizeWithMap(text), { text: "احمد", map: [0, 2, 4, 6], ends: [2, 4, 6, 8] });
	});

	it("maps tatweel and consecutive removed marks without dropping original offsets", () => {
		assert.deepEqual(normalizeWithMap("عَـِلْم"), { text: "علم", map: [0, 4, 6], ends: [4, 6, 7] });
		assert.deepEqual(normalizeWithMap("َع"), { text: "ع", map: [1], ends: [2] });
		assert.deepEqual(normalizeWithMap("َـ"), { text: "", map: [], ends: [] });
	});

	it("preserves UTF-16 indexes and maps lowercase expansion to one original character", () => {
		assert.deepEqual(normalizeWithMap("😀İأَ"), { text: "😀iا", map: [0, 1, 2, 3], ends: [1, 2, 3, 5] });
	});

	it("maps composed and decomposed Latin accents to exact original spans", () => {
		assert.deepEqual(normalizeWithMap("café"), { text: "cafe", map: [0, 1, 2, 3], ends: [1, 2, 3, 4] });
		assert.deepEqual(normalizeWithMap("cafe\u0301"), { text: "cafe", map: [0, 1, 2, 3], ends: [1, 2, 3, 5] });
	});

	it("maps every compatibility expansion unit to the complete source span", () => {
		assert.deepEqual(normalizeWithMap("ﬃ\u0301"), { text: "ffi", map: [0, 0, 0], ends: [2, 2, 2] });
		assert.deepEqual(normalizeWithMap("½"), { text: "1⁄2", map: [0, 0, 0], ends: [1, 1, 1] });
		assert.deepEqual(normalizeWithMap("\u{1D41A}"), { text: "a", map: [0], ends: [2] });
	});

	it("maps Hebrew niqqud and ignorable characters without losing source offsets", () => {
		assert.deepEqual(normalizeWithMap("שָׁלוֹם"), { text: "שלום", map: [0, 3, 4, 6], ends: [3, 4, 6, 7] });
		assert.deepEqual(normalizeWithMap("a\u200Db\u200Ec\u2066d\u2069"), { text: "abcd", map: [0, 2, 4, 6], ends: [2, 4, 6, 8] });
	});

	it("maps a recomposed kana or Indic cluster to its whole original span", () => {
		assert.deepEqual(normalizeWithMap("ハ\u3099ス"), { text: "バス", map: [0, 2], ends: [2, 3] });
		assert.deepEqual(normalizeWithMap("ﾊﾞｽ"), { text: "バス", map: [0, 2], ends: [2, 3] });
		assert.deepEqual(normalizeWithMap("हिन्दी"), { text: "हिन्दी", map: [0, 1, 2, 3, 4, 5], ends: [1, 2, 3, 4, 5, 6] });
		assert.deepEqual(normalizeWithMap("a´b"), { text: "ab", map: [0, 2], ends: [2, 3] });
	});

	it("uses the same contextual lowercase result as normalizeForSearch", () => {
		for (const text of [
			"ΟΔΟΣ", "バス ハ\u3099ス ﾊﾞｽ か゛ ゛", "हिन्दी पानी क़", "กี่ ก", "한국어", "a´b ¨ ˜", "𝐀ℝ™№", "か\u200B\u3099", "a \u0301b", "👨\u200D👩\u200D👧",
			"", "ΟΣ", "API", "عَلِيّ", "İ Σ😀 مدرسة", "cafe\u0301", "שָׁלוֹם", "각ﬃ\u0301\u{1D41A}"]) {
			const result = normalizeWithMap(text);
			assert.equal(result.text, normalizeForSearch(text));
			assert.equal(result.map.length, result.text.length);
			assert.equal(result.ends.length, result.text.length);
		}
	});
});
