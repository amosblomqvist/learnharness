/** Pure checks and edits on a rendered HTML page (no file or network access). */

import { parseHTML } from "linkedom";

export const BLOCKED_FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"] as const;

const LINK_TAG = /<link\b[^>]*>[^\S\n]*\n?/gi;
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
// A quoted URL may hold `;` (Google Fonts' `wght@400;700`); an unquoted one runs to `)` or white space.
const IMPORT_RULE = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)|"([^"]*)"|'([^']*)'|([^\s;]+))[^;]*;?/gi;
// The doctype, with only white space and comments before it (neither runs anything).
const LEADING_DOCTYPE = /^(?:\s|<!--[\s\S]*?-->)*<!doctype\b[^>]*>/i;

/** Lets the page run its own inline scripts and styles and read `data:`/`blob:` media, and load nothing else. */
export const CONTENT_SECURITY_POLICY =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
export const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`;
const URL_VALUE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))/gi;
const EXTERNAL = /^\s*(?:https?:|\/\/)/i;
/** Attributes whose value the browser loads; `href` counts on every element except the links below. */
const LOADING_ATTRIBUTES = new Set(["src", "srcset", "poster", "data", "background", "href", "xlink:href"]);
/** Elements whose `href` is a link the reader follows, not something the page loads. */
const LINK_ELEMENTS = new Set(["a", "area"]);
/** `http-equiv` values a page may keep: the charset and a CSP of its own (which can only narrow the injected one). */
const ALLOWED_HTTP_EQUIV = new Set(["content-type", "content-security-policy"]);

function valueOf(match: RegExpMatchArray, first: number): string {
	return match[first] ?? match[first + 1] ?? match[first + 2] ?? "";
}

function hostOf(url: string): string | null {
	try {
		return new URL(url.trim().startsWith("//") ? `https:${url.trim()}` : url.trim()).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function isOnHost(url: string, hosts: readonly string[]): boolean {
	const host = hostOf(url);
	return host !== null && hosts.includes(host);
}

/** Removes every `<link>` (whatever its `rel` or attribute order) and every `@import` inside `<style>` that loads from one of `hosts`. */
export function stripFontLoads(html: string, hosts: readonly string[]): string {
	const withoutLinks = html.replace(LINK_TAG, (tag) => {
		const href = tag.match(HREF_ATTR);
		return href && isOnHost(valueOf(href, 1), hosts) ? "" : tag;
	});
	return withoutLinks.replace(STYLE_BLOCK, (_block, open: string, css: string, close: string) =>
		`${open}${css.replace(IMPORT_RULE, (rule: string, ...groups: (string | undefined)[]) => (isOnHost(importUrlOf(groups), hosts) ? "" : rule))}${close}`);
}

function importUrlOf(groups: readonly (string | number | undefined)[]): string {
	const url = groups.slice(0, 6).find((group) => typeof group === "string");
	return typeof url === "string" ? url : "";
}

/**
 * Puts `CSP_META` before any of the page's own markup: right after a leading doctype, else at the very start.
 * The HTML parser places a `<meta>` met before `<html>` first in the (implied) `<head>`, so no script, style or
 * `<head>` text in the page, a comment included, can come before the policy.
 */
export function withContentSecurityPolicy(html: string): string {
	const doctype = html.match(LEADING_DOCTYPE);
	return doctype ? `${doctype[0]}\n${CSP_META}${html.slice(doctype[0].length)}` : `${CSP_META}\n${html}`;
}

/** The text a renderer inlines for a script file: `</script` escaped, followed by the joining newline. */
export function toInlinedScript(fileText: string): string {
	return `${fileText.replace(/<\/script/gi, "<\\/script")}\n`;
}

/** Removes the first occurrence of `script` from `html`, or returns null when it is not there. */
export function stripInlinedScript(html: string, script: string): string | null {
	const at = html.indexOf(script);
	if (at < 0) return null;
	return `${html.slice(0, at)}${html.slice(at + script.length)}`;
}

function cssUrls(css: string): string[] {
	return [
		...[...css.matchAll(IMPORT_RULE)].map((m) => importUrlOf(m.slice(1))),
		...[...css.matchAll(URL_VALUE)].map((m) => valueOf(m, 1)),
	];
}

function attributeUrls(name: string, value: string): string[] {
	return name === "srcset" ? value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0] ?? "") : [value];
}

/** `<meta http-equiv="…">` written back as the parser read it (entities decoded), for the error message. */
function describeMeta(httpEquiv: string, content: string | null): string {
	return `<meta http-equiv="${httpEquiv}"${content === null ? "" : ` content="${content}"`}>`;
}

/**
 * What still loads from outside the page, read with an HTML parser so that entities, quoted `>` and text are
 * handled the way a browser handles them:
 * - element attributes the browser loads (`src`, `srcset`, `poster`, `data`, `background`, and `href` on every
 *   element except `<a>` and `<area>`) whose value starts with `http:`, `https:` or `//`;
 * - the same URLs in `@import` and `url(` inside `<style>` elements and `style` attributes;
 * - every `<meta http-equiv>` except `content-type` and `content-security-policy` (a CSP does not stop a refresh).
 * Text, such as an escaped code example (`&lt;img src="https://…"&gt;`), is not markup and is not checked.
 * The page's CSP (`withContentSecurityPolicy`) stops the forms this does not see.
 */
export function findExternalLoads(html: string): string[] {
	const { document } = parseHTML(html);
	const values: string[] = [];
	const metas: string[] = [];
	for (const element of document.querySelectorAll("*")) {
		const tag = element.localName.toLowerCase();
		for (const attribute of element.attributes) {
			const name = attribute.name.toLowerCase();
			if (name === "style") values.push(...cssUrls(attribute.value));
			else if (LOADING_ATTRIBUTES.has(name) && !(name === "href" && LINK_ELEMENTS.has(tag))) values.push(...attributeUrls(name, attribute.value));
		}
		if (tag === "style") values.push(...cssUrls(element.textContent ?? ""));
		if (tag === "meta" && element.hasAttribute("http-equiv")) {
			const httpEquiv = element.getAttribute("http-equiv") ?? "";
			if (!ALLOWED_HTTP_EQUIV.has(httpEquiv.trim().toLowerCase())) metas.push(describeMeta(httpEquiv, element.getAttribute("content")));
		}
	}
	return [...new Set([...values.filter((value) => EXTERNAL.test(value)).map((value) => value.trim()), ...metas])];
}
