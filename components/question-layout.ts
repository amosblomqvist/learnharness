/**
 * ADAPTIVE QUESTION LAYOUT (owner-approved plan, session-appearance-layout).
 *
 * While a native question is expanded and "Adapt question layout" is on,
 * the bottom region may widen beyond the default composer width:
 *
 * - STACKED (every native question): the card is the larger of the default
 *   width and its widest content that cannot wrap (code lines, display math,
 *   long words), capped at the transcript width.
 * - TWO COLUMNS (questions with options only): question on the left,
 *   options + confidence on the right, "Your thinking" full width below.
 *   Trigger: at the default stacked width the question part is at least as
 *   tall as the answer part. Fit: both column minimums side by side within
 *   the transcript width. Each column is at least 23rem (or its unbreakable
 *   content) and at most 70ch (raised by unbreakable content and by the
 *   natural width of diagrams/images). Widths: find the lowest card height
 *   reachable, then narrow each column as far as it can go at that height.
 *
 * Diagrams/images count as shrinkable: their natural width is a PREFERRED
 * minimum. When a question diagram cannot keep its natural width beside the
 * answer column, the question column takes all the remaining width (the
 * answer column stays at its minimum) so the diagram shrinks only as far as
 * it must.
 *
 * The solver below is pure (heights come from a callback) so it can be
 * tested without a browser; the DOM probe measures cloned content off-screen
 * so the live dock never reflows during the search. Nothing here runs on
 * typing: callers recompute only on question/content/width/settings change.
 */

/** One column's measured constraints (px, padding and borders included). */
export interface ColumnSpec {
	/** Hard floor: max(23rem, widest unbreakable content). */
	min: number;
	/** Preferred floor: also covers diagram/image natural width. */
	preferredMin: number;
	/** Useful maximum: max(70ch, unbreakable, media natural) incl. padding. */
	max: number;
	/** Column height at a width (px). */
	height(width: number): number;
	/** The widths whose heights were measured (ascending, from `min`, with
	 *  `preferredMin` and `max`). When present the solver chooses only
	 *  among them, so every height it compares is a measured one. */
	widths?: readonly number[];
}

/** `binding`: the available width limited the result (a wider budget could
 *  change it). */
export type QuestionLayout =
	| { kind: "stacked"; width: number; binding: boolean }
	| { kind: "columns"; question: number; answer: number; width: number; height: number; binding: boolean };

/** Heights within this many px count as equal (sub-pixel rounding). */
const HEIGHT_TOLERANCE = 1;
/** Width search granularity (px): coarse steps keep the evaluations few. */
export const WIDTH_STEP = 16;

/** The stacked card width: never below the default, widened to fit
 *  unbreakable content, never beyond the available width (unless the
 *  available width is itself below the default — the container's own
 *  w-full shrink handles narrow windows). */
export function stackedWidth(base: number, need: number, available: number): number {
	return Math.max(base, Math.min(Math.max(base, need), available));
}

/** Two-column trigger: question part at least as tall as the answer part,
 *  both measured at the default stacked width. */
export function twoColumnTriggered(questionHeight: number, answerHeight: number): boolean {
	return questionHeight + HEIGHT_TOLERANCE >= answerHeight;
}

/** Ascending widths from min to max at WIDTH_STEP, max included. */
export function widthGrid(min: number, max: number, step = WIDTH_STEP): number[] {
	const lo = Math.ceil(min);
	const hi = Math.max(lo, Math.floor(max));
	const out: number[] = [];
	for (let w = lo; w < hi; w += step) out.push(w);
	out.push(hi);
	return out;
}

/** First index in [lo, hi] where pred holds (pred monotone false→true); hi + 1 if none. */
function firstTrue(lo: number, hi: number, pred: (i: number) => boolean): number {
	let a = lo;
	let b = hi + 1;
	while (a < b) {
		const mid = (a + b) >> 1;
		if (pred(mid)) b = mid;
		else a = mid + 1;
	}
	return a;
}

