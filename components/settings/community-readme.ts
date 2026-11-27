import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

/**
 * Third-party README and release notes, shown without loading anything.
 * Images become links (the host pipeline would only show a blocked badge),
 * and relative paths point at the repository at the listed tag.
 */
export function communityMarkdown(markdown: string, repository: string, tag: string): string {
	const base = `https://github.com/${repository}/blob/${encodeURIComponent(tag)}/`;
	const resolve = (url: string) => {
		if (!url) return url;
		// The page's own anchors would point into the app; GitHub shows the README there.
		if (url.startsWith("#")) return `https://github.com/${repository}/tree/${encodeURIComponent(tag)}${url}`;
		try { return new URL(url).href; } catch { /* relative */ }
		try { return new URL(url.replace(/^\.?\//, ""), base).href; } catch { return url; }
	};
	const label = (text: string) => (text.trim() || "Image").replace(/[[\]\\]/g, "\\$&").replace(/\s+/g, " ");
	const edits: [start: number, end: number, text: string][] = [];
	const span = (node: Nodes) => [node.position?.start.offset, node.position?.end.offset] as const;
	// Links cannot nest, so an image inside a link (a badge) keeps only its text.
	const visit = (node: Nodes, linked = false) => {
		const [start, end] = span(node);
		if (start !== undefined && end !== undefined) {
			if (node.type === "image") { edits.push([start, end, linked ? label(node.alt ?? "") : `[${label(node.alt ?? "")}](<${resolve(node.url)}>)`]); return; }
			if (node.type === "imageReference") { edits.push([start, start + 1, ""]); return; }
			if (node.type === "definition") { edits.push([start, end, `[${node.label ?? node.identifier}]: <${resolve(node.url)}>`]); return; }
			if (node.type === "link" && node.children.length) {
				const [inner] = span(node.children[0]!), [, innerEnd] = span(node.children.at(-1)!);
				if (inner !== undefined && innerEnd !== undefined) {
					edits.push([start, inner, "["], [innerEnd, end, `](<${resolve(node.url)}>)`]);
					node.children.forEach(child => visit(child, true));
					return;
				}
			}
			if (node.type === "html") { edits.push([start, end, html(node.value, resolve)]); return; }
		}
		if ("children" in node) node.children.forEach(child => visit(child as Nodes, linked));
	};
	visit(fromMarkdown(markdown));
	let out = markdown;
	for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0] || b[1] - a[1])) out = out.slice(0, start) + text + out.slice(end);
	return out;
}

function html(value: string, resolve: (url: string) => string) {
	const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find(part => part !== undefined);
	const decode = (text: string) => text.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	return value
		.replace(/(<a\b[^>]*\shref\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (_, head: string, double?: string, single?: string) => `${head}"${escape(resolve(decode(double ?? single ?? "")))}"`)
		.replace(/<img\b[^>]*>/gi, tag => {
			const src = attribute(tag, "src");
			const alt = escape(decode(attribute(tag, "alt") ?? "").trim() || "Image");
			return src ? `<a href="${escape(resolve(decode(src)))}">${alt}</a>` : alt;
		});
}
