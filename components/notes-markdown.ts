export interface MathRange {
	from: number;
	to: number;
	tex: string;
	display: boolean;
}

/** Index of the next unescaped `needle` at or after `from`; stops at a newline when `sameLine`. */
function findClose(text: string, from: number, needle: string, sameLine: boolean): number {
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") i++;
		else if (sameLine && c === "\n") return -1;
		else if (text.startsWith(needle, i)) return i;
	}
	return -1;
}

export function mathRanges(text: string): MathRange[] {
	const out: MathRange[] = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			i += 2;
		} else if (c !== "$") {
			i++;
		} else if (text.startsWith("$$", i)) {
			const close = findClose(text, i + 2, "$$", false);
			let tex = close < 0 ? "" : text.slice(i + 2, close);
			// Inside a quote, every continuation line carries its own `>` marker.
			if (/^ {0,3}>/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i))) tex = tex.replace(/\n {0,3}> ?/g, "\n");
			tex = tex.trim();
			if (tex) {
				out.push({ from: i, to: close + 2, tex, display: true });
				i = close + 2;
			} else {
				i += 2;
			}
		} else {
			const close = findClose(text, i + 1, "$", true);
			const tex = close < 0 ? "" : text.slice(i + 1, close);
			if (tex && !tex.startsWith(" ") && !tex.endsWith(" ")) {
				out.push({ from: i, to: close + 1, tex, display: false });
				i = close + 1;
			} else {
				i++;
			}
		}
	}
	return out;
}

export function quoteLineStarts(text: string): number[] {
	const out: number[] = [];
	let start = 0;
	while (start <= text.length) {
		const nl = text.indexOf("\n", start);
		const end = nl < 0 ? text.length : nl;
		if (/^ {0,3}>/.test(text.slice(start, end))) out.push(start);
		if (nl < 0) break;
		start = nl + 1;
	}
	return out;
}
