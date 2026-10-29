/**
 * Mixed right-to-left and left-to-right content (static render, plus one
 * client re-render for the streaming flip). Pins:
 * - markdown blocks (p, h1-h6, blockquote) take their direction from their own
 *   letters, ul/ol/table from their whole text, items and cells inherit; math
 *   and code never count and are always left-to-right;
 * - the direction of parsed text comes from its letters alone: escaped dollars
 *   and a growing `- $5`, `- عربي`, `- $10` never hide the Arabic;
 * - inside a right-to-left block every left-to-right phrase is isolated in one
 *   `<span dir="ltr">`: the runs `ltrRuns` finds over the whole inline text, so
 *   markup, math and code join them (`Newton's **second law**`, `**C**++`,
 *   `(**derivative**)`), a URL is one phrase and an accent stays with its
 *   letter; sentence punctuation ends a phrase; bold or italic that a phrase
 *   spills into or out of is cut at the phrase boundary, while a link stays
 *   whole and isolates inside itself;
 * - a block with no letters sets no `dir`; an LTR block states `dir="ltr"` only
 *   where it overrides a right-to-left flow (an Arabic block);
 * - the direction follows the text as it streams, and a block that turns
 *   right-to-left mid-stream isolates the runs of the items it already held.
 * Arabic is the tested language; one Hebrew case proves the rule is general.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { BidiText } from "../components/bidi-text.tsx";
import { hasRtlLetter, ltrRuns } from "../src/core/bidi.ts";

const escapeHtml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The markup of `text` with its left-to-right runs isolated, built straight from the core's runs. */
function isolated(text: string): string {
	return ltrRuns(text).map((run) => (run.ltr ? `<span dir="ltr">${escapeHtml(run.text)}</span>` : escapeHtml(run.text))).join("");
}

function render(md: string): string {
	return renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
}

const INLINE_CODE = '<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-sm" data-streamdown="inline-code" dir="ltr">';

describe("markdown blocks: direction from their own letters", () => {
	it("an Arabic paragraph that starts with an English word is right-to-left, with the English run isolated", () => {
		const text = "Newton law ينص على أن القوة تساوي الكتلة في التسارع.";
		const html = render(text);
		assert.ok(html.includes(`<p dir="rtl">${isolated(text)}</p>`), html);
		assert.ok(html.includes('<span dir="ltr">Newton law</span> ينص'), "the run is exactly the English words");
	});

	it("an Arabic bullet list: dir on the list, items inherit, each item isolates its own runs", () => {
		const items = ["Newton law ينص على قانون", "3 طرق لحل المسألة", "تعريف (definition) واضح"];
		const html = render(items.map((item) => `- ${item}`).join("\n"));
		assert.match(html, /<ul [^>]*data-streamdown="unordered-list" dir="rtl">/);
		for (const item of items) {
			assert.ok(html.includes(`data-streamdown="list-item">${isolated(item)}</li>`), item);
		}
		assert.ok(!/<li[^>]* dir=/.test(html), "list items carry no dir of their own");
		assert.ok(html.includes('<span dir="ltr">3</span> طرق'), "the leading number is its own run");
	});

	it("an Arabic ordered list is right-to-left as a whole", () => {
		const html = render("1. Newton law ينص\n2. ثم second law");
		assert.match(html, /<ol [^>]*data-streamdown="ordered-list" dir="rtl">/);
		assert.ok(html.includes(isolated("Newton law ينص")));
		assert.ok(html.includes(isolated("ثم second law")));
	});

	it("an Arabic heading is right-to-left and keeps Streamdown's heading look", () => {
		const text = "مقدمة Intro";
		const html = render(`## ${text}`);
		assert.match(html, /<h2 class="mt-6 mb-2 font-semibold text-2xl" data-streamdown="heading-2" dir="rtl">/);
		assert.ok(html.includes(`${isolated(text)}</h2>`));
	});

	it("an Arabic blockquote is right-to-left and stays the muted quote", () => {
		const text = "اقتباس with English";
		const html = render(`> ${text}`);
		assert.match(html, /<blockquote class="[^"]*text-muted-foreground italic" data-streamdown="blockquote" dir="rtl">/);
		assert.ok(html.includes(`<p dir="rtl">${isolated(text)}</p>`));
	});

	it("an Arabic callout box states its direction too", () => {
		const html = render("> [!IMPORTANT]\n> القاعدة مهمة (rule) جدا");
		assert.match(html, /data-testid="md-callout" data-alert-kind="important" class="[^"]*" dir="rtl"/);
		assert.ok(html.includes('<span dir="ltr">(rule)</span>'));
	});

	it("a table with an Arabic header and English cells is right-to-left; cells inherit and isolate", () => {
		const html = render("| الاسم | Value |\n|---|---|\n| نص | x |\n| text | يا |");
		assert.match(html, /data-testid="md-table" dir="rtl"/);
		assert.ok(!/<(th|td|tr|thead|tbody|table)[^>]* dir=/.test(html), "the wrapper carries the direction, the table and its cells inherit");
		assert.match(html, /data-streamdown="table-header-cell">الاسم<\/th>/);
		assert.match(html, /data-streamdown="table-header-cell"><span dir="ltr">Value<\/span><\/th>/);
		assert.match(html, /data-streamdown="table-cell"><span dir="ltr">x<\/span><\/td>/);
		assert.match(html, /data-streamdown="table-cell"><span dir="ltr">text<\/span><\/td>/);
		assert.match(html, /data-streamdown="table-cell">يا<\/td>/);
	});

	it("a Hebrew paragraph takes the same rule", () => {
		const text = "המונח (derivative) בעברית";
		const html = render(text);
		assert.ok(html.includes(`<p dir="rtl">${isolated(text)}</p>`));
		assert.ok(html.includes('<span dir="ltr">(derivative)</span>'));
	});
});

