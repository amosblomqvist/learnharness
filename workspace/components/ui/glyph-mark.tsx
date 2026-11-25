"use client";

/**
 * GYpH-true ✓/✗ marks (owner's "old LaTeX style" round 6) — the real
 * Computer-Modern-adjacent hand-drawn shapes extracted as vector outlines
 * from the system Zapf Dingbats font (the exact font LaTeX pifont uses for
 * \ding{51} and \ding{55}), baked in as static SVG geometry (the KaTeX
 * pattern: glyph outlines are embedded, never rendered as font text).
 *
 * Bounds carry the ink box so each figure scales to its own geometry
 * (viewBox = minX -yMax w h with a y-flip on the path — SVG y grows
 * downward, font y grows upward).
 */

export type MarkKind = "check" | "x";

const GLYPHS: Record<MarkKind, { d: string; x: number; y: number; w: number; h: number }> = {
	// ✓ U+2713 (LaTeX \ding{51}) — bounds (78, -20, 1470, 1444)
	check: {
		x: 78,
		y: -1444,
		w: 1392,
		h: 1464,
		d: "M1470 1409Q1211 1120 984.5 811.0Q758 502 568 177Q554 153 533 110Q468 -20 348 -20Q297 -20 264.0 -5.0Q231 10 203 47Q180 79 160.0 130.5Q140 182 113 282Q111 288 109 297Q78 408 78 436Q78 493 144.5 540.5Q211 588 276 588Q297 588 310.0 575.5Q323 563 340 522Q350 497 365 454Q399 358 422 358Q442 358 580 577Q712 786 807 928Q940 1127 1009.5 1215.5Q1079 1304 1135 1350Q1184 1390 1261.0 1413.0Q1338 1436 1456 1444Z",
	},
	// ✗ U+2717 BALLOT X (LaTeX \ding{55} — the owner's correct xmark; the
	// previous embedded text was ✕ U+2715/\ding{53} by mistake) — bounds
	// (0, -145, 1169, 1346)
	x: {
		x: 0,
		y: -1346,
		w: 1169,
		h: 1491,
		d: "M1169 1266Q1065 1134 964.5 1004.0Q864 874 766 743Q818 637 872.0 521.5Q926 406 983 276L954 252L956 231Q947 222 936.5 214.5Q926 207 913 201L924 168Q913 148 896.0 135.5Q879 123 859 119Q838 120 769.5 217.5Q701 315 588 504Q481 357 380.5 201.0Q280 45 186 -121Q162 -133 136.0 -139.0Q110 -145 82 -145H70Q41 -118 23.5 -87.5Q6 -57 6 -39Q6 -29 9.0 -15.0Q12 -1 18 20L0 53Q36 144 152.5 309.5Q269 475 469 723Q429 829 388.5 944.0Q348 1059 299 1206Q312 1234 327.0 1251.0Q342 1268 354 1268Q362 1268 370.0 1263.5Q378 1259 387 1249Q393 1255 401.0 1258.5Q409 1262 418 1262H426Q433 1272 441.0 1279.0Q449 1286 459 1292H461Q490 1292 571 1120Q620 1016 653 950Q712 1018 805 1129Q983 1341 1001 1341Q1012 1341 1029.5 1331.5Q1047 1322 1071 1303L1116 1346Q1132 1329 1145.5 1309.0Q1159 1289 1169 1266Z",
	},
};

export function GlyphMark({ kind, className }: { kind: MarkKind; className?: string }) {
	const g = GLYPHS[kind];
	return (
		<svg
			aria-hidden
			className={className}
			viewBox={`${g.x} ${g.y} ${g.w} ${g.h}`}
			fill="currentColor"
		>
			<path d={g.d} transform="scale(1,-1)" />
		</svg>
	);
}
