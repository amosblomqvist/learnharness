/** Research sources render as links, so only http(s) URLs may become one.
 * The researcher's fetch URLs are recorded before web_fetch rejects other
 * schemes, and research jobs saved earlier may still hold them. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchBriefCard } from "../components/artifacts/job-card.tsx";
import { parseSources } from "../src/agent/subagents/runner.ts";
import { isWebSourceUrl } from "../src/core/contracts/jobs.ts";

describe("research sources", () => {
	it("isWebSourceUrl accepts only http and https", () => {
		for (const url of ["https://example.com/a", "http://example.com", "HTTPS://EXAMPLE.COM"]) assert.equal(isWebSourceUrl(url), true, url);
		for (const url of ["smb://attacker.example/share", "file:///etc/passwd", "search-ms://x", "javascript:alert(1)", "mailto:a@b.c", "not a url", ""]) {
			assert.equal(isWebSourceUrl(url), false, url);
		}
	});

	it("fallback sources keep fetched http(s) URLs and drop every other scheme", () => {
		const sources = parseSources("A brief with no links.", [
			"smb://attacker.example/share",
			"https://example.com/paper",
			"search-ms://attacker.example/?query=x",
			"file:///System/Applications/Calculator.app",
			"http://example.org/notes",
		]);
		assert.deepEqual(sources, [
			{ title: "example.com", url: "https://example.com/paper" },
			{ title: "example.org", url: "http://example.org/notes" },
		]);
	});

	it("cited markdown links still win over fetched URLs", () => {
		const sources = parseSources("See [the paper](https://example.com/paper).", ["smb://attacker.example/share"]);
		assert.deepEqual(sources, [{ title: "the paper", url: "https://example.com/paper" }]);
	});

	it("a saved non-http(s) source renders as plain text, never a link", () => {
		const html = renderToStaticMarkup(
			ResearchBriefCard({
				output: {
					brief: "Brief.",
					sources: [
						{ title: "attacker.example", url: "smb://attacker.example/share" },
						{ title: "Calculator", url: "file:///System/Applications/Calculator.app" },
						{ title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Entropy" },
					],
				},
			}),
		);
		assert.ok(!html.includes("smb://") && !html.includes("file://"), html);
		assert.match(html, /attacker\.example/);
		assert.match(html, /<a href="https:\/\/en\.wikipedia\.org\/wiki\/Entropy" target="_blank"/);
		assert.equal(html.match(/<a /g)?.length, 1);
	});
});
