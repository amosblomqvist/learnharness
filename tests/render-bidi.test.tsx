/**
 * Mixed right-to-left and left-to-right content (static render, plus client
 * mounts for the streaming flip and for text a user action brings up). Pins:
 * - markdown blocks (p, h1-h6, blockquote) take their direction from their own
 *   letters, ul/ol/table from their whole text, items and cells inherit; math
 *   and code never count and are always left-to-right;
 * - the direction of parsed text comes from its letters alone: escaped dollars
 *   and a growing `- $5`, `- عربي`, `- $10` never hide the Arabic;
 * - inside a right-to-left block every left-to-right phrase is isolated in one
 *   `<span dir="ltr">`: the runs `ltrRuns` finds over the whole inline text, so
 *   markup, math and code join them (`Newton's **second law**`, `**C**++`,
 *   `(**derivative**)`), a URL is one phrase and an accent stays with its
 *   letter; punctuation between two English pieces stays in the phrase and
 *   only at its ends stays out; bold or italic that a phrase spills into or
 *   out of is cut at the phrase boundary, while a link stays whole: it joins
 *   the phrase when it holds no strong right-to-left character, else it
 *   isolates inside itself;
 * - a block with no letters sets no `dir`; an LTR block states `dir="ltr"` only
 *   where it overrides a right-to-left flow (an Arabic block); an English
 *   document is untouched, apart from code and math, which are always `ltr`;
 * - the direction follows the text as it streams, and a block that turns
 *   right-to-left mid-stream isolates the runs of the items it already held;
 * - BidiText: one line under one direction, line breaks collapsed, or with
 *   `multiline` one block per line, runs isolated the same way; a file-path
 *   chip is placed whole in the run it sits in, and its letters never set the
 *   direction; text fields take `dir` from their value and none when empty;
 * - a field or card that exists only after typing or a click (the rename
 *   field, the home topic, the sessions search, the practice thinking, a
 *   graph node's card) takes its text's direction the same way.
 * Arabic is the tested language; one Hebrew case proves the rule is general.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AnsweredCard } from "../components/answered-card.tsx";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { BidiText } from "../components/bidi-text.tsx";
import { Composer } from "../components/composer.tsx";
import { ChainTableBody } from "../components/chain-table.tsx";
import { Chat } from "../components/chat.tsx";
import { FilePathChip, filePathChunks } from "../components/file-path-chip.tsx";
import { GraphView } from "../components/graph-view.tsx";
import { Home } from "../components/home.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { AppShell, RenameRow } from "../components/sidebar.tsx";
import { hasRtlLetter, ltrRuns } from "../src/core/bidi.ts";
import { newUserMessage } from "../src/core/native-messages.ts";
import { buildAnswer, DEFAULT_CONFIDENCE_INDEX, emptyDockSelection } from "../src/core/question-core.ts";
import type { QuestionData, QuestionFormDraft } from "../src/core/question-core.ts";
import type { ChatListItem, GraphSnapshot } from "../src/core/index.ts";
import { mountClient, typeInto, typeIntoEditor } from "./helpers/client-mount.ts";

const escapeHtml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The markup of `text` with its left-to-right runs isolated, built straight from the core's runs. */
function isolated(text: string): string {
	return ltrRuns(text).map((run) => (run.ltr ? `<span dir="ltr">${escapeHtml(run.text)}</span>` : escapeHtml(run.text))).join("");
}

function render(md: string): string {
	return renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
}

/** The app router `useRouter` reads outside Next: every navigation is a no-op. */
const noopRouter: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "_b_0_" };

