import katex from "katex";

/**
 * THE LaTeX glyph seam (owner ruling, 2026-09-30): UI connectors that
 * want math symbols render the REAL LaTeX glyphs through KaTeX — the
 * app's math engine, already shipped (app/layout.tsx carries the
 * katex stylesheet) — never hand-rolled SVGs or font-dependent
 * unicode. Born for the chain table's logical connectives: premises
 * join with \land (∧), the conclusion separates with \implies (⟹) —
 * `A ∧ B ⟹ C`, not the misleading `A → B → C`.
 *
 * Prominent by the same ruling: the connectives render in the
 * theme's FOREGROUND (white in the dark theme) — the chain line's
 * logic is the payload, not decoration. Callers pass the class.
 */

/** Cached katex HTML per command — the glyph set is tiny and
 *  renderToString is pure; one render per command per process. */
const cache = new Map<string, string>();

/** The raw katex HTML for a LaTeX command (pure, sync — SSR-safe). */
export function latexGlyphHtml(cmd: string): string {
	let html = cache.get(cmd);
	if (html === undefined) {
		html = katex.renderToString(cmd, { throwOnError: false, output: "html" });
		cache.set(cmd, html);
	}
	return html;
}

/** One rendered LaTeX glyph. `cmd` is the LaTeX command ("\land",
 *  "\implies"); the output is aria-hidden — callers carry the textual
 *  aria-label (formatChainLine keeps the plain-text form). */
export function LatexGlyph({
	cmd,
	testid,
	className,
}: {
	cmd: string;
	testid?: string;
	className?: string;
}) {
	return (
		<span
			data-testid={testid}
			aria-hidden="true"
			className={className}
			// katex.renderToString is the library's own trusted output
			// (the same thing rehype-katex injects for markdown math).
			dangerouslySetInnerHTML={{ __html: latexGlyphHtml(cmd) }}
		/>
	);
}
