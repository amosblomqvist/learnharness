import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { before, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";

const require = createRequire(import.meta.url);
const stylesheet = fileURLToPath(new URL("../app/globals.css", import.meta.url));
let css: string;

before(async () => {
	// Compile the real stylesheet, including Tailwind's defaults/preflight.
	// JSX/SSR class assertions alone missed the @theme inline font bypass.
	const compiler = await compile(await fs.readFile(stylesheet, "utf8"), {
		base: path.dirname(stylesheet),
		loadStylesheet: async (id, base) => {
			const resolved = require.resolve(id === "tailwindcss" ? "tailwindcss/index.css" : id, { paths: [base] });
			return { path: resolved, base: path.dirname(resolved), content: await fs.readFile(resolved, "utf8") };
		},
	});
	css = compiler.build(["font-prose", "font-sans", "font-title", "font-ui", "font-mono"]);
});

function rules(selector: string): string[] {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`, "g"))].map(match => match[1]!);
}

it("reading utilities consume the live appearance variable, not a baked Source Sans 3 stack", () => {
	for (const selector of [".font-prose", ".font-sans"]) {
		assert.equal(rules(selector).length, 1, selector);
		assert.match(rules(selector)[0]!, /font-family:\s*var\(--font-prose\);/);
	}
	assert.match(css, /--font-prose:\s*var\(--font-sans3\), ui-sans-serif, system-ui, sans-serif;/,
		"reset/unset retains the bundled default and its fallback stack");
});

it("no compiled font-family declaration bypasses the reading setting via the loading-face variable", () => {
	assert.doesNotMatch(css, /(?:^|[;{])\s*font-family:[^;{}]*var\(--font-sans3\)/m);
});

it("mono chrome/code and the independent serif title remain separate font contracts", () => {
	for (const selector of [".font-ui", ".font-mono"]) {
		assert.match(rules(selector)[0]!, /font-family:\s*var\(--font-jetbrains\), ui-monospace, SFMono-Regular, monospace;/);
	}
	assert.match(rules("body")[0]!, /font-family:\s*var\(--font-ui\);/);
	assert.match(rules(".font-title").join("\n"), /font-family:\s*var\(--font-title\);/);
	assert.match(css, /--font-title:\s*"lh-cmu", serif;/);
});

it("reading-family repair does not change reading/input size, leading, or title weight", () => {
	assert.match(rules(".lh-prose")[0]!, /font-family:\s*var\(--font-prose\);/);
	assert.match(rules(".lh-prose")[0]!, /font-size:\s*var\(--lh-prose-size\);/);
	assert.match(rules(".lh-prose")[0]!, /line-height:\s*var\(--lh-prose-leading\);/);
	assert.match(rules(".lh-input")[0]!, /font-family:\s*var\(--font-prose\);/);
	assert.match(rules(".lh-input")[0]!, /font-size:\s*var\(--lh-prose-size\);/);
	assert.match(rules(".lh-input")[0]!, /line-height:\s*1\.25;/);
	assert.match(rules(".font-title").join("\n"), /font-weight:\s*900;/);
	for (const selector of [".font-prose", ".font-sans"]) {
		assert.doesNotMatch(rules(selector).join("\n"), /font-size:|line-height:/);
	}
});