/** A server-events channel that never opens and never delivers. */
const silentEvents = () => ({ close() {}, onOpen() {}, onEvent() {} });

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

	it("a URL's right-to-left path segment never counts: an English sentence around it stays left-to-right, as a block and as plain text", () => {
		const text = "See https://ar.wikipedia.org/wiki/فيزياء for details.";
		const md = render(text);
		assert.match(md, /<p>See <button [^>]*data-streamdown="link"[^>]*>https:\/\/ar\.wikipedia\.org\/wiki\/فيزياء<\/button> for details\.<\/p>/);
		assert.ok(!md.includes('dir="rtl"'), md);
		assert.equal(renderToStaticMarkup(<BidiText text={text} />), `<span dir="ltr">${text}</span>`);
	});

	it("an English document carries no dir on any block and no isolate; only inline code, code fences and math are stamped ltr, on every page, having no direction of their own", () => {
		const md = "# Heading\n\nSome **bold** and `code` text with $x^2$ inline math.\n\n```js\nconst x = 1;\n```\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> A quote.\n\n> [!IMPORTANT]\n> A callout.\n\n$$\ny = x\n$$";
		const html = render(md);
		const stamped = [...html.matchAll(/<[a-z0-9]+[^>]*\sdir="([^"]*)"[^>]*>/g)];
		assert.equal(stamped.length, 5, "the inline code, the inline equation, the fence body, the display equation and the equation inside it");
		for (const [tag, dir] of stamped) {
			assert.equal(dir, "ltr", tag);
			assert.match(tag, /data-streamdown="(inline-code|code-block-body)"|class="katex(-display)?"/, `only code and math carry dir: ${tag}`);
		}
		assert.equal((html.match(/<span dir="ltr">/g) ?? []).length, 0, "no isolate");
		const block = /^<(p|h[1-6]|ul|ol|li|blockquote|table|thead|tbody|tr|th|td)\b|data-testid="(md-callout|md-table)"/;
		assert.ok(stamped.every(([tag]) => !block.test(tag)), "no block carries dir");
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
		const view = await mountClient(null);
		try {
			const show = async (md: string) => {
				await view.render(<MessageResponse>{md}</MessageResponse>);
				return view.host.innerHTML;
			};
			const before = await show("- Newton\n- two\n- three");
			assert.ok(!before.includes("dir="), "English so far: no direction, no isolation");
			const after = await show("- Newton\n- two\n- three ينص");
			assert.match(after, /<ul [^>]*dir="rtl"/);
			assert.equal((after.match(/<span dir="ltr">/g) ?? []).length, 3, "the earlier items are isolated too, not left stale");
			const grown = await show("- Newton\n- two\n- three ينص\n- four");
			assert.equal((grown.match(/<span dir="ltr">/g) ?? []).length, 4, "a later item is isolated too, and the earlier ones keep theirs");
		} finally {
			await view.unmount();
		}
	});
});