describe("markdown blocks: one phrase split across inline markup is one isolate", () => {
	const STRONG = '<strong data-streamdown="strong">';

	it("English text and bold English read as one phrase, in logical order", () => {
		const html = render("Newton's **second law** ينص على أن القوة");
		assert.ok(html.includes(`<p dir="rtl"><span dir="ltr">Newton&#x27;s ${STRONG}second law</strong></span> ينص على أن القوة</p>`), html);
	});

	it("a bullet that starts with bold English keeps the English after it in the same isolate", () => {
		const html = render("- **Big-O** notation تصف التعقيد");
		assert.ok(html.includes(`data-streamdown="list-item"><span dir="ltr">${STRONG}Big-O</strong> notation</span> تصف التعقيد</li>`), html);
	});

	it("inline math and the English between two equations form one isolate", () => {
		const html = render("الدالة $f(x)$ and $g(x)$ متساويتان");
		assert.match(html, /<p dir="rtl">الدالة <span dir="ltr"><span class="katex" dir="ltr">.*?<\/span> and <span class="katex" dir="ltr">.*?<\/span><\/span> متساويتان<\/p>/s);
		assert.equal((html.match(/<span dir="ltr"><span class="katex"/g) ?? []).length, 1, "one wrapper, not one per piece");
	});

	it("a link is isolated as a whole, and so is code next to English", () => {
		const link = render("[React docs](https://example.com) توضح");
		assert.match(link, /<p dir="rtl"><span dir="ltr"><button [^>]*data-streamdown="link"[^>]*>React docs<\/button><\/span> توضح<\/p>/);
		const code = render("اكتب `print` and `len` معا");
		assert.ok(code.includes(`<p dir="rtl">اكتب <span dir="ltr">${INLINE_CODE}print</code> and ${INLINE_CODE}len</code></span> معا</p>`), code);
	});

	it("an Arabic comma between two bold English words is a neutral: one phrase", () => {
		const html = render("مثل **Python**، **Java** وغيرهما");
		assert.ok(html.includes(`مثل <span dir="ltr">${STRONG}Python</strong>، ${STRONG}Java</strong></span> وغيرهما`), html);
	});

	it("Arabic between two bold English words ends the phrase", () => {
		const html = render("مثل **Python** و**Java** وغيرهما");
		assert.ok(html.includes(`مثل <span dir="ltr">${STRONG}Python</strong></span> و<span dir="ltr">${STRONG}Java</strong></span> وغيرهما`), html);
	});

	it("bold Arabic between English words ends both phrases and isolates inside itself", () => {
		const html = render("Newton **قانون** law and **قانون Newton**");
		assert.ok(html.includes(`<p dir="rtl"><span dir="ltr">Newton</span> ${STRONG}قانون</strong> <span dir="ltr">law and</span> ${STRONG}قانون <span dir="ltr">Newton</span></strong></p>`), html);
	});
});