/**
 * Column heights never grow when a column widens (wrapping only loosens),
 * so the search is binary rather than exhaustive: each height evaluation is
 * a real layout of the probe, and resizes must stay cheap.
 */
function solveWithFloors(q: ColumnSpec, a: ColumnSpec, qMin: number, aMin: number, available: number, step: number) {
	if (qMin + aMin > available + 0.5) return null;
	const qMax = Math.max(qMin, Math.min(Math.max(q.max, qMin), available - aMin));
	const aMax = Math.max(aMin, Math.min(Math.max(a.max, aMin), available - qMin));
	const grid = (c: ColumnSpec, lo: number, hi: number) =>
		c.widths ? c.widths.filter((w) => w >= lo - 0.5 && w <= hi + 0.5) : widthGrid(lo, hi, step);
	const qs = grid(q, qMin, qMax);
	const as = grid(a, aMin, aMax);
	if (!qs.length || !as.length) return null;
	const qMemo = new Map<number, number>();
	const aMemo = new Map<number, number>();
	const qh = (i: number) => { let h = qMemo.get(i); if (h === undefined) qMemo.set(i, (h = q.height(qs[i]!))); return h; };
	const ah = (j: number) => { let h = aMemo.get(j); if (h === undefined) aMemo.set(j, (h = a.height(as[j]!))); return h; };
	// The widest answer width the budget leaves beside question width i.
	const aFor = (i: number) => firstTrue(0, as.length - 1, (j) => as[j]! > available - qs[i]! + 0.5) - 1;
	// Question widths that leave room for at least the answer floor.
	const iLast = firstTrue(0, qs.length - 1, (i) => aFor(i) < 0) - 1;
	if (iLast < 0) return null;
	// 1. The lowest card height: the question side shrinks as it widens, the
	// answer side (given the remaining budget) grows — the optimum is at
	// their crossing, or the neighbour just before it.
	const cost = (i: number) => Math.max(qh(i), ah(aFor(i)));
	const cross = firstTrue(0, iLast, (i) => qh(i) <= ah(aFor(i)));
	let best = Infinity;
	for (const i of [cross - 1, cross]) if (i >= 0 && i <= iLast) best = Math.min(best, cost(i));
	// 2. Narrow each column as far as it can go while fitting that height.
	// The optimal pair already satisfies both, so the narrowest qualifying
	// widths are no wider than it and still fit the budget.
	const qi = firstTrue(0, qs.length - 1, (i) => qh(i) <= best + HEIGHT_TOLERANCE);
	const aj = firstTrue(0, as.length - 1, (j) => ah(j) <= best + HEIGHT_TOLERANCE);
	// Unbound: both columns reached their useful maximum within the budget.
	const binding = Math.max(q.max, qMin) + Math.max(a.max, aMin) > available + 0.5;
	return { question: qs[qi]!, answer: as[aj]!, height: best, binding };
}

/** Two-column widths, or null when the columns cannot fit side by side.
 *  Preferred floors (media at natural width) first. A question diagram that
 *  cannot keep its natural width beside the answer column takes all the
 *  remaining width (answer at its minimum). Hard floors last. */
export function solveColumns(q: ColumnSpec, a: ColumnSpec, available: number, step = WIDTH_STEP) {
	const preferred = solveWithFloors(q, a, q.preferredMin, a.preferredMin, available, step);
	if (preferred) return preferred;
	const rest = Math.floor(available - a.min);
	if (q.preferredMin > q.min && q.preferredMin > rest && rest >= q.min) {
		return { question: rest, answer: a.min, height: Math.max(q.height(rest), a.height(a.min)), binding: true };
	}
	const hard = solveWithFloors(q, a, q.min, a.min, available, step);
	// Media below its natural width: a wider budget would change the result.
	return hard && { ...hard, binding: true };
}