describe("BidiText: plain text under its own direction", () => {
	const html = (node: React.ReactElement) => renderToStaticMarkup(node);

	it("single-line Arabic with an English run: dir on the element, the run isolated", () => {
		const text = "المشتقة (derivative) مهمة";
		assert.equal(html(<BidiText text={text} />), `<span dir="rtl">${isolated(text)}</span>`);
	});

	it("a non-string value from cast tool output renders as React would, without throwing", () => {
		assert.equal(html(<BidiText text={502 as unknown as string} />), `<span>502</span>`);
		assert.equal(html(<BidiText text={undefined as unknown as string} />), `<span></span>`);
	});

	it("English pieces joined by a comma are one isolate; Arabic between pieces ends it", () => {
		const text = "مثل Python، Java وأيضا Big-O notation هنا";
		assert.equal(html(<BidiText text={text} />), `<span dir="rtl">${isolated(text)}</span>`);
		assert.equal((html(<BidiText text={text} />).match(/<span dir="ltr">/g) ?? []).length, 2);
		assert.ok(html(<BidiText text={text} />).includes('<span dir="ltr">Python، Java</span>'));
	});

	it("single-line English is left-to-right and nothing is isolated", () => {
		assert.equal(html(<BidiText text="Newton law" />), '<span dir="ltr">Newton law</span>');
	});

	it("text without letters sets no dir", () => {
		assert.equal(html(<BidiText text="42" />), "<span>42</span>");
		assert.equal(html(<BidiText text="" />), "<span></span>");
	});

	it("a Hebrew title is right-to-left", () => {
		const text = "מבוא ל-Python";
		assert.equal(html(<BidiText text={text} />), `<span dir="rtl">${isolated(text)}</span>`);
	});

	it("without multiline, a line break collapses to a space: one line, one dir, as a title or an activity row shows it", () => {
		assert.equal(html(<BidiText className="truncate" text={"derivative\nrules"} />), '<span class="truncate" dir="ltr">derivative rules</span>');
		const text = "مرحبا Newton\r\n\n  English line";
		assert.equal(html(<BidiText text={text} />), `<span dir="rtl">${isolated("مرحبا Newton English line")}</span>`);
	});

	it("with multiline, text is one block per line, each with its own direction; empty lines keep their height", () => {
		const text = "مرحبا Newton\nEnglish line\n\nسطر أخير";
		assert.equal(
			html(<BidiText as="div" className="whitespace-pre-wrap" text={text} multiline />),
			'<div class="whitespace-pre-wrap">' +
				`<span class="block" dir="rtl">${isolated("مرحبا Newton")}</span>` +
				'<span class="block" dir="ltr">English line</span>' +
				'<span class="block"><br/></span>' +
				'<span class="block" dir="rtl">سطر أخير</span>' +
				"</div>",
		);
	});

	it("a trailing line break ends the last line without opening another; CRLF splits like LF", () => {
		assert.equal(
			html(<BidiText text={"سطر\r\nline\r\n"} multiline />),
			'<span><span class="block" dir="rtl">سطر</span><span class="block" dir="ltr">line</span></span>',
		);
	});

	it("passes the element's own props through, whatever element it renders", () => {
		const out = html(<BidiText as="button" type="button" data-testid="title" className="truncate" text="عنوان" />);
		assert.equal(out, '<button type="button" data-testid="title" class="truncate" dir="rtl">عنوان</button>');
	});

	it("the answered-card quote reads in its own direction, quotation marks inside the line", () => {
		const qd: QuestionData = { id: "e1", kind: "explain", question: "Why?", mode: "text", options: [], createdAt: new Date().toISOString() };
		const text = "لأن Newton قال ذلك";
		const card = html(<AnsweredCard answer={buildAnswer(qd, { text })} />);
		assert.ok(card.includes(`<div class="lh-prose mt-2 whitespace-pre-wrap" dir="rtl">${isolated(`“${text}”`)}</div>`), card);
	});

	it("the learner's own typed option reads in its own direction, quotation marks inside the line", () => {
		const qd: QuestionData = { id: "a1", kind: "ask", question: "Which?", mode: "single-select", options: [], createdAt: new Date().toISOString() };
		const other = "خيار آخر (other)";
		const card = html(<AnsweredCard answer={buildAnswer(qd, { other })} />);
		assert.ok(card.includes(`data-testid="answered-other" class="flex items-center gap-2 rounded-lg border border-primary bg-accent px-3 py-1.5"><span dir="rtl">${isolated(`“${other}”`)}</span></div>`), card);
	});

	it("the session title and the learner's message each read in their own text's direction", () => {
		const message = "أريد أن أفهم Newton";
		const chat = html(
			<ServerEventsProvider>
				<Chat chatId="c1" title="درس المشتقات" initialMessages={[newUserMessage(message)]} />
			</ServerEventsProvider>,
		);
		assert.match(
			chat,
			/<button type="button" class="lh-no-drag -mx-1\.5 min-w-4 shrink cursor-text truncate rounded-md px-1\.5 text-start font-title text-3xl tracking-tight transition-colors hover:bg-accent"[^>]* dir="rtl">درس المشتقات<\/button>/,
			"the title button",
		);
		assert.ok(chat.includes(`<div class="lh-prose whitespace-pre-wrap text-foreground" dir="rtl">${isolated(message)}</div>`), "the learner's message");
	});
});

describe("BidiText: file-path chips in learner text", () => {
	const html = (node: React.ReactElement) => renderToStaticMarkup(node);
	const chip = (path: string) => html(<FilePathChip path={path} />);

	it("an Arabic line with a chip: the chip is one left-to-right unit, isolated with the English beside it", () => {
		const text = "راجع ملف `/home/user/notes.md` (draft) هنا";
		assert.equal(
			html(<BidiText text={text} chunks={filePathChunks} />),
			`<span dir="rtl">راجع ملف <span dir="ltr">${chip("/home/user/notes.md")} (draft)</span> هنا</span>`,
		);
	});

	it("an English line whose path holds Arabic letters stays left-to-right: the path never sets the direction", () => {
		const text = "Open `/home/user/ملاحظات.md` now";
		assert.equal(html(<BidiText text={text} chunks={filePathChunks} />), `<span dir="ltr">Open ${chip("/home/user/ملاحظات.md")} now</span>`);
	});

	it("a line that is only a chip sets no dir: an element is not text", () => {
		assert.equal(html(<BidiText text={"`/home/user/notes.md`"} chunks={filePathChunks} />), `<span>${chip("/home/user/notes.md")}</span>`);
	});
});

