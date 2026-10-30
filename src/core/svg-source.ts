/** Two display-only repairs for inputs the old HTML embedding accepted.
 * Do not rewrite stored artifacts/downloads or attempt general XML repair.
 * Comments, CDATA and processing instructions are copied verbatim. */
export function svgImageSource(svg: string): string {
	let foundRoot = false;
	return svg.replace(
		/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<\/?[a-zA-Z](?:[^<>"']|"[^"]*"|'[^']*')*>|&nbsp;/g,
		(token) => {
			if (token.startsWith("<!--") || token.startsWith("<![CDATA[") || token.startsWith("<?")) return token;
			if (!foundRoot && /^<svg(?=[\s/>])/i.test(token)) {
				foundRoot = true;
				// Consume complete attribute values, so text mentioning xmlns
				// inside a different attribute cannot masquerade as a declaration.
				const attrs = token.matchAll(/\s([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g);
				const hasNamespace = Array.from(attrs).some((attr) => attr[1] === "xmlns");
				if (!hasNamespace) token = token.replace(/^<svg/i, '$& xmlns="http://www.w3.org/2000/svg"');
			}
			return token.replace(/&nbsp;/g, "&#160;");
		},
	);
}