export interface LayoutInput {
	/** Maximum card inner width (px): the transcript width less chrome. */
	available: number;
	/** The default card inner width (46rem container less chrome). */
	base: number;
	/** Widest unbreakable content in the stacked layout (px, card inner). */
	stackedNeed: number;
	/** Present only for questions with options. */
	columns?: { triggered: boolean; question: ColumnSpec; answer: ColumnSpec };
}

export function solveQuestionLayout(input: LayoutInput, step = WIDTH_STEP): QuestionLayout {
	if (input.columns?.triggered) {
		const solved = solveColumns(input.columns.question, input.columns.answer, input.available, step);
		if (solved) return { kind: "columns", ...solved, width: solved.question + solved.answer };
	}
	// Triggered columns that did not fit could fit in a wider budget.
	const binding = !!input.columns?.triggered || Math.max(input.base, input.stackedNeed) > input.available + 0.5;
	return { kind: "stacked", width: stackedWidth(input.base, input.stackedNeed, input.available), binding };
}

// ─── DOM probe ────────────────────────────────────────────────────────────────────

/** Column classes shared by the live columns and the probe: the probe
 *  must lay content out exactly as the real column does. */
// 24px between the columns (12px each side), 16px at the card's edges —
// with no divider, two full 16px paddings read as a doubled gap (owner).
export const QUESTION_COLUMN_PAD = "pl-4 pr-3 pt-3 pb-2";
/** The stacked card's question area: label, question, options and
 *  confidence share its 16px sides (live area and probe alike). */
export const STACKED_AREA_PAD = "px-4 pt-3";
/** The confidence row's vertical rhythm, in either arrangement. */
export const CONFIDENCE_ROW_PAD = "pt-1.5 pb-3.5";
export const ANSWER_COLUMN_FRAME = "flex flex-col justify-center";
export const ANSWER_OPTIONS_PAD = "pl-3 pr-4 pt-3";
/** The confidence row's sides in the answer column (matches the options). */
/** The answer column's own side padding (pl-3 + pr-4) and the space between
 *  the two columns' contents (pr-3 + pl-3), as CSS lengths: answered cards,
 *  whose padding is the card's, rebuild the same geometry from them. */
export const ANSWER_COLUMN_INSET_CSS = "1.75rem";
export const COLUMN_GAP_CSS = "1.5rem";

/** The root font size (px) the rem-based geometry below scales with. */
export function rootRem(doc: Document | undefined = typeof document === "undefined" ? undefined : document): number {
	const px = doc ? parseFloat(getComputedStyle(doc.documentElement).fontSize) : NaN;
	return px > 0 ? px : 16;
}

/** The question card's geometry at a root font size (px): the dock
 *  container's width (46rem), its horizontal chrome (px-4 padding + the
 *  shell's 1px borders), the card's default inner width (the container less
 *  that) and the column floor (owner: half the default card, 23rem). */
export function questionCardGeometry(rem = 16) {
	const chrome = 2 * rem + 2;
	return { container: 46 * rem, chrome, base: 46 * rem - chrome, floor: 23 * rem };
}

/** The widest the dock container may grow (px): the Transcript width
 *  setting (rem; null = Full) or, at Full, the bottom block less 1rem — the
 *  transcript's px-6 and the dock's px-4 differ by 0.5rem per side, so the
 *  card's shell then lines up with the transcript's text. */
export function dockContainerMax(blockWidth: number, rem: number, transcriptMaxWidth: number | null): number {
	const cap = transcriptMaxWidth === null ? Infinity : transcriptMaxWidth * rem;
	return Math.min(cap, blockWidth - rem);
}

/** Everything a solved layout's measurements depend on besides content and
 *  widths: the reading font and size, and the markdown styles that change
 *  text metrics (heading weight, code ligatures). */
