/** Pins RTL-script letter detection, direction outside math/code, the letter-only
 * direction of already-parsed text, exact LTR run boundaries (a run continues
 * over anything but a strong right-to-left character or a line break and is
 * trimmed at its two ends: balanced brackets and quotes, glued signs, sentence
 * punctuation, URLs, combining marks, lossless segmentation) and phrases across
 * inline markup. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BREAK_TEXT, LITERAL_TEXT, hasRtlLetter, letterDirection, ltrPhrases, ltrRuns, proseDirection, textDirection } from "../src/core/bidi.ts";
import type { BidiSegment, InlinePart, Phrase } from "../src/core/bidi.ts";

const rtl = (text: string): BidiSegment => ({ text, ltr: false });
const ltr = (text: string): BidiSegment => ({ text, ltr: true });

const cases: Array<{ name: string; text: string; direction: "rtl" | "ltr" | undefined; runs: BidiSegment[] }> = [
	{ name: "English first", text: "Newton's law ينص على أن...", direction: "rtl", runs: [ltr("Newton's law"), rtl(" ينص على أن...")] },
	{ name: "English bullet", text: "- Newton's law ينص على أن...", direction: "rtl", runs: [rtl("- "), ltr("Newton's law"), rtl(" ينص على أن...")] },
	{ name: "Western number first", text: "3 طرق لحل...", direction: "rtl", runs: [ltr("3"), rtl(" طرق لحل...")] },
	{ name: "math first, read as literal text", text: "$x^2$ هو مربع x", direction: "rtl", runs: [ltr("$x^2"), rtl("$ هو مربع "), ltr("x")] },
	{ name: "parenthesized Arabic first", text: "(تعريف) ...", direction: "rtl", runs: [rtl("(تعريف) ...")] },
	{ name: "symbol first", text: "- تعريف...", direction: "rtl", runs: [rtl("- تعريف...")] },
	{ name: "symbols alone inherit", text: "- ...", direction: undefined, runs: [rtl("- ...")] },
	{ name: "C++ and C#", text: "لغة C++ ولغة C#", direction: "rtl", runs: [rtl("لغة "), ltr("C++"), rtl(" ولغة "), ltr("C#")] },
	{ name: "function at sentence end", text: "الدالة f(x).", direction: "rtl", runs: [rtl("الدالة "), ltr("f(x)"), rtl(".")] },
	{ name: "balanced term parentheses", text: "المشتقة (derivative)", direction: "rtl", runs: [rtl("المشتقة "), ltr("(derivative)")] },
	{ name: "Arabic comma", text: "الكلمة English،", direction: "rtl", runs: [rtl("الكلمة "), ltr("English"), rtl("،")] },
	{ name: "Arabic question mark", text: "هل English؟", direction: "rtl", runs: [rtl("هل "), ltr("English"), rtl("؟")] },
	{ name: "Arabic semicolon", text: "الكلمة word؛", direction: "rtl", runs: [rtl("الكلمة "), ltr("word"), rtl("؛")] },
	{ name: "English only", text: "Newton's law.", direction: "ltr", runs: [ltr("Newton's law"), rtl(".")] },
	{ name: "math only inherits", text: "$x$", direction: undefined, runs: [ltr("$x"), rtl("$")] },
	{ name: "empty inherits", text: "", direction: undefined, runs: [] },
	{ name: "internal dots", text: "استخدم Node.js هنا", direction: "rtl", runs: [rtl("استخدم "), ltr("Node.js"), rtl(" هنا")] },
	{ name: "decimal", text: "القيمة 3.14.", direction: "rtl", runs: [rtl("القيمة "), ltr("3.14"), rtl(".")] },
	{ name: "plain equation", text: "إذا x = 5 إذن", direction: "rtl", runs: [rtl("إذا "), ltr("x = 5"), rtl(" إذن")] },
	{ name: "unbalanced opening bracket", text: "f(x عربي", direction: "rtl", runs: [ltr("f"), rtl("("), ltr("x"), rtl(" عربي")] },
	{ name: "Arabic-Indic digits are not runs", text: "١٢٣", direction: undefined, runs: [rtl("١٢٣")] },
	{ name: "Arabic-Indic digits end a run", text: "١٢٣ x ١٢٣", direction: "ltr", runs: [rtl("١٢٣ "), ltr("x"), rtl(" ١٢٣")] },
	{ name: "tatweel and tashkeel", text: "الـمُشْتَقَّة", direction: "rtl", runs: [rtl("الـمُشْتَقَّة")] },
	{ name: "Latin with em dash", text: "English—text عربي", direction: "rtl", runs: [ltr("English—text"), rtl(" عربي")] },
	{ name: "Latin with double quotes takes the pair", text: 'قال "English" هنا', direction: "rtl", runs: [rtl("قال "), ltr('"English"'), rtl(" هنا")] },
	{ name: "Latin with curly quotes takes the pair", text: "قال “English” هنا", direction: "rtl", runs: [rtl("قال "), ltr("“English”"), rtl(" هنا")] },
	{ name: "Latin with single quotes takes the pair", text: "قال 'quoted text' هنا", direction: "rtl", runs: [rtl("قال "), ltr("'quoted text'"), rtl(" هنا")] },
	{ name: "Latin with curly single quotes takes the pair", text: "قال ‘quoted text’ هنا", direction: "rtl", runs: [rtl("قال "), ltr("‘quoted text’"), rtl(" هنا")] },
	{ name: "an apostrophe inside quotes", text: "قال 'it's' هنا", direction: "rtl", runs: [rtl("قال "), ltr("'it's'"), rtl(" هنا")] },
	{ name: "a possessive apostrophe stays with its word; nothing opened it", text: "the students' ينص", direction: "rtl", runs: [ltr("the students'"), rtl(" ينص")] },
	{ name: "a quoted URL takes the pair", text: "الرابط 'https://x.test' هنا", direction: "rtl", runs: [rtl("الرابط "), ltr("'https://x.test'"), rtl(" هنا")] },
	{ name: "an unmatched opening quote stays out", text: 'قال "English هنا', direction: "rtl", runs: [rtl('قال "'), ltr("English"), rtl(" هنا")] },
	{ name: "technical symbols", text: "القيمة a_b/c\\d & x*2 < y > z: 50%.", direction: "rtl", runs: [rtl("القيمة "), ltr("a_b/c\\d & x*2 < y > z: 50%"), rtl(".")] },
	{ name: "nested brackets", text: "قيمة f([x])", direction: "rtl", runs: [rtl("قيمة "), ltr("f([x])")] },
	{ name: "spaces inside balanced brackets", text: "قيمة ( derivative )", direction: "rtl", runs: [rtl("قيمة "), ltr("( derivative )")] },
	{ name: "mismatched brackets stay outside", text: "قيمة [(x])", direction: "rtl", runs: [rtl("قيمة [("), ltr("x"), rtl("])")] },
	{ name: "unbalanced closing bracket", text: "قيمة x)", direction: "rtl", runs: [rtl("قيمة "), ltr("x"), rtl(")")] },
	{
		name: "sentence punctuation between English words stays in the run; Arabic punctuation after it stays out",
		text: "قال word. word, word; word: word! word? word؛",
		direction: "rtl",
		runs: [rtl("قال "), ltr("word. word, word; word: word! word? word"), rtl("؛")],
	},
	{ name: "a trailing comma stays out", text: "Newton, ينص", direction: "rtl", runs: [ltr("Newton"), rtl(", ينص")] },
	{ name: "a thousands separator stays in the number", text: "القيمة 1,000 هنا", direction: "rtl", runs: [rtl("القيمة "), ltr("1,000"), rtl(" هنا")] },
	{ name: "two thousands separators", text: "1,000,000 ينص", direction: "rtl", runs: [ltr("1,000,000"), rtl(" ينص")] },
	{ name: "a comma between English words", text: "Hello, world ينص", direction: "rtl", runs: [ltr("Hello, world"), rtl(" ينص")] },
	{ name: "a comma between names", text: "Newton, Einstein ينص", direction: "rtl", runs: [ltr("Newton, Einstein"), rtl(" ينص")] },
	{ name: "a comma between function arguments", text: "f(x, y) ينص", direction: "rtl", runs: [ltr("f(x, y)"), rtl(" ينص")] },
	{ name: "a caret in an equation", text: "f(x) = x^2 ينص", direction: "rtl", runs: [ltr("f(x) = x^2"), rtl(" ينص")] },
	{ name: "an email address", text: "a@b.com ينص", direction: "rtl", runs: [ltr("a@b.com"), rtl(" ينص")] },
	{ name: "a call with a string argument", text: 'print("hi") ينص', direction: "rtl", runs: [ltr('print("hi")'), rtl(" ينص")] },
	{ name: "a pipe", text: "a|b ينص", direction: "rtl", runs: [ltr("a|b"), rtl(" ينص")] },
	{ name: "a times sign", text: "a × b ينص", direction: "rtl", runs: [ltr("a × b"), rtl(" ينص")] },
	{ name: "a relation symbol", text: "x ≥ 2 ينص", direction: "rtl", runs: [ltr("x ≥ 2"), rtl(" ينص")] },
	{ name: "a superscript ends the run", text: "x² ينص", direction: "rtl", runs: [ltr("x²"), rtl(" ينص")] },
	{ name: "a subscript inside the run", text: "H₂O ينص", direction: "rtl", runs: [ltr("H₂O"), rtl(" ينص")] },
	{ name: "a no-break space joins two words", text: "Newton\u00A0law ينص", direction: "rtl", runs: [ltr("Newton\u00A0law"), rtl(" ينص")] },
	{ name: "a date", text: "التاريخ 2026-10-29 اليوم", direction: "rtl", runs: [rtl("التاريخ "), ltr("2026-10-29"), rtl(" اليوم")] },
	{ name: "a time", text: "الوقت 10:30 صباحا", direction: "rtl", runs: [rtl("الوقت "), ltr("10:30"), rtl(" صباحا")] },
	{ name: "a version", text: "إصدار v1.2.3 هنا", direction: "rtl", runs: [rtl("إصدار "), ltr("v1.2.3"), rtl(" هنا")] },
	{ name: "a glued minus sign", text: "قيمة -5 هنا", direction: "rtl", runs: [rtl("قيمة "), ltr("-5"), rtl(" هنا")] },
	{ name: "a glued plus sign", text: "قيمة +5 هنا", direction: "rtl", runs: [rtl("قيمة "), ltr("+5"), rtl(" هنا")] },
	{ name: "a glued dollar sign", text: "המחיר $100 כאן", direction: "rtl", runs: [rtl("המחיר "), ltr("$100"), rtl(" כאן")] },
	{ name: "a glued sign inside brackets", text: "قيمة (-5) هنا", direction: "rtl", runs: [rtl("قيمة "), ltr("(-5)"), rtl(" هنا")] },
	{ name: "a leading slash", text: "المسار /usr/bin هنا", direction: "rtl", runs: [rtl("المسار "), ltr("/usr/bin"), rtl(" هنا")] },
	{ name: "a leading dot", text: "منصة .NET هنا", direction: "rtl", runs: [rtl("منصة "), ltr(".NET"), rtl(" هنا")] },
	{ name: "a leading hash", text: "وسم #tag هنا", direction: "rtl", runs: [rtl("وسم "), ltr("#tag"), rtl(" هنا")] },
	{ name: "a sign after a space stays out", text: "قيمة - 5 هنا", direction: "rtl", runs: [rtl("قيمة - "), ltr("5"), rtl(" هنا")] },
	{ name: "a hyphen glued to a Hebrew prefix stays with the prefix", text: "מבוא ל-Python", direction: "rtl", runs: [rtl("מבוא ל-"), ltr("Python")] },
	{ name: "a slash glued to an Arabic word stays with the word", text: "كتاب/English هنا", direction: "rtl", runs: [rtl("كتاب/"), ltr("English"), rtl(" هنا")] },
	{ name: "Hebrew with an English term", text: "המונח (derivative) בעברית", direction: "rtl", runs: [rtl("המונח "), ltr("(derivative)"), rtl(" בעברית")] },
	{ name: "Hebrew with vowel points", text: "שָׁלוֹם derivative בעברית", direction: "rtl", runs: [rtl("שָׁלוֹם "), ltr("derivative"), rtl(" בעברית")] },
	{ name: "Persian sentence", text: "این یک تابع است", direction: "rtl", runs: [rtl("این یک تابع است")] },
	{ name: "Persian digits end a run", text: "مقدار x ۱۲۳ است", direction: "rtl", runs: [rtl("مقدار "), ltr("x"), rtl(" ۱۲۳ است")] },
	{ name: "Urdu sentence", text: "یہ ایک فنکشن ہے", direction: "rtl", runs: [rtl("یہ ایک فنکشن ہے")] },
	{ name: "an emoji is no run and ends none", text: "كلمة 😀 Hello 😀 World هنا", direction: "rtl", runs: [rtl("كلمة 😀 "), ltr("Hello 😀 World"), rtl(" هنا")] },
	{ name: "Greek run in Arabic", text: "القيمة α = 5 هنا", direction: "rtl", runs: [rtl("القيمة "), ltr("α = 5"), rtl(" هنا")] },
	{ name: "Cyrillic and CJK runs; an Arabic comma between them is a neutral", text: "كلمة Пример، 中文 و𠀀.", direction: "rtl", runs: [rtl("كلمة "), ltr("Пример، 中文"), rtl(" و"), ltr("𠀀"), rtl(".")] },
	{ name: "URL with query and fragment is one run", text: "رابط https://example.com/a?x=1&y=2#top هنا", direction: "rtl", runs: [rtl("رابط "), ltr("https://example.com/a?x=1&y=2#top"), rtl(" هنا")] },
	{ name: "URL keeps its trailing slash", text: "زر www.example.com/ الآن", direction: "rtl", runs: [rtl("زر "), ltr("www.example.com/"), rtl(" الآن")] },
	{ name: "sentence punctuation after a URL stays out", text: "انظر https://example.com/a?x=1. ثم https://a.com/x، ثم", direction: "rtl", runs: [rtl("انظر "), ltr("https://example.com/a?x=1"), rtl(". ثم "), ltr("https://a.com/x"), rtl("، ثم")] },
	{ name: "a URL in brackets keeps the pair", text: "الرابط (https://example.com/x) هنا", direction: "rtl", runs: [rtl("الرابط "), ltr("(https://example.com/x)"), rtl(" هنا")] },
	{ name: "balanced brackets inside a URL stay in it", text: "انظر https://en.wikipedia.org/wiki/Foo_(bar). ثم", direction: "rtl", runs: [rtl("انظر "), ltr("https://en.wikipedia.org/wiki/Foo_(bar)"), rtl(". ثم")] },
	{ name: "a URL joins the English around it", text: "زر visit https://a.com/b?c=1 now ثم", direction: "rtl", runs: [rtl("زر "), ltr("visit https://a.com/b?c=1 now"), rtl(" ثم")] },
	{ name: "a URL keeps a right-to-left path segment", text: "رابط https://ar.wikipedia.org/wiki/فيزياء هنا", direction: "rtl", runs: [rtl("رابط "), ltr("https://ar.wikipedia.org/wiki/فيزياء"), rtl(" هنا")] },
	{ name: "an Arabic comma after a right-to-left path stays out", text: "https://ar.wikipedia.org/wiki/فيزياء، ثم", direction: "rtl", runs: [ltr("https://ar.wikipedia.org/wiki/فيزياء"), rtl("، ثم")] },
	{ name: "an Arabic question mark after a right-to-left path stays out", text: "هل زرت https://ar.wikipedia.org/wiki/فيزياء؟", direction: "rtl", runs: [rtl("هل زرت "), ltr("https://ar.wikipedia.org/wiki/فيزياء"), rtl("؟")] },
	{ name: "Latin sentence punctuation after a right-to-left path stays out", text: "هل https://ar.wikipedia.org/wiki/فيزياء?! نعم", direction: "rtl", runs: [rtl("هل "), ltr("https://ar.wikipedia.org/wiki/فيزياء"), rtl("?! نعم")] },
	{ name: "a right-to-left path in brackets keeps the pair", text: "الرابط (https://ar.wikipedia.org/wiki/فيزياء) هنا", direction: "rtl", runs: [rtl("الرابط "), ltr("(https://ar.wikipedia.org/wiki/فيزياء)"), rtl(" هنا")] },
	{ name: "a URL that is the whole text is one run", text: "https://ar.wikipedia.org/wiki/فيزياء", direction: "rtl", runs: [ltr("https://ar.wikipedia.org/wiki/فيزياء")] },
	{ name: "a URL that opens the text ends at the space", text: "https://example.com/path?q=1#frag هنا.", direction: "rtl", runs: [ltr("https://example.com/path?q=1#frag"), rtl(" هنا.")] },
	{ name: "a mailto address is a URL", text: "راسل mailto:a@example.com، ثم", direction: "rtl", runs: [rtl("راسل "), ltr("mailto:a@example.com"), rtl("، ثم")] },
	{ name: "a tel number is a URL", text: "اتصل tel:+1-555-0100 الآن", direction: "rtl", runs: [rtl("اتصل "), ltr("tel:+1-555-0100"), rtl(" الآن")] },
	{ name: "a combining accent stays with its letter", text: "قيمة é هنا", direction: "rtl", runs: [rtl("قيمة "), ltr("é"), rtl(" هنا")] },
	{ name: "a combining accent stays at the run end", text: "قيمة café", direction: "rtl", runs: [rtl("قيمة "), ltr("café")] },
	{ name: "a line break ends a run", text: "one\ntwo", direction: "ltr", runs: [ltr("one"), rtl("\n"), ltr("two")] },
];

describe("bidi content rules", () => {
	for (const { name, text, direction, runs } of cases) {
		it(name, () => {
			assert.equal(textDirection(text), direction);
			assert.deepEqual(ltrRuns(text), runs);
			assert.equal(ltrRuns(text).map((part) => part.text).join(""), text);
		});
	}

	it("detects Arabic script letters, excluding digits, marks and tatweel alone", () => {
		for (const text of ["أ", "پ", "ݐ", "ࢠ", "ﭐ", "ﺍ"]) assert.equal(hasRtlLetter(text), true, text);
		for (const text of ["", "Latin", "١٢٣", "ـ", "َِّ", "،؛؟"]) assert.equal(hasRtlLetter(text), false, text);
	});

	it("detects letters in every registered RTL script, including supplementary scripts", () => {
		for (const letter of ["א", "ܐ", "ހ", "ߊ", "ࠀ", "ࡀ", "\u{1E900}", "\u{10D00}"]) {
			assert.equal(hasRtlLetter(letter), true, letter);
			assert.equal(textDirection(letter), "rtl", letter);
			assert.deepEqual(ltrRuns(`α ${letter}`), [ltr("α"), rtl(` ${letter}`)]);
		}
		for (const text of ["α", "Я", "中", "𠀀", "ְ", "\u{1E950}"]) assert.equal(hasRtlLetter(text), false, text);
		for (const letter of ["\u{10E80}", "\u{10A60}", "\u{1E900}"]) assert.equal(hasRtlLetter(letter), true, letter);
		assert.equal(hasRtlLetter("ـ"), false);
	});

	it("ignores Arabic inside all four math delimiters and backtick code", () => {
		for (const text of ["$عربي$", "$$عربي$$", "\\(عربي\\)", "\\[عربي\\]", "`عربي`", "``a ` عربي``", "```ts\nعربي\n```"]) {
			assert.equal(textDirection(text), undefined, text);
			assert.equal(textDirection(`English ${text}`), "ltr", text);
			assert.equal(textDirection(`${text} نص`), "rtl", text);
		}
	});

	it("does not turn escaped math delimiters into math", () => {
		assert.equal(textDirection("\\$عربي\\$"), "rtl");
		assert.equal(textDirection("\\\\(عربي\\\\)"), "rtl");
	});

	it("a backslash inside code is a character, so the backtick after it still closes the span", () => {
		assert.equal(textDirection("`\\` عربي `x`"), "rtl");
		assert.equal(textDirection("`\\\\` عربي `x`"), "rtl");
	});

	it("an escaped backtick outside code opens nothing, and an escaped backslash leaves its backtick a delimiter", () => {
		assert.equal(textDirection("\\` عربي ` x `"), "rtl");
		assert.equal(textDirection("\\\\`عربي`"), undefined);
	});
});

describe("letterDirection: the letters of already-parsed text", () => {
	it("any right-to-left letter gives rtl, else any letter ltr, else undefined", () => {
		assert.equal(letterDirection("Newton ينص"), "rtl");
		assert.equal(letterDirection("Newton"), "ltr");
		assert.equal(letterDirection("42 - ..."), undefined);
		assert.equal(letterDirection(""), undefined);
	});

	it("a tatweel is no letter: alone it inherits, as it does for hasRtlLetter and ltrRuns", () => {
		assert.equal(letterDirection("ـ"), undefined);
		assert.equal(letterDirection("ـ عربي"), "rtl");
		assert.equal(letterDirection("ـ abc"), "ltr");
	});

	it("parses no delimiters: dollar signs and backticks are plain characters", () => {
		assert.equal(letterDirection("English $عربي$"), "rtl");
		assert.equal(letterDirection("`عربي`"), "rtl");
		assert.equal(letterDirection("$x$"), "ltr");
		// The same text as raw Markdown has math and code removed first.
		assert.equal(textDirection("English $عربي$"), "ltr");
		assert.equal(textDirection("$x$"), undefined);
		assert.equal(letterDirection("$عربي$"), "rtl");
		assert.equal(textDirection("$عربي$"), undefined);
	});

	it("two dollar amounts around Arabic never swallow it, however the text grows", () => {
		const grown = ["$5", "$5\nعربي", "$5\nعربي\n$", "$5\nعربي\n$10"];
		assert.deepEqual(grown.map(letterDirection), [undefined, "rtl", "rtl", "rtl"]);
		assert.equal(textDirection(grown[3]!), undefined, "as raw Markdown the pair is math and hides the Arabic");
	});
});

describe("proseDirection: the letters of prose, a URL read as left-to-right", () => {
	it("a right-to-left path segment does not turn an English sentence right-to-left", () => {
		const text = "See https://ar.wikipedia.org/wiki/فيزياء for details.";
		assert.equal(proseDirection(text), "ltr");
		assert.equal(letterDirection(text), "rtl", "the letters alone would");
	});

	it("Arabic prose around a URL is still right-to-left, and a URL alone is left-to-right", () => {
		assert.equal(proseDirection("رابط https://ar.wikipedia.org/wiki/فيزياء هنا"), "rtl");
		assert.equal(proseDirection("https://ar.wikipedia.org/wiki/فيزياء"), "ltr");
		assert.equal(proseDirection("42"), undefined);
	});
});

describe("ltrPhrases: runs across inline markup", () => {
	const text = (value: string): InlinePart => ({ text: value, atomic: false });
	const atom = (value: string): InlinePart => ({ text: value, atomic: true });
	const phrase = (isLtr: boolean, ...slices: Array<[number, number, number]>): Phrase => ({
		ltr: isLtr,
		slices: slices.map(([part, from, to]) => ({ part, from, to })),
	});

	it("one text part gives exactly the runs of ltrRuns", () => {
		for (const { name, text: value } of cases) {
			const phrases = ltrPhrases([text(value)]);
			const read = phrases.map(({ ltr: isLtr, slices }) => ({ text: slices.map(({ from, to }) => value.slice(from, to)).join(""), ltr: isLtr }));
			assert.deepEqual(read, ltrRuns(value), name);
		}
	});

	it("English text and bold English are one phrase, in logical order", () => {
		assert.deepEqual(
			ltrPhrases([text("Newton's "), atom("second law"), text(" ينص")]),
			[phrase(true, [0, 0, 9], [1, 0, 10]), phrase(false, [2, 0, 4])],
		);
	});

	it("a symbol or a bracket next to a bold run belongs to it", () => {
		assert.deepEqual(ltrPhrases([text("تعلم "), atom("C"), text("++")]), [phrase(false, [0, 0, 5]), phrase(true, [1, 0, 1], [2, 0, 2])]);
		assert.deepEqual(ltrPhrases([text("النسبة "), atom("50"), text("%")]), [phrase(false, [0, 0, 7]), phrase(true, [1, 0, 2], [2, 0, 1])]);
		assert.deepEqual(
			ltrPhrases([text("المشتقة ("), atom("derivative"), text(")")]),
			[phrase(false, [0, 0, 8]), phrase(true, [0, 8, 9], [1, 0, 10], [2, 0, 1])],
		);
	});

	it("an Arabic comma between two English atoms stays in the phrase, as a neutral between two left-to-right pieces", () => {
		assert.deepEqual(
			ltrPhrases([atom("Python"), text("، "), atom("Java")]),
			[phrase(true, [0, 0, 6], [1, 0, 2], [2, 0, 4])],
		);
	});

	it("Arabic text between two atoms ends the phrase", () => {
		assert.deepEqual(
			ltrPhrases([atom("Python"), text(" و"), atom("Java")]),
			[phrase(true, [0, 0, 6]), phrase(false, [1, 0, 2]), phrase(true, [2, 0, 4])],
		);
	});

	it("code and math read as one letter, so English between two of them joins all three", () => {
		assert.deepEqual(
			ltrPhrases([text("الدالة "), atom(LITERAL_TEXT), text(" and "), atom(LITERAL_TEXT), text(" متساويتان")]),
			[phrase(false, [0, 0, 7]), phrase(true, [1, 0, 1], [2, 0, 5], [3, 0, 1]), phrase(false, [4, 0, 10])],
		);
	});

	it("a break ends every run", () => {
		assert.deepEqual(
			ltrPhrases([text("one"), atom(BREAK_TEXT), text("two")]),
			[phrase(true, [0, 0, 3]), phrase(false, [1, 0, 1]), phrase(true, [2, 0, 3])],
		);
	});

	it("an atom of right-to-left text stays outside and ends the phrases around it", () => {
		assert.deepEqual(
			ltrPhrases([text("English "), atom("عربي"), text(" more")]),
			[phrase(true, [0, 0, 7]), phrase(false, [0, 7, 8], [1, 0, 4], [2, 0, 1]), phrase(true, [2, 1, 5])],
		);
	});

	it("an atom with a strong right-to-left character that sticks out of a run keeps that run unisolated: it is a context of its own", () => {
		assert.deepEqual(
			ltrPhrases([text("Newton's "), atom("second law ينص")]),
			[phrase(false, [0, 0, 9], [1, 0, 14])],
		);
		assert.deepEqual(ltrPhrases([text("قيمة "), atom("C ينص"), text(" هنا")]), [phrase(false, [0, 0, 5], [1, 0, 5], [2, 0, 4])]);
		// The same set that ends a run: Arabic punctuation of class AL counts, a letter is not required.
		assert.deepEqual(ltrPhrases([text("Newton "), atom("law؟"), text(" ينص")]), [phrase(false, [0, 0, 7], [1, 0, 4], [2, 0, 4])]);
	});

	it("an atom without a strong right-to-left character that sticks out of a run extends the run over the whole atom", () => {
		// `Newton [law.](…) ينص`: the run `Newton law` stops before the period inside the link.
		assert.deepEqual(
			ltrPhrases([text("Newton "), atom("law."), text(" ينص")]),
			[phrase(true, [0, 0, 7], [1, 0, 4]), phrase(false, [2, 0, 4])],
		);
		// The run starts inside the atom: it extends back to the atom's start.
		assert.deepEqual(
			ltrPhrases([atom(", Newton"), text(" law ينص")]),
			[phrase(true, [0, 0, 8], [1, 0, 4]), phrase(false, [1, 4, 8])],
		);
	});

	it("two runs that one atom sticks out of merge into one phrase", () => {
		assert.deepEqual(ltrPhrases([text("a"), atom("b\nc"), text("d")]), [phrase(true, [0, 0, 1], [1, 0, 3], [2, 0, 1])]);
	});

	it("an empty atom is inside a run only strictly between its ends", () => {
		assert.deepEqual(ltrPhrases([text("a"), atom(""), text("b")]), [phrase(true, [0, 0, 1], [1, 0, 0], [2, 0, 1])]);
		assert.deepEqual(ltrPhrases([atom(""), text("ab")]), [phrase(false, [0, 0, 0]), phrase(true, [1, 0, 2])]);
		assert.deepEqual(ltrPhrases([text("ab"), atom("")]), [phrase(true, [0, 0, 2]), phrase(false, [1, 0, 0])]);
	});

	it("a URL split by markup is still one phrase", () => {
		const url = "https://example.com/a?x=1&y=2";
		assert.deepEqual(
			ltrPhrases([text("رابط "), atom(url), text(" هنا")]),
			[phrase(false, [0, 0, 5]), phrase(true, [1, 0, url.length]), phrase(false, [2, 0, 4])],
		);
	});

	it("no parts, no phrases", () => {
		assert.deepEqual(ltrPhrases([]), []);
	});
});
