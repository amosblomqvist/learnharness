/**
 * Removing the unused ANSI renderer (issue #11): ansi-to-react and the four
 * packages it alone pulled in (anser, escape-carriage, linkify-it, uc.micro)
 * leave the declared dependency contract. Tool text keeps rendering through
 * React's own escaping, so nothing a learner sees changes.
 *
 * Seams: the declared dependency contract (package.json + package-lock.json)
 * and the two exported cards — ToolCallCard's string/{text} result and its
 * error body, LiveToolCard's streaming input. Static react-dom/server
 * rendering only; these are not browser claims.
 *
 * The installed tree and the built payload are measured by the parent's
 * verify-evidence.py, so this file does not scan node_modules or walk the
 * snapshot: the copy lives inside the main repository, and any resolution
 * helper would walk up into the main node_modules.
 *
 * tsx note: as in render-cards.test.tsx, the classic JSX transform needs React
 * resolvable as a global.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";
import { LiveToolCard } from "../components/artifacts/live-tool-card.tsx";

const REMOVED_PACKAGES = ["ansi-to-react", "anser", "escape-carriage", "linkify-it", "uc.micro"];

const manifestUrl = new URL("../package.json", import.meta.url);
const lockUrl = new URL("../package-lock.json", import.meta.url);

/** ESC itself, the six ASCII characters a JSON encoder writes in its place,
 *  and the two backslashes it writes when the input already held those six. */
const ESC_CHAR = "\u001b";
const ESC_JSON_TEXT = "\\u001b";
const ESC_LITERAL_JSON = "\\\\u001b";

/** The card bodies are plain <pre> text; their exact content is the claim. */
function preBodies(html: string): string[] {
	return [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => m[1] ?? "");
}

/** Every object key in the tree that names a removed package, as a dotted
 *  path. Catches declarations, overrides and any future section the manifest
 *  grows, not just the four dependency blocks. */
function keysNamed(value: unknown, names: string[], at = ""): string[] {
	if (value == null || typeof value !== "object") return [];
	const hits: string[] = [];
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const path = at ? `${at}.${key}` : key;
		if (names.includes(key)) hits.push(path);
		hits.push(...keysNamed(child, names, path));
	}
	return hits;
}

describe("the removed ANSI renderer leaves the dependency contract", () => {
	it("the manifest names none of ansi-to-react, anser, escape-carriage, linkify-it, uc.micro", () => {
		const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown;
		assert.deepEqual(keysNamed(manifest, REMOVED_PACKAGES), [], "no removed package may be named in package.json");
	});

	it("the lockfile keeps no entry and no dependency reference for the removed subtree", () => {
		const lock = JSON.parse(readFileSync(lockUrl, "utf8")) as { packages?: Record<string, Record<string, unknown>> };
		const entries: string[] = [];
		const references: string[] = [];
		for (const [path, meta] of Object.entries(lock.packages ?? {})) {
			const marker = "node_modules/";
			const tail = path.slice(path.lastIndexOf(marker) + marker.length);
			if (REMOVED_PACKAGES.includes(tail)) entries.push(`${path}@${String(meta.version)}`);
			for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
				const block = meta[field];
				if (block == null || typeof block !== "object") continue;
				for (const name of REMOVED_PACKAGES) {
					if (name in (block as Record<string, unknown>)) references.push(`${path || "<root>"} ${field}.${name}`);
				}
			}
		}
		assert.deepEqual(entries.sort(), [], "no lockfile entry may remain for the removed subtree");
		assert.deepEqual(references.sort(), [], "nothing may still depend on the removed subtree");
	});
});