export function layoutFontKey(appearance: {
	fontFamily?: string | null;
	proseFontSize: number;
	codeLigatures?: boolean;
	mdRendering?: { headingWeight?: number };
}): string {
	return `${appearance.fontFamily ?? ""}|${appearance.proseFontSize}|${appearance.codeLigatures ? 1 : 0}|${appearance.mdRendering?.headingWeight ?? ""}`;
}

export interface QuestionParts {
	/** Where the probe is attached (inherits fonts/variables). */
	root: HTMLElement;
	/** Label + question text + context. */
	question: HTMLElement;
	/** The options list (absent for text-answer questions). */
	options: HTMLElement | null;
	/** The confidence row (quizzes only). */
	confidence: HTMLElement | null;
	/** Where diagrams/images are LIVE, when question/options are themselves
	 *  stand-ins (answered cards): natural sizes are read there. */
	media?: { question: HTMLElement; options: HTMLElement | null };
}

/** A rendered diagram: the chart svg, its holder's direct child (md-blocks),
 *  never the toolbar icons beside it. */
const MEDIA_SVG = '[data-testid="md-mermaid"][data-streamdown="mermaid"] > div > svg';

/** Clones keep the live images' intrinsic sizes even before they decode. */
export function cloneWithImageSizes(live: HTMLElement): Node {
	const clone = live.cloneNode(true) as HTMLElement;
	const liveImgs = live.querySelectorAll("img");
	clone.querySelectorAll("img").forEach((img, i) => {
		const source = liveImgs[i];
		if (!source?.naturalWidth || img.hasAttribute("width")) return;
		img.setAttribute("width", String(source.naturalWidth));
		img.setAttribute("height", String(source.naturalHeight));
	});
	return clone;
}

/** Typing surfaces (the Other answer field) in a clone, emptied back to
 *  their placeholder: a draft is never content the layout depends on. */
const DRAFT_FIELD = '[role="textbox"], [contenteditable]:not([contenteditable="false"])';
function withoutDrafts(clone: HTMLElement): HTMLElement {
	for (const field of clone.querySelectorAll<HTMLElement>(DRAFT_FIELD)) {
		field.replaceChildren();
		field.dataset.empty = "true";
	}
	return clone;
}

/** Width of 70ch in the reading font at its current size. */
const MEASURE_CH = 70;

/**
 * Off-screen measurer over clones of the live question parts. Heights are
 * memoized per width; dispose() removes the probe. Clipped by a zero-size
 * overflow-hidden wrapper so it never adds scrollable overflow anywhere.
 */
