import { fromMarkdown } from "mdast-util-from-markdown";

export type SvgContentPart = { kind: "markdown" | "svg"; value: string };

/** Extract complete figures without interpreting SVG examples in ordinary code.
 * Original question/answer strings remain the persisted, graded source. */
export function svgContentParts(source: string): SvgContentPart[] {
	if (!/<svg[\s/>]/i.test(source)) return [{ kind: "markdown", value: source }];
	const protectedRanges: Array<{ start: number; end: number }> = [];
	const figures: Array<{ start: number; end: number; svg: string }> = [];
	function visit(node: ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>["children"][number]) {
		if (node.type === "code" || node.type === "inlineCode") {
			const start = node.position?.start.offset;
			const end = node.position?.end.offset;
			if (start === undefined || end === undefined) return;
			protectedRanges.push({ start, end });
			if (node.type === "code" && /^(svg|xml)$/i.test(node.lang ?? "") && /^<svg[\s/>]/i.test(node.value.trim()) && /<\/svg>\s*$/i.test(node.value)) {
				figures.push({ start, end, svg: node.value.trim() });
			}
		} else if ("children" in node) node.children.forEach(visit);
	}
	visit(fromMarkdown(source));
	// Tokenize tags rather than searching for the first closing string: comments,
	// quoted attributes, CDATA and nested svg elements can contain lookalikes.
	const tags = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<\/?[a-zA-Z](?:[^<>"']|"[^"]*"|'[^']*')*>/g;
	let start = -1;
	let depth = 0;
	for (const match of source.matchAll(tags)) {
		if (protectedRanges.some((range) => match.index >= range.start && match.index < range.end)) continue;
		const tag = match[0];
		if (/^<svg(?=[\s/>])/i.test(tag)) {
			if (depth === 0) start = match.index;
			if (!/\/\s*>$/.test(tag)) depth++;
			else if (depth === 0) figures.push({ start, end: match.index + tag.length, svg: tag });
		} else if (/^<\/svg\s*>/i.test(tag) && depth > 0 && --depth === 0) {
			const end = match.index + tag.length;
			figures.push({ start, end, svg: source.slice(start, end) });
		}
	}
	const parts: SvgContentPart[] = [];
	let cursor = 0;
	for (const figure of figures.sort((a, b) => a.start - b.start)) {
		if (figure.start < cursor) continue;
		if (figure.start > cursor) parts.push({ kind: "markdown", value: source.slice(cursor, figure.start) });
		parts.push({ kind: "svg", value: figure.svg });
		cursor = figure.end;
	}
	if (cursor < source.length) parts.push({ kind: "markdown", value: source.slice(cursor) });
	return parts;
}
