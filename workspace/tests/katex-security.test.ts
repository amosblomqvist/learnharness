/** GHSA-238p-pmpm-9mq7: inherited properties must not become KaTeX authority.
 * Output is inspected as inert strings/LinkeDOM; no resource or script is run.
 * node:test runs files in separate processes. Within this file all prototype
 * mutations are synchronous, non-concurrent, and restored even on failure.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import katex from "katex";
import { MessageResponse } from "../components/ai-elements/message.tsx";

(globalThis as Record<string, unknown>).React = React;
const blocked = String.raw`\href{https://katex-security.invalid/blocked}{blocked}`;
function withoutAuthority(html: string) {
	const { document } = parseHTML(html);
	assert.equal(document.querySelectorAll("[href], [src], a, img, script, iframe").length, 0, "inherited authority must not emit active HTML or URL attributes");
	assert.ok(html.includes("blocked"), "the formula was actually processed");
}
function withPrototype(key: string, value: unknown, run: () => void) {
	const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
	try {
		Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
		run();
	} finally {
		if (previous) Object.defineProperty(Object.prototype, key, previous);
		else Reflect.deleteProperty(Object.prototype, key);
	}
}
function markdown() {
	return renderToStaticMarkup(React.createElement(MessageResponse, { mode: "static" }, `$${blocked}$`));
}

describe("KaTeX prototype read-side security", { concurrency: false }, () => {
	it("ignores Object.prototype.trust in direct and app markdown rendering", () => {
		withPrototype("trust", true, () => {
			withoutAuthority(katex.renderToString(blocked, { strict: false }));
			withoutAuthority(markdown());
		});
	});
	it("ignores trust inherited from a custom options prototype", () => {
		const options = Object.assign(Object.create({ trust: true }), { strict: false });
		withoutAuthority(katex.renderToString(blocked, options));
	});
	it("ignores inherited schema defaults in direct and app markdown rendering", () => {
		withPrototype("default", true, () => {
			withoutAuthority(katex.renderToString(blocked, { strict: false }));
			withoutAuthority(markdown());
		});
	});
	it("ignores inherited schema processors, including for own trust:false", () => {
		withPrototype("processor", (value: unknown) => value === false ? true : value, () => {
			withoutAuthority(katex.renderToString(blocked, { strict: false, trust: false }));
			withoutAuthority(markdown());
		});
	});
	it("keeps own trust:false and own restricted callbacks restrictive", () => {
		withPrototype("trust", true, () => {
			withoutAuthority(katex.renderToString(blocked, { strict: false, trust: false }));
			const commands: string[] = [];
			withoutAuthority(katex.renderToString(blocked, {
				strict: false,
				trust: (context) => { commands.push(context.command); return context.command === "\\url"; },
			}));
			assert.deepEqual(commands, ["\\href"]);
		});
	});
	it("ignores inherited builtin namespace entries", () => {
		withPrototype("\\securityInherited", "INHERITED", () => {
			// The parser may reject it as an unknown function rather than an
			// undefined command; either way the inherited macro must not expand.
			assert.throws(() => katex.renderToString(String.raw`\securityInherited`), /KaTeX parse error/);
		});
	});
	it("does not restore an inherited macro as an own definition after a group", () => {
		const macros = Object.create({ "\\securityRestore": "INHERITED" });
		const html = katex.renderToString(String.raw`{\def\securityRestore{L}\securityRestore}`, { macros });
		assert.ok(parseHTML(html).document.querySelector(".katex-html")?.textContent?.includes("L"));
		assert.equal(Object.hasOwn(macros, "\\securityRestore"), false, "group restoration must delete, not promote an inherited value");
		assert.throws(() => katex.renderToString(String.raw`\securityRestore`, { macros }), /Undefined control sequence/);
	});
});