export function createQuestionProbe(parts: QuestionParts, host: HTMLElement = parts.root) {
	const doc = parts.root.ownerDocument;
	const wrapper = doc.createElement("div");
	wrapper.setAttribute("aria-hidden", "true");
	wrapper.setAttribute("data-question-layout-probe", "");
	wrapper.setAttribute("inert", "");
	Object.assign(wrapper.style, {
		position: "absolute", left: "0", top: "0", width: "0", height: "0",
		overflow: "hidden", visibility: "hidden", pointerEvents: "none",
		// Measurement reflows stay inside the probe.
		contain: "strict",
	});
	const place = (el: HTMLElement) => {
		Object.assign(el.style, { position: "absolute", left: "0", top: "0", boxSizing: "border-box" });
		wrapper.append(el);
		return el;
	};
	const div = (className: string) => {
		const el = doc.createElement("div");
		el.className = className;
		return el;
	};
	// One clone of each part, MOVED between the two arrangements below.
	// Drafts never count: a typed Other answer measures as the empty field.
	const question = cloneWithImageSizes(parts.question) as HTMLElement;
	const options = parts.options ? withoutDrafts(cloneWithImageSizes(parts.options) as HTMLElement) : null;
	const confidence = options && parts.confidence ? (parts.confidence.cloneNode(true) as HTMLElement) : null;
	// STACKED: the live stacked card's box model (16px sides throughout).
	// flow-root sections keep each part's own margins inside its height.
	const sBox = place(div(STACKED_AREA_PAD));
	const sQuestion = div("flow-root");
	const sAnswer = div("flow-root");
	sBox.append(sQuestion, sAnswer);
	// TWO COLUMNS: the live columns' box model.
	const qBox = place(div(QUESTION_COLUMN_PAD));
	let aBox: HTMLElement | null = null;
	let pad: HTMLElement | null = null;
	if (options) {
		aBox = place(div(ANSWER_COLUMN_FRAME));
		pad = div(ANSWER_OPTIONS_PAD);
		aBox.append(pad);
	}
	const arrange = (mode: "stacked" | "columns") => {
		if (mode === "stacked") {
			sQuestion.append(question);
			if (options) sAnswer.append(options);
			if (confidence) {
				confidence.className = CONFIDENCE_ROW_PAD;
				sAnswer.append(confidence);
			}
			return;
		}
		qBox.append(question);
		// Confidence scrolls with the options in both arrangements (owner):
		// in the answer column's scroller, whose padding supplies its sides.
		if (options) pad!.append(options);
		if (confidence) {
			confidence.className = CONFIDENCE_ROW_PAD;
			pad!.append(confidence);
		}
	};
	arrange("stacked");
	const ch = doc.createElement("div");
	ch.className = "lh-prose";
	Object.assign(ch.style, { position: "absolute", width: `${MEASURE_CH}ch`, height: "0" });
	wrapper.append(ch);
	host.append(wrapper);

	const cache = new WeakMap<HTMLElement, Map<number, number>>();
	const height = (box: HTMLElement, width: number) => {
		let byWidth = cache.get(box);
		if (!byWidth) cache.set(box, (byWidth = new Map()));
		const hit = byWidth.get(width);
		if (hit !== undefined) return hit;
		box.style.width = `${width}px`;
		const h = box.getBoundingClientRect().height;
		byWidth.set(width, h);
		return h;
	};
	/** Horizontal overflow at a width: the box's own scrollable overflow
	 *  plus any sideways scroller (code, display math, wide tables) —
	 *  overflow-visible descendants already show in the box itself. Clipped
	 *  (hidden/clip) boxes are deliberate truncation, not content. */
	const overflowAt = (box: HTMLElement, width: number) => {
		box.style.width = `${width}px`;
		let over = Math.max(0, box.scrollWidth - box.clientWidth);
		for (const el of box.querySelectorAll<HTMLElement>("*")) {
			const d = el.scrollWidth - el.clientWidth;
			if (el.clientWidth <= 0 || d <= over) continue;
			if (/^(auto|scroll)$/.test(getComputedStyle(el).overflowX)) over = d;
		}
		return over;
	};
	/** The narrowest width (≥ start) at which nothing overflows. Overflow
	 *  that does not shrink when widened is not width-dependent; ignore it.
	 *  Any overflow counts — even under a pixel it shows a scrollbar — and
	 *  the result carries 1px of slack: scrollWidth/clientWidth are rounded
	 *  integers, the content's real width is fractional (more so at 2x). */
	const unbreakable = (box: HTMLElement, start: number) => {
		const o1 = overflowAt(box, start);
		if (o1 <= 0) return start;
		const w2 = Math.ceil(start + o1) + 1;
		const o2 = overflowAt(box, w2);
		if (o2 <= 0) return w2;
		return o2 < o1 ? Math.ceil(w2 + o2) + 1 : start;
	};
	/** Natural width of diagrams and images, plus the column's own
	 *  horizontal padding/border. Read from the LIVE part (clones of images
	 *  may not have decoded yet). Only rendered diagrams count — never icon
	 *  or KaTeX glyph svgs (their viewBoxes are not display sizes). */
	const mediaNatural = (box: HTMLElement) => {
		const source = parts.media ?? parts;
		const live = box === qBox ? source.question : source.options;
		if (!live) return 0;
		let widest = 0;
		for (const svg of live.querySelectorAll<SVGSVGElement>(MEDIA_SVG)) {
			// The holder's font-parity cap (md-blocks) is the chart's size at
			// the reading font; mermaid's own inline cap is the fallback.
			const holder = svg.parentElement?.style.maxWidth ?? "";
			const capped = holder.endsWith("px") ? parseFloat(holder) : 0;
			const inline = svg.style.maxWidth.endsWith("px") ? parseFloat(svg.style.maxWidth) : 0;
			const natural = capped > 0 ? capped : inline > 0 ? inline : svg.viewBox?.baseVal?.width ?? 0;
			if (natural > widest) widest = natural;
		}
		for (const img of live.querySelectorAll("img")) if (img.naturalWidth > widest) widest = img.naturalWidth;
		if (!widest) return 0;
		const cs = getComputedStyle(box);
		return Math.ceil(widest + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
			+ parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth));
	};
	const chPx = ch.getBoundingClientRect().width;

	return {
		/** The stacked card's question area (at the card's inner width). */
		stacked: sBox,
		/** Question part and answer part heights in the stacked card. */
		stackedHeights(width: number): [number, number] {
			sBox.style.width = `${width}px`;
			return [sQuestion.getBoundingClientRect().height, sAnswer.getBoundingClientRect().height];
		},
		/** Move the parts into the two-column boxes (after stacked measuring). */
		toColumns() { arrange("columns"); },
		question: qBox,
		answer: aBox,
		chPx,
		height,
		unbreakable,
		mediaNatural,
		/** Column constraints for the two-column solver. */
		column(box: HTMLElement, floor: number): ColumnSpec {
			const cs = getComputedStyle(box);
			const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
				+ parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
			const min = Math.max(floor, unbreakable(box, floor));
			const preferredMin = Math.max(min, mediaNatural(box));
			const max = Math.max(preferredMin, Math.ceil(chPx + chrome));
			return { min, preferredMin, max, height: (w) => height(box, Math.round(w)) };
		},
		dispose() { wrapper.remove(); },
	};
}

