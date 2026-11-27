/**
 * Bidirectional text direction detection (UAX #9 first-strong heuristic).
 * Pure, browser-safe, zero dependencies — used by the markdown rehype layer
 * so wrapper blocks (lists, blockquotes, tables) resolve RTL even when their
 * children carry their own `dir="auto"` attributes.
 */

export type TextDirection = "rtl" | "ltr";

/** Strong RTL characters (Hebrew, Arabic/Persian, Syriac, Thaana, N'Ko,
 *  presentation forms, and RLM) — excluding weak Arabic/Persian digits and
 *  combining marks so numbers/diacritics never falsely claim direction. */
const RTL_STRONG_RE =
	/[\u05BE\u05C0\u05C3\u05C6\u05D0-\u05EA\u05EF-\u05F4\u0608\u060B\u060D\u061B-\u064A\u066D-\u066F\u0671-\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u070D\u0710\u0712-\u072F\u074D-\u07A5\u07B1-\u07EA\u07F4\u07F5\u07FA-\u0815\u081A\u0824\u0828\u0830-\u0858\u085E-\u088E\u08A0-\u08C9\u200F\uFB1D\uFB1F-\uFB28\uFB2A-\uFD3D\uFD50-\uFDFC\uFE70-\uFEFC\u{10800}-\u{10FFF}\u{1E800}-\u{1EEFF}]/u;

/** Any Unicode letter or LRM (checked after RTL_STRONG_RE, so every remaining
 *  letter is strong LTR). */
const LTR_STRONG_RE = /[\u200E\p{L}]/u;

/** Leading GitHub-style alert syntax inside callout blockquotes (md-blocks.tsx).
 *  Stripped before scanning so `[!IMPORTANT]` never forces an RTL callout LTR. */
const LEADING_ALERT_MARKER_RE = /^\s*\[!(?:note|tip|important|warning|caution)\][ \t]*/i;

/** Return the direction of the first strong directional character in `text`,
 *  or `null` when `text` contains only weak/neutral characters. */
export function detectTextDirection(text: string): TextDirection | null {
	const cleaned = text.replace(LEADING_ALERT_MARKER_RE, "");
	for (const ch of cleaned) {
		if (RTL_STRONG_RE.test(ch)) return "rtl";
		if (LTR_STRONG_RE.test(ch)) return "ltr";
	}
	return null;
}