describe("text fields take dir from their value", () => {
	const fields = (markup: string) => [...markup.matchAll(/<(?:input\b|textarea\b|div\b(?=[^>]*data-file-path-input))[^>]*>/g)].map((match) => match[0]);
	const dirOf = (tag: string) => /\bdir="(\w+)"/.exec(tag)?.[1];

	it("the composer: rtl for Arabic, ltr for English, none when empty", () => {
		const composer = (value: string) =>
			renderToStaticMarkup(<Composer busy={false} value={value} onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend />);
		assert.equal(dirOf(fields(composer("مرحبا Newton"))[0]!), "rtl");
		assert.equal(dirOf(fields(composer("hello"))[0]!), "ltr");
		assert.equal(dirOf(fields(composer(""))[0]!), undefined);
	});

	it("the reading-thinking field: rtl for Arabic, none when empty", () => {
		const field = (value: string) => renderToStaticMarkup(<ReadingThinkingField value={value} onChange={() => {}} claim={false} />);
		assert.equal(dirOf(fields(field("أفكر في"))[0]!), "rtl");
		assert.equal(dirOf(fields(field(""))[0]!), undefined);
	});

	it("the session rename field: rtl for an Arabic title, none when empty", () => {
		const row = (title: string) =>
			renderToStaticMarkup(<RenameRow chat={{ id: "c1", title, updatedAt: new Date().toISOString(), busy: false } as unknown as ChatListItem} onCommit={() => {}} onCancel={() => {}} />);
		assert.equal(dirOf(fields(row("درس المشتقات"))[0]!), "rtl");
		assert.equal(dirOf(fields(row(""))[0]!), undefined);
	});

	it("the chain-table search: rtl for an Arabic query, none when empty", () => {
		const body = (query: string) =>
			renderToStaticMarkup(
				<ChainTableBody
					nodes={[]} chains={[]} sessions={{}} fileSources={{}} query={query} onQuery={() => {}}
					sort={{ col: "name", dir: 1 }} onSort={() => {}} selection={new Set()} expandedClusters={new Set()} expandedChains={new Set()}
					onToggleCluster={() => {}} onToggleChain={() => {}} onToggleNodes={() => {}} onClear={() => {}} onDelete={() => {}} onClose={() => {}}
					onSelect={() => {}}
				/>,
			);
		const search = (markup: string) => fields(markup).find((tag) => tag.includes("chain-table-search"))!;
		assert.equal(dirOf(search(body("مشتقة"))), "rtl");
		assert.equal(dirOf(search(body(""))), undefined);
	});

	it("the question dock answer field and the practice dock thinking field start with no dir", () => {
		const question = renderToStaticMarkup(
			<QuestionDock toolName="ask_user_question" toolCallId="a2" input={{ question: "Explain the chain rule." } as never} expanded onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.equal(dirOf(fields(question).find((tag) => tag.startsWith("<div"))!), undefined);
		const practice = renderToStaticMarkup(
			<PracticeDock problemCallId="p1" input={{ statement: "Show it." }} expanded onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.equal(dirOf(fields(practice).find((tag) => tag.startsWith("<div"))!), undefined);
	});

	it("each question dock field takes its draft's direction: the typed answer, the custom option and the thinking", () => {
		const draft = (over: Partial<QuestionFormDraft>): QuestionFormDraft => ({
			selection: emptyDockSelection(), thinking: "", other: "", text: "", confidenceIndex: DEFAULT_CONFIDENCE_INDEX, ...over,
		});
		const dock = (input: object, initialDraft: QuestionFormDraft) =>
			renderToStaticMarkup(
				<QuestionDock toolName="ask_user_question" toolCallId="a3" input={input as never} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={initialDraft} />,
			);
		const field = (markup: string, label: string) => fields(markup).find((tag) => tag.includes(`aria-label="${label}"`)) ?? "";
		const answer = field(dock({ question: "Explain the chain rule." }, draft({ text: "قاعدة السلسلة" })), "Type your answer…");
		assert.equal(dirOf(answer), "rtl", "the typed answer");
		assert.ok(answer.includes("field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"), answer);
		const picked = dock(
			{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
			draft({ other: "خيار آخر", thinking: "أفكر في الجواب", selection: { ...emptyDockSelection(), otherSelected: true } }),
		);
		const other = field(picked, "Type your own answer…");
		assert.equal(dirOf(other), "rtl", "the custom option");
		assert.ok(other.includes("lh-input w-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"), other);
		const thinking = field(picked, "Why this answer? Whatever comes to mind.");
		assert.equal(dirOf(thinking), "rtl", "the thinking");
		assert.ok(thinking.includes("field-sizing-content lh-input max-h-48 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground/70"), thinking);
	});
});

describe("text that appears only after a user action takes its own direction", () => {
	it("the session rename field follows the typed title: ltr for the English title it opens with, rtl once Arabic is typed", async () => {
		const view = await mountClient(
			<ServerEventsProvider connect={silentEvents}>
				<Chat chatId="c1" title="Derivatives" initialMessages={[]} />
			</ServerEventsProvider>,
		);
		try {
			const title = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Derivatives")!;
			await act(async () => title.click());
			const field = view.host.querySelector<HTMLInputElement>('input[aria-label="Session title"]')!;
			assert.equal(field.getAttribute("dir"), "ltr");
			await typeInto(field, "درس المشتقات");
			assert.equal(field.getAttribute("dir"), "rtl");
		} finally {
			await view.unmount();
		}
	});

	it("the practice dock's thinking field takes the typed text's direction", async () => {
		const view = await mountClient(<PracticeDock problemCallId="p1" input={{ statement: "Show it." }} expanded onExpand={() => {}} onSubmit={() => {}} />);
		try {
			const editor = view.host.querySelector<HTMLElement>('[data-testid="practice-thinking-field"] [data-file-path-input]')!;
			assert.equal(editor.getAttribute("dir"), null);
			await typeIntoEditor(editor, "أفكر في الحل");
			assert.equal(editor.getAttribute("dir"), "rtl");
		} finally {
			await view.unmount();
		}
	});

	it("the home topic field takes the typed topic's direction", async () => {
		const view = await mountClient(
			<AppRouterContext.Provider value={noopRouter}>
				<Home initialConfigured rendering={false} />
			</AppRouterContext.Provider>,
		);
		try {
			const editor = view.host.querySelector<HTMLElement>('form [data-file-path-input]')!;
			assert.equal(editor.getAttribute("dir"), null);
			await typeIntoEditor(editor, "قاعدة السلسلة");
			assert.equal(editor.getAttribute("dir"), "rtl");
		} finally {
			await view.unmount();
		}
	});

	it("the sessions search box takes the typed query's direction", async () => {
		const view = await mountClient(
			<AppRouterContext.Provider value={noopRouter}>
				<ServerEventsProvider connect={silentEvents}>
					<AppShell>{null}</AppShell>
				</ServerEventsProvider>
			</AppRouterContext.Provider>,
		);
		try {
			const search = view.host.querySelector<HTMLInputElement>('[data-testid="session-search"]')!;
			assert.equal(search.getAttribute("dir"), null);
			await typeInto(search, "مشتقة");
			assert.equal(search.getAttribute("dir"), "rtl");
		} finally {
			await view.unmount();
		}
	});

	it("a clicked graph node's card shows its name, statement and notes file each in its own direction", async () => {
		const node = { id: "n_1", name: "قانون نيوتن", statement: "القوة تساوي الكتلة في التسارع (F = ma).", aliases: [], createdAt: "2026-01-01T00:00:00.000Z", provenance: [] };
		const snapshot: GraphSnapshot = {
			nodes: [node], propositions: [node], edges: [], logicalEdges: [], impLinks: [], chains: [], clusters: [],
			sessions: {}, fileSources: { src_1: "ملاحظات الفيزياء.md" }, nodeSessions: { n_1: ["src_1"] }, positions: { n_1: { x: 100, y: 80 } },
		};
		const graphOnly: typeof fetch = async (input) => (input === "/api/graph" ? Response.json(snapshot) : new Promise<Response>(() => {}));
		const view = await mountClient(
			<ServerEventsProvider connect={silentEvents}>
				<GraphView />
			</ServerEventsProvider>,
			{ fetch: graphOnly, frames: true },
		);
		try {
			// The snapshot arrives, then the canvas's live layout anneals to rest:
			// a press on a node while it is still moving is a drag, not a click.
			await view.settle();
			// A zero-size canvas never fits its camera, so screen and layout points
			// coincide: the click lands on the node's ledger position.
			const canvas = view.host.querySelector("canvas")!;
			for (const type of ["pointerdown", "pointerup"]) {
				await act(async () => {
					canvas.dispatchEvent(Object.assign(new window.Event(type, { bubbles: true }), { button: 0, pointerId: 1, clientX: 100, clientY: 80 }));
				});
			}
			const owner = (classes: string) => view.host.querySelector(`[class="${classes}"]`);
			assert.equal(owner("text-sm font-medium leading-snug")?.getAttribute("dir"), "rtl", "the name");
			assert.equal(owner("mt-1 text-xs leading-relaxed text-muted-foreground")?.getAttribute("dir"), "rtl", "the statement");
			assert.equal(owner("min-w-0 flex-1 truncate px-2 py-1.5 text-sm text-muted-foreground")?.getAttribute("dir"), "rtl", "the notes file");
		} finally {
			await view.unmount();
		}
	});
});