export interface MeasureOptions {
	/** Maximum card inner width (px). */
	available: number;
	/** Default card inner width (px). */
	base: number;
	/** Column floor (23rem in px). */
	floor: number;
}

/** One column's content-only measurements: everything but the window. */
export interface MeasuredColumn {
	min: number;
	preferredMin: number;
	max: number;
	/** Heights at min, min + WIDTH_STEP, …, and max (ascending widths). */
	widths: number[];
	heights: number[];
}

/**
 * Everything the layout needs that depends only on the question's content
 * and the reading font — never on the window. Measured ONCE per question;
 * a window/transcript width change re-decides from these numbers by
 * arithmetic alone (solveMeasured): no DOM reads, no forced layout.
 */
export interface QuestionMeasure {
	stackedNeed: number;
	/** Present only for questions with options. */
	columns?: { triggered: boolean; question: MeasuredColumn; answer: MeasuredColumn };
}

type Probe = ReturnType<typeof createQuestionProbe>;

/**
 * A column's height curve on its width grid. Height never grows as a
 * column widens, so where the two ends of a stretch agree, everything
 * between agrees too: only the stretches where wrapping changes are split
 * further. A short options column costs two measurements.
 */
export function heightCurve(widths: number[], height: (w: number) => number): number[] {
	const out = new Array<number>(widths.length);
	const fill = (lo: number, hi: number) => {
		if (hi - lo < 2) return;
		if (Math.abs(out[lo]! - out[hi]!) < HEIGHT_TOLERANCE) {
			for (let i = lo + 1; i < hi; i++) out[i] = out[lo]!;
			return;
		}
		const mid = (lo + hi) >> 1;
		out[mid] = height(widths[mid]!);
		fill(lo, mid);
		fill(mid, hi);
	};
	out[0] = height(widths[0]!);
	if (widths.length > 1) out[widths.length - 1] = height(widths[widths.length - 1]!);
	fill(0, widths.length - 1);
	return out;
}