describe("markdown blocks: direction from letters, not from delimiters", () => {
	it("escaped dollars are literal text, so Arabic between them still makes the block right-to-left", () => {
		const html = render("English \\$عربي\\$");
		assert.ok(html.includes(`<p dir="rtl">${isolated("English $عربي$")}</p>`), html);
	});

	it("a list with Arabic stays right-to-left while a second dollar amount arrives", () => {
		for (const md of ["- $5\n- عربي", "- $5\n- عربي\n- $", "- $5\n- عربي\n- $10"]) {
			assert.match(render(md), /<ul [^>]*data-streamdown="unordered-list" dir="rtl">/, md);
		}
	});

	it("plain text takes the same letters-only rule", () => {
		const text = "English $عربي$";
		assert.equal(renderToStaticMarkup(<BidiText text={text} />), `<span dir="rtl">${isolated(text)}</span>`);
	});
});

describe("markdown blocks: runs that cross inline markup, URLs and accents", () => {
	const STRONG = '<strong data-streamdown="strong">';

	it("a symbol after bold English belongs to it: C++", () => {
		const html = render("تعلم **C**++ الآن");
		assert.ok(html.includes(`<p dir="rtl">تعلم <span dir="ltr">${STRONG}C</strong>++</span> الآن</p>`), html);
	});

	it("a percent sign after a bold number belongs to it", () => {
		const html = render("النسبة **50**% اليوم");
		assert.ok(html.includes(`<p dir="rtl">النسبة <span dir="ltr">${STRONG}50</strong>%</span> اليوم</p>`), html);
	});

	it("brackets around a bold term stay in its isolate", () => {
		const html = render("المشتقة (**derivative**) مهمة");
		assert.ok(html.includes(`<p dir="rtl">المشتقة <span dir="ltr">(${STRONG}derivative</strong>)</span> مهمة</p>`), html);
	});

	it("bold that a phrase spills into is cut at the phrase boundary, so the phrase is one isolate", () => {
		const html = render("Newton's **second law ينص** هنا");
		assert.ok(html.includes(`<p dir="rtl"><span dir="ltr">Newton&#x27;s ${STRONG}second law</strong></span>${STRONG} ينص</strong> هنا</p>`), html);
		const raw = render("Newton's <b>law ينص</b> هنا");
		assert.ok(raw.includes(`<p dir="rtl"><span dir="ltr">Newton&#x27;s <b>law</b></span><b> ينص</b> هنا</p>`), raw);
	});

	it("bold that a phrase spills out of is cut the same way", () => {
		const html = render("**ينص Newton's** second law هنا");
		assert.ok(html.includes(`<p dir="rtl">${STRONG}ينص </strong><span dir="ltr">${STRONG}Newton&#x27;s</strong> second law</span> هنا</p>`), html);
	});

	it("italic inside cut bold stays whole in its piece, or is cut with the bold", () => {
		const whole = render("Newton's **second *law* ينص** هنا");
		assert.ok(whole.includes(`<p dir="rtl"><span dir="ltr">Newton&#x27;s ${STRONG}second <em>law</em></strong></span>${STRONG} ينص</strong> هنا</p>`), whole);
		const cut = render("Newton's **second *law ينص*** هنا");
		assert.ok(cut.includes(`<p dir="rtl"><span dir="ltr">Newton&#x27;s ${STRONG}second <em>law</em></strong></span>${STRONG}<em> ينص</em></strong> هنا</p>`), cut);
	});

	it("a link that a phrase spills into is never cut: it is a context of its own, also inside bold", () => {
		const link = render("Newton's [second law ينص](https://example.com) هنا");
		assert.match(link, /<p dir="rtl">Newton&#x27;s <button [^>]*data-streamdown="link"[^>]*><span dir="ltr">second law<\/span> ينص<\/button> هنا<\/p>/);
		const bold = render("Newton's **[second law ينص](https://example.com)** هنا");
		assert.match(bold, /<p dir="rtl">Newton&#x27;s <strong data-streamdown="strong"><button [^>]*data-streamdown="link"[^>]*><span dir="ltr">second law<\/span> ينص<\/button><\/strong> هنا<\/p>/);
	});

	it("a link that a phrase sticks out of only by the link's punctuation joins the phrase whole", () => {
		const html = render("Newton [law.](https://x.com) ينص");
		assert.match(html, /<p dir="rtl"><span dir="ltr">Newton <button [^>]*data-streamdown="link"[^>]*>law\.<\/button><\/span> ينص<\/p>/);
	});

	it("bold that holds a whole phrase, or a phrase inside it, is not cut", () => {
		const whole = render("قال **second law** هنا");
		assert.ok(whole.includes(`<p dir="rtl">قال <span dir="ltr">${STRONG}second law</strong></span> هنا</p>`), whole);
		const inside = render("قال **ينص second law ينص** هنا");
		assert.ok(inside.includes(`<p dir="rtl">قال ${STRONG}ينص <span dir="ltr">second law</span> ينص</strong> هنا</p>`), inside);
	});

	it("a URL with a query is one isolate, as plain text and as an autolink", () => {
		const url = "https://example.com/a?x=1&y=2";
		const text = `رابط ${url} هنا`;
		assert.equal(renderToStaticMarkup(<BidiText text={text} />), `<span dir="rtl">رابط <span dir="ltr">${escapeHtml(url)}</span> هنا</span>`);
		assert.match(render(text), /<p dir="rtl">رابط <span dir="ltr"><button [^>]*data-streamdown="link"[^>]*>https:\/\/example\.com\/a\?x=1&amp;y=2<\/button><\/span> هنا<\/p>/);
	});

	it("a URL with a right-to-left path segment is one isolate, as plain text and as an autolink", () => {
		const url = "https://ar.wikipedia.org/wiki/فيزياء";
		const text = `رابط ${url} هنا`;
		assert.equal(renderToStaticMarkup(<BidiText text={text} />), `<span dir="rtl">رابط <span dir="ltr">${url}</span> هنا</span>`);
		assert.match(render(text), /<p dir="rtl">رابط <span dir="ltr"><button [^>]*data-streamdown="link"[^>]*>https:\/\/ar\.wikipedia\.org\/wiki\/فيزياء<\/button><\/span> هنا<\/p>/);
	});

	it("a combining accent stays inside the isolate with its letter", () => {
		const text = "قيمة café هنا";
		assert.equal(renderToStaticMarkup(<BidiText text={text} />), `<span dir="rtl">قيمة <span dir="ltr">café</span> هنا</span>`);
	});
});

describe("markdown blocks: math and code are always left-to-right", () => {
	it("a paragraph that starts with inline math is right-to-left; the equation is stamped ltr and never split", () => {
		const html = render("$x^2$ هو مربع x");
		assert.match(html, /^<div [^>]*><p dir="rtl"><span class="katex" dir="ltr">/);
		assert.ok(html.endsWith(`${isolated(" هو مربع x")}</p></div>`));
		assert.equal((html.match(/dir="ltr"/g) ?? []).length, 2, "the equation and the trailing x, nothing inside KaTeX");
	});

	it("display math between Arabic paragraphs is stamped ltr; the paragraphs are right-to-left", () => {
		const html = render("فقرة أولى\n\n$$\nx^2 + y^2\n$$\n\nفقرة ثانية");
		assert.match(html, /<p dir="rtl">فقرة أولى<\/p>/);
		assert.match(html, /<p dir="rtl">فقرة ثانية<\/p>/);
		assert.match(html, /<span class="katex-display" dir="ltr"><span class="katex" dir="ltr">/);
		assert.ok(html.includes('data-testid="md-math"'), "the display math keeps its copy wrapper");
		assert.equal((html.match(/dir="ltr"/g) ?? []).length, 2, "only the two KaTeX wrappers");
	});

	it("inline code inside Arabic is stamped ltr and is not isolated a second time", () => {
		const html = render("لغة `C++` سريعة");
		assert.ok(html.includes(`<p dir="rtl">لغة ${INLINE_CODE}C++</code> سريعة</p>`), html);
	});

	it("a key combination inside Arabic is one left-to-right isolate, so a symbol key stays in it", () => {
		const html = render("اضغط <kbd>Ctrl+,</kbd> للإعدادات");
		assert.ok(html.includes(`<p dir="rtl">اضغط <span dir="ltr"><kbd>Ctrl+,</kbd></span> للإعدادات</p>`), html);
		const keys = render("اضغط <kbd>Ctrl</kbd>+<kbd>K</kbd> للبحث");
		assert.ok(keys.includes(`<p dir="rtl">اضغط <span dir="ltr"><kbd>Ctrl</kbd>+<kbd>K</kbd></span> للبحث</p>`), keys);
	});

	it("a key's letters do not count toward the block's direction, as code and math do not", () => {
		const html = render("Press <kbd>ع</kbd> to type.");
		assert.ok(html.includes("<p>Press <kbd>ع</kbd> to type.</p>"), html);
	});

	it("a code fence inside Arabic content is left-to-right", () => {
		const html = render("نص عربي\n\n```js\nconst x = 1;\n```");
		assert.match(html, /data-streamdown="code-block-body" dir="ltr"/);
		assert.ok(html.includes("const"), "the code renders");
		assert.equal((html.match(/<span dir="ltr">/g) ?? []).length, 0, "no isolation spans inside the fence");
	});

	it("Arabic written only inside code does not make the block right-to-left", () => {
		const html = render("Value `عربي` end.");
		assert.ok(!html.includes('dir="rtl"'), "the prose is English");
		assert.ok(html.includes(`<p>Value ${INLINE_CODE}عربي</code> end.</p>`), "an English paragraph on an English page sets no dir");
	});
});

describe("markdown blocks: no letters, or only left-to-right letters", () => {
	it("an English-only paragraph sets no dir on an English page", () => {
		assert.ok(render("Newton law holds.").includes("<p>Newton law holds.</p>"));
	});

	it("a math-only paragraph sets no dir", () => {
		assert.match(render("$x^2$"), /<p><span class="katex" dir="ltr">/);
	});

	it("an English paragraph inside a right-to-left quote overrides the flow", () => {
		const html = render("> نص عربي\n>\n> English paragraph here.");
		assert.ok(html.includes('<p dir="rtl">نص عربي</p>'));
		assert.ok(html.includes('<p dir="ltr">English paragraph here.</p>'));
	});

	it("a lone image keeps its unwrapped place instead of nesting a block in a paragraph", () => {
		const html = render("![alt](https://example.com/a.png)\n\nنص");
		assert.ok(!/<p[^>]*><div/.test(html));
		assert.ok(html.includes('data-streamdown="image-wrapper"'));
	});
});

describe("markdown blocks: streaming", () => {
	it("the direction is monotonic as the text grows: right-to-left from the first Arabic letter, never back", () => {
		const text = "Newton law ينص على أن القوة تساوي الكتلة";
		let seenRtl = false;
		for (let end = 1; end <= text.length; end++) {
			const prefix = text.slice(0, end);
			const html = render(prefix);
			const rtl = html.includes('<p dir="rtl">');
			assert.equal(rtl, hasRtlLetter(prefix), prefix);
			if (seenRtl) assert.ok(rtl, `stays right-to-left at ${end}`);
			seenRtl ||= rtl;
		}
		assert.ok(seenRtl);
	});

	it("a list that turns right-to-left mid-stream isolates the runs of the items it already held", async () => {
		const { parseHTML } = await import("linkedom");
		const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
		const globals = globalThis as Record<string, unknown>;
		const saved = Object.fromEntries(["window", "document", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, globals[key]]));
		Object.assign(globals, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
		try {
			const { createRoot } = await import("react-dom/client");
			const root = createRoot(dom.document.getElementById("root")!);
			const show = async (md: string) => {
				await React.act(async () => root.render(<MessageResponse>{md}</MessageResponse>));
				return dom.document.getElementById("root")!.innerHTML;
			};
			const before = await show("- Newton\n- two\n- three");
			assert.ok(!before.includes("dir="), "English so far: no direction, no isolation");
			const after = await show("- Newton\n- two\n- three ينص");
			assert.match(after, /<ul [^>]*dir="rtl"/);
			assert.equal((after.match(/<span dir="ltr">/g) ?? []).length, 3, "the earlier items are isolated too, not left stale");
			await React.act(async () => root.unmount());
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete globals[key];
				else globals[key] = value;
			}
		}
	});
});
