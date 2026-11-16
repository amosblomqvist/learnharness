/** The bundled visual-explainer renderer, seen only through renderExplainer's result. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { renderExplainer, type ExplainerRenderResult } from "../src/agent/explainer/render.ts";
import { BLOCKED_FONT_HOSTS, findExternalLoads, stripFontLoads } from "../src/agent/explainer/sanitize.ts";

const REGISTERS = ["instrument", "blueprint", "paper", "editorial"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

function kitPage(register: string, body = `<pre class="mermaid" aria-label="A request reaches the API.">flowchart LR\n  A[Client] --> B[API]</pre>`) {
	return `<!doctype html>
<html data-register="${register}">
<head>
<title>Explainer</title>
<link rel="stylesheet" href="kit.css" data-ve-kit>
</head>
<body>
<main>
<h1>How a request flows</h1>
${body}
</main>
</body>
</html>
`;
}

const PLAN_PAGE = `<!doctype html>
<html>
<head><title>Plan</title></head>
<body>
<header><h1>Soft delete</h1><p class="lead">Projects go to Trash.</p></header>
<ve-plan>
<ve-claim><p>Delete moves a project to Trash.</p></ve-claim>
<ve-claim aux="shared"><p>The projects table gains a column.</p></ve-claim>
<ve-claim aux="scope"><p>Nothing else changes.</p></ve-claim>
</ve-plan>
</body>
</html>
`;

// A kit page whose <ve-waffle> has no label, so the renderer warns.
const WARNED_KIT_PAGE = kitPage("editorial", `<ve-waffle value="94" note="6 misses"></ve-waffle>`);

const VE_PLAN_ERROR = "Visual plans (<ve-plan>) are not available in an Explainer. Write the page without <ve-plan>.";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:">`;

function rendered(result: ExplainerRenderResult): { html: string; warnings: string[] } {
	if (!result.ok) assert.fail(`render failed: ${result.errors.join("\n")}`);
	return result;
}

function failed(result: ExplainerRenderResult): string[] {
	if (result.ok) assert.fail("render succeeded but should have failed");
	return result.errors;
}

function assertNoFonts(html: string) {
	for (const host of FONT_HOSTS) assert.equal(html.includes(host), false, host);
}

function assertSelfContained(html: string) {
	const external = /^(?:https?:|\/\/)/i;
	const values = [
		...[...html.matchAll(/\bsrc\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]!),
		...[...html.matchAll(/<link\b[^>]*>/gi)].flatMap((m) => [...m[0].matchAll(/\bhref\s*=\s*["']?([^"'\s>]+)/gi)].map((h) => h[1]!)),
		...[...html.matchAll(/@import\s+(?:url\(\s*)?["']?([^"'\s;)]+)/gi)].map((m) => m[1]!),
		...[...html.matchAll(/url\(\s*["']?([^"'\s)]+)/gi)].map((m) => m[1]!),
	];
	assert.deepEqual(values.filter((v) => external.test(v)), []);
}

describe("renderExplainer: the bundled renderer's boundary", () => {
	it("renders a kit page: inlines the kit styles and draws Mermaid as SVG", async () => {
		const { html } = rendered(await renderExplainer(kitPage("instrument")));
		assert.match(html, /<style data-ve-kit>/);
		assert.match(html, /<div class="ve-mermaid"[^>]*><svg\b/);
		assert.equal(html.includes('<pre class="mermaid"'), false);
	});

	for (const register of REGISTERS) {
		it(`leaves no Google Fonts load and no external load (register ${register})`, async () => {
			const { html } = rendered(await renderExplainer(kitPage(register)));
			assertNoFonts(html);
			assertSelfContained(html);
		});
	}

	it("fails on a plan page (<ve-plan>), whose script needs the removed in-page reply", async () => {
		const errors = failed(await renderExplainer(PLAN_PAGE));
		assert.ok(errors.some((e) => e.includes(VE_PLAN_ERROR)), errors.join("\n"));
	});

	it("returns the renderer's warnings as a list", async () => {
		const { html, warnings } = rendered(await renderExplainer(WARNED_KIT_PAGE));
		assertNoFonts(html);
		assertSelfContained(html);
		assert.ok(warnings.length > 0, "the warnings come back as a list");
		for (const warning of warnings) assert.equal(warning.startsWith("- "), false, warning);
	});

	it("puts one CSP meta before any of the page's own markup on kit pages and ordinary pages", async () => {
		const sources = [
			kitPage("instrument"),
			`<!doctype html><html><head><meta charset="utf-8"><title>Plain</title></head><body><p>Hello</p></body></html>`,
			`<!doctype html><html><body><p>No head</p></body></html>`,
			`<p>Only a fragment</p>`,
			`<!-- <head> --><!doctype html><html><head><title>Comment first</title></head><body><p>Hi</p></body></html>`,
			`<script>window.early = 1</script><!doctype html><html><head><title>Script first</title></head><body></body></html>`,
		];
		for (const source of sources) {
			const { html } = rendered(await renderExplainer(source));
			assert.equal(html.split(CSP_META).length - 1, 1, html);
			const beforePolicy = html.slice(0, html.indexOf(CSP_META)).replace(/<!--[\s\S]*?-->/g, "");
			assert.match(beforePolicy, /^\s*(?:<!doctype\b[^>]*>\s*)?$/i, html);
		}
	});

	it("fails on a <meta http-equiv> refresh however it is written, and on other http-equiv values", async () => {
		const tricks = [
			`<meta http-equiv="&#114;efresh" content="0;url=https://x.example/">`,
			`<meta content="a>b" http-equiv=refresh>`,
			`<meta http-equiv="REFRESH" content="0">`,
			`<meta http-equiv="set-cookie" content="a=b">`,
		];
		for (const trick of tricks) {
			const source = `<!doctype html><html><head><title>Plain</title>${trick}</head><body><p>Hello</p></body></html>`;
			const errors = failed(await renderExplainer(source));
			assert.ok(errors.some((e) => /http-equiv/i.test(e)), `${trick}\n${errors.join("\n")}`);
		}
	});

	it("keeps a page whose text shows escaped markup with outside URLs", async () => {
		const example = `<pre><code>&lt;img src="https://example.com/a.png"&gt; and url(https://example.com/b.css)</code></pre>`;
		const { html } = rendered(await renderExplainer(kitPage("paper", example)));
		assert.ok(html.includes("&lt;img src="), html);
	});

	it("fails on outside loads that only a parser sees: srcset, SVG href and style attributes", async () => {
		const loads = [
			`<img srcset="data:image/png;base64,AA== 1x, https://x.example/b.png 2x" alt="">`,
			`<svg><image href="https://x.example/c.png"/></svg>`,
			`<div style="background:url('https://x.example/d.png')"></div>`,
		];
		for (const load of loads) {
			const source = `<!doctype html><html><head><title>Plain</title></head><body>${load}</body></html>`;
			const errors = failed(await renderExplainer(source));
			assert.ok(errors.some((e) => e.includes("https://x.example/")), `${load}\n${errors.join("\n")}`);
		}
	});

	it("fails on a <meta http-equiv=\"refresh\"> and names it", async () => {
		const refresh = `<meta http-equiv="refresh" content="0;url=https://x.example/">`;
		const source = `<!doctype html><html><head><title>Plain</title>${refresh}</head><body><p>Hello</p></body></html>`;
		const errors = failed(await renderExplainer(source));
		assert.ok(errors.some((e) => e.includes(refresh)), errors.join("\n"));
	});

	it("keeps an ordinary <a href> link", async () => {
		const { html } = rendered(await renderExplainer(kitPage("paper", `<p><a href="https://example.com/docs">Docs</a></p>`)));
		assert.ok(html.includes('<a href="https://example.com/docs">'));
	});

	it("fails on an external <script src> and names the URL", async () => {
		const url = "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js";
		const errors = failed(await renderExplainer(kitPage("instrument", `<p>Chart below.</p>\n<script src="${url}"></script>`)));
		assert.ok(errors.some((e) => e.includes(url)), errors.join("\n"));
	});

	it("fails on a <ve-flow> model without running its code", async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "explainer-model-probe-"));
		const marker = path.join(outside, "model-ran.txt");
		try {
			const model = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "ran");
export function state() { return "idle"; }`;
			const flow = `<ve-flow auto label="A machine walked from a model."><script type="text/plain" model>\n${model}\n</script></ve-flow>`;
			const errors = failed(await renderExplainer(kitPage("instrument", flow)));
			assert.ok(errors.length > 0);
			assert.equal(fs.existsSync(marker), false, "the model's code ran");
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("fails on <ve-ask>, which is not bundled", async () => {
		const ask = `<ve-ask id="ttl" q="Key lifetime?"><ve-opt value="60">60 s</ve-opt><ve-opt value="300" default>5 min</ve-opt></ve-ask>`;
		failed(await renderExplainer(kitPage("instrument", ask)));
	});

	it("drops the in-page reply (kit/reply.js) from kit pages", async () => {
		for (const source of [kitPage("blueprint"), WARNED_KIT_PAGE]) {
			const { html } = rendered(await renderExplainer(source));
			assert.equal(html.includes("window.veReply ??="), false);
			assert.equal(html.includes("data-ve-reply"), false);
		}
	});

	it("returns an ordinary page without the kit as it is, apart from the CSP meta", async () => {
		const source = `<!doctype html><html><head><title>Plain</title></head><body><p>Hello</p></body></html>`;
		const { html } = rendered(await renderExplainer(source));
		assert.equal(html.replace(`\n${CSP_META}`, ""), source);
	});

	it("fails when the render runs past its time limit", async () => {
		const errors = failed(await renderExplainer(kitPage("instrument"), { timeoutMs: 1 }));
		assert.ok(errors.some((e) => /timed out/i.test(e)), errors.join("\n"));
	});
});

describe("stripFontLoads: Google Fonts @import with several weights", () => {
	const url = "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap";
	const forms = [`@import url("${url}");`, `@import url(${url});`, `@import "${url}";`];
	for (const rule of forms) {
		it(`removes the whole rule: ${rule}`, () => {
			const html = stripFontLoads(`<style>${rule}body{color:red}</style>`, BLOCKED_FONT_HOSTS);
			assert.equal(html, "<style>body{color:red}</style>");
			assert.deepEqual(findExternalLoads(html), []);
		});
	}
});