/** The widths a column's curve is measured at: its grid from `min`,
 *  plus `preferredMin` (a diagram's natural width) when it falls between. */
export function curveWidths(min: number, preferredMin: number, max: number): number[] {
	const widths = widthGrid(min, max);
	const p = Math.ceil(preferredMin);
	if (!widths.includes(p) && p > widths[0]! && p < widths.at(-1)!) {
		widths.splice(widths.findIndex((w) => w > p), 0, p);
	}
	return widths;
}

/** Height at any width from the curve: exact at measured widths; between
 *  them, the measured width below (never an underestimate — narrower never
 *  wraps less). Only a diagram column given "all the rest" asks between. */
export function curveHeight(c: MeasuredColumn, width: number): number {
	let lo = 0;
	let hi = c.widths.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (c.widths[mid]! <= width + 0.5) lo = mid;
		else hi = mid - 1;
	}
	return c.heights[lo]!;
}

/** The content-only pass: overflow scans, diagram widths, 70ch, the
 *  trigger heights and both columns' height curves. */
export function measureQuestionContent(probe: Probe, options: Pick<MeasureOptions, "base" | "floor">): QuestionMeasure {
	const { base, floor } = options;
	// Stacked, as the live stacked card lays out: its widest unbreakable
	// content, and the trigger — the question part at least as tall as the
	// answer part (options + confidence), both at the default width.
	const stackedNeed = probe.unbreakable(probe.stacked, base);
	if (!probe.answer) return { stackedNeed };
	const [qh, ah] = probe.stackedHeights(base);
	const triggered = twoColumnTriggered(qh, ah);
	probe.toColumns();
	// Not triggered: the columns are never used, the curves never needed.
	const column = (box: HTMLElement): MeasuredColumn => {
		const spec = probe.column(box, floor);
		const widths = triggered ? curveWidths(spec.min, spec.preferredMin, spec.max) : [spec.min];
		const heights = triggered ? heightCurve(widths, (w) => probe.height(box, w)) : [0];
		return { min: spec.min, preferredMin: spec.preferredMin, max: spec.max, widths, heights };
	};
	return { stackedNeed, columns: { triggered, question: column(probe.question), answer: column(probe.answer) } };
}

/** Decide the layout for a budget from the measured numbers alone. */
export function solveMeasured(m: QuestionMeasure, input: Pick<MeasureOptions, "available" | "base">): QuestionLayout {
	const spec = (c: MeasuredColumn): ColumnSpec => ({
		min: c.min, preferredMin: c.preferredMin, max: c.max, widths: c.widths, height: (w) => curveHeight(c, w),
	});
	return solveQuestionLayout({
		available: input.available,
		base: input.base,
		stackedNeed: m.stackedNeed,
		...(m.columns ? { columns: { triggered: m.columns.triggered, question: spec(m.columns.question), answer: spec(m.columns.answer) } } : {}),
	});
}

/** Measure the live parts once and decide. One probe per call; removed after. */
export function measureQuestionLayout(parts: QuestionParts, options: MeasureOptions, host?: HTMLElement): { layout: QuestionLayout; measure: QuestionMeasure } {
	const probe = createQuestionProbe(parts, host);
	try {
		const measure = measureQuestionContent(probe, options);
		return { layout: solveMeasured(measure, options), measure };
	} finally {
		probe.dispose();
	}
}

/**
 * A persistent, empty measuring box inside `root`: strict containment makes
 * it its own layout root, so probes inserted and removed inside it never
 * invalidate the page around it (a probe appended to the card itself
 * relaid out the whole transcript — on every resize frame, per card).
 */