describe("ToolCallCard keeps tool text as plain escaped React text", () => {
	it("a string result preserves ANSI escapes and renders URLs and HTML-like text literally", () => {
		const output = [
			"\u001b[31mred\u001b[0m text",
			"see https://example.com/notes?q=1 and mailto:learner@example.com",
			"<b>bold?</b> <script>alert(1)</script>",
			"plain line",
		].join("\n");
		const html = renderToStaticMarkup(
			<ToolCallCard part={{ type: "tool-read", state: "output-available", toolCallId: "c1", input: undefined, output } as never} />,
		);
		const expected = [
			"\u001b[31mred\u001b[0m text",
			"see https://example.com/notes?q=1 and mailto:learner@example.com",
			"&lt;b&gt;bold?&lt;/b&gt; &lt;script&gt;alert(1)&lt;/script&gt;",
			"plain line",
		].join("\n");
		assert.deepEqual(preBodies(html), [expected], "the result body is the input text, React-escaped");
		assert.ok(!html.includes("<a "), "a URL never becomes an anchor");
		assert.ok(!html.includes("<script"), "HTML-like text never becomes an element");
		assert.ok(!html.includes("<b>"), "HTML-like text never becomes an element");
	});

	it("a {text} result body keeps the same fidelity", () => {
		const text = "\u001b[32mok\u001b[0m at https://example.com/x";
		const html = renderToStaticMarkup(
			<ToolCallCard part={{ type: "tool-read", state: "output-available", toolCallId: "c2", output: { text } } as never} />,
		);
		assert.deepEqual(preBodies(html), [text], "the text field renders verbatim");
		assert.ok(!html.includes("<a "), "a URL never becomes an anchor");
	});

	it("an error body keeps ANSI escapes and escapes HTML-like text", () => {
		const errorText = "\u001b[31mError\u001b[0m at https://example.com/x <i>frag</i>";
		const html = renderToStaticMarkup(
			<ToolCallCard
				part={{ type: "tool-read", state: "output-error", toolCallId: "c3", errorText, output: "unused output" } as never}
			/>,
		);
		assert.deepEqual(preBodies(html), ["\u001b[31mError\u001b[0m at https://example.com/x &lt;i&gt;frag&lt;/i&gt;"]);
		assert.ok(!html.includes("unused output"), "the error body replaces the result body");
	});

	it("an ordinary multiline result renders unchanged", () => {
		const output = "alpha\nbeta\n\n  indented\ngamma";
		const html = renderToStaticMarkup(
			<ToolCallCard part={{ type: "tool-ls", state: "output-available", toolCallId: "c4", output } as never} />,
		);
		assert.deepEqual(preBodies(html), [output]);
	});
});

describe("LiveToolCard encodes streaming input as JSON, not as an ANSI rendering", () => {
	it("distinguishes a real ESC from a literal backslash-u sequence in the streaming body", () => {
		const input = {
			note: `line ${ESC_CHAR}[31mred${ESC_CHAR}[0m`,
			body: `literal ${ESC_JSON_TEXT}[31m text`,
			source: "https://example.com/a?b=1",
			markup: '<img src=x onerror="alert(1)">',
		};
		const html = renderToStaticMarkup(<LiveToolCard part={{ type: "tool-read", state: "input-streaming", toolCallId: "c5", input } as never} />);
		const [body] = preBodies(html);
		assert.ok(body != null, "the streaming input body renders");
		// React escapes the JSON's own quotes (&quot;), so the expected text
		// carries that escaping; the backslash sequences stay untouched.
		assert.ok(
			body.includes(`&quot;note&quot;: &quot;line ${ESC_JSON_TEXT}[31mred${ESC_JSON_TEXT}[0m&quot;`),
			"the real control character is JSON-encoded to its six-character escape",
		);
		assert.ok(
			body.includes(`&quot;body&quot;: &quot;literal ${ESC_LITERAL_JSON}[31m text&quot;`),
			"an input that already held the six characters keeps a doubled backslash",
		);
		assert.ok(!html.includes(ESC_CHAR), "no raw control character reaches the markup");
		assert.ok(body.includes("https://example.com/a?b=1"), "the URL stays text");
		assert.ok(!html.includes("<a "), "the URL never becomes an anchor");
		assert.ok(body.includes("&lt;img"), "HTML-like text is escaped");
		assert.ok(!html.includes("<img"), "HTML-like text never becomes an element");
	});
});