export function createProbeHost(root: HTMLElement): HTMLElement {
	const host = root.ownerDocument.createElement("div");
	host.setAttribute("aria-hidden", "true");
	host.setAttribute("inert", "");
	host.setAttribute("data-question-layout-host", "");
	Object.assign(host.style, {
		position: "absolute", left: "0", top: "0", width: "0", height: "0",
		overflow: "hidden", visibility: "hidden", pointerEvents: "none", contain: "strict",
	});
	// First child: never the card's :last-child (cards key spacing off it).
	root.prepend(host);
	return host;
}

/** What the question's rendered content is made of: element counts (a
 *  diagram or formula rendering adds elements), the option text and the
 *  loaded web fonts. A solved layout is only reused for the same
 *  fingerprint, so one solved before the content settled is never reused
 *  after it. Selection state and drafts are excluded: options count only
 *  rich elements and text outside typing fields (the Other answer). */
export function questionContentFingerprint(parts: Pick<QuestionParts, "question" | "options">): string {
	const options = parts.options;
	let rich = 0;
	let text = options?.textContent?.length ?? 0;
	if (options) {
		for (const el of options.querySelectorAll(".katex, svg, img, code, table")) if (!el.closest(DRAFT_FIELD)) rich++;
		for (const field of options.querySelectorAll(DRAFT_FIELD)) if (!field.parentElement?.closest(DRAFT_FIELD)) text -= field.textContent?.length ?? 0;
	}
	return `${parts.question.querySelectorAll("*").length}|${rich}|${text}|${fontEpoch(parts.question.ownerDocument?.fonts)}`;
}

/**
 * Fonts NEWLY loaded, as an epoch. Chrome fires "loadingdone" again during
 * window resizes for faces that loaded long ago, so the event alone is not
 * news: the epoch moves only when the count of loaded faces grew. Counted
 * once per event for the page, never per card or per check.
 */
type FontTracker = { epoch: number; loaded: number; listeners: Set<() => void> };
const fontTrackers = new WeakMap<object, FontTracker>();
function loadedFaces(set: FontFaceSet): number {
	let n = 0;
	const faces = set as FontFaceSet & Iterable<FontFace>;
	if (typeof faces[Symbol.iterator] === "function") for (const face of faces) if (face.status === "loaded") n++;
	return n;
}
function fontTracker(set: FontFaceSet | undefined): FontTracker | null {
	if (!set?.addEventListener) return null;
	let t = fontTrackers.get(set);
	if (!t) {
		const tracker: FontTracker = { epoch: 0, loaded: loadedFaces(set), listeners: new Set() };
		fontTrackers.set(set, (t = tracker));
		set.addEventListener("loadingdone", () => {
			const loaded = loadedFaces(set);
			if (loaded === tracker.loaded) return;
			tracker.loaded = loaded;
			tracker.epoch++;
			for (const listener of tracker.listeners) listener();
		});
	}
	return t;
}
function fontEpoch(set: FontFaceSet | undefined): number {
	return fontTracker(set)?.epoch ?? 0;
}
/** Call `listener` when the document newly loaded fonts; returns unsubscribe. */
export function onFontsLoaded(set: FontFaceSet | undefined, listener: () => void): () => void {
	const t = fontTracker(set);
	if (!t) return () => {};
	t.listeners.add(listener);
	return () => { t.listeners.delete(listener); };
}

/** Rich content still settling: a diagram rendering (or its font-parity cap
 *  not yet applied), an image still loading, or web fonts loading. Solving
 *  before it settles would only be thrown away. */
export function questionContentReady(parts: Pick<QuestionParts, "question" | "options">): boolean {
	for (const part of [parts.question, parts.options]) {
		if (!part) continue;
		if (part.querySelector('[data-testid="md-mermaid"][aria-busy="true"]')) return false;
		for (const svg of part.querySelectorAll<SVGSVGElement>(MEDIA_SVG)) {
			if (!svg.parentElement?.style.maxWidth) return false;
		}
		for (const img of part.querySelectorAll("img")) if (!img.complete) return false;
	}
	return parts.question.ownerDocument?.fonts?.status !== "loading";
}
