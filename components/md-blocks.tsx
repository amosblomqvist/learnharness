"use client";

/**
 * MARKDOWN BLOCKS, MELTED INTO THE MESSAGE (owner wave, 2026-09-19): the
 * boxed streamdown chrome — the double-framed tables (border + sidebar bg +
 * a second inner border + copy/download/fullscreen button rows), the mermaid
 * container (border box + mono label header + action pill + inner border +
 * in-chart zoom buttons), the code header bars — is REPLACED by this
 * component set, wired into Streamdown via its `components` prop:
 *
 * - Tables: a plain PROSE table (no box, no sidebar bg, no buttons bar) —
 *   hairline row rules + a stronger header underline (globals.css), wide
 *   tables scroll inside the column.
 * - Mermaid: the bare chart, part of the message — no label, no container,
 *   no zoom pill (zoom/pan lives in the session-scoped focus overlay now).
 * - Code: streamdown's CodeBlock skeleton keeps the shiki plumbing, but the
 *   container melts (subtle bg tint, no border, no header — globals.css) and
 *   the buttons go.
 * - Display math: untouched visually, but gains the corner copy.
 *
 * THE ONE AFFORDANCE (user-decided): a small muted COPY icon at each block's
 * top-right corner, revealed on hover — copying the SOURCE (table →
 * Markdown, code → text, mermaid → chart source, math → the raw TeX). It
 * never fakes a table column or shifts layout, and hover-reveal keeps the
 * reading surface clean — the whole point of the melt. Text selection stays
 * free: the icon lives in dead corner space. Mermaid additionally gets an
 * EXPAND icon (opens the session overlay) when a chat page is mounted.
 *
 * CONTENT DIRECTION (mixed Arabic, English and math): every block (paragraph,
 * heading, quote, list, table) states its own direction from its own letters
 * (src/core/bidi.ts; math, code and keys excluded, a URL read as
 * left-to-right), and inside a right-to-left block each left-to-right phrase
 * is isolated in one span, so `C++`, `f(x).`, `(derivative)` and `Newton's
 * **second law**` keep their punctuation and their order. Math and code are
 * always left-to-right. See "Content direction" below.
 */

import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useRef, useState, type ComponentProps, type ElementType, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { CheckIcon, CopyIcon, MaximizeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	CodeBlock,
	extractTableDataFromElement,
	tableDataToMarkdown,
	useIsCodeFenceIncomplete,
} from "streamdown";
import type { ExtraProps } from "streamdown";
import { MERMAID_FONT_SIZE, renderMermaid } from "@/components/mermaid-render";
import { MermaidError } from "@/components/mermaid-error";
import { isolateChunks, type InlineChunk } from "@/components/bidi-text";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { chartSize, useSessionMermaid } from "@/components/session-overlay";
import { Hint } from "@/components/ui/hint";
import { BREAK_TEXT, LITERAL_TEXT, ltrRuns, proseDirection } from "@/src/core";

// ─── The one affordance: the hover-reveal corner copy ────────────────────────

/** Clipboard write with a fallback: navigator.clipboard needs the
 *  `clipboard-sanitized-write` permission, which Electron's deny-by-default
 *  handler (electron/main.cjs) must grant from the loopback origin — and
 *  browsers with a stale/absent API reject too. The hidden-textarea
 *  execCommand path is the belt under that: a failed write would otherwise
 *  be a silent no-op, which is exactly what the owner saw. Returns whether
 *  the copy landed (drives the Copied pill). */
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		/* fall through to the legacy path */
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

/** A small muted copy icon for a block's top-right corner. The CONSUMER'S
 *  wrapper carries `group/md relative` (a NAMED group — the message container
 *  is also a `group`, and an unnamed group-hover would light EVERY corner in
 *  the message at once, the all-at-once the owner saw) and positions this
 *  via className; the icon self-hides until hover (opacity-0 →
 *  group-hover/md:opacity-100). Copies getText() on click; the icon flips
 *  to a check for a beat — enough feedback on its own (a "Copied" pill was
 *  tried and removed by owner ask, 2026-09-19). */
export function CopyCorner({
	getText,
	label,
	className,
}: {
	getText: () => string;
	label: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timerRef.current), []);
	return (
		<span className={cn("relative inline-flex", className)}>
			<button
				type="button"
				aria-label={label}
				data-testid="md-copy"
				className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/md:opacity-100"
				onClick={(e) => {
					blurAfterPointerClick(e);
					void copyText(getText()).then((ok) => {
						if (!ok) return;
						setCopied(true);
						window.clearTimeout(timerRef.current);
						timerRef.current = window.setTimeout(() => setCopied(false), 1500);
					});
				}}
			>
				{copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
			</button>
		</span>
	);
}

// ─── Content direction (the Streamdown `p`, `h1`…`h6`, `ul`, `ol` overrides) ───

type Direction = "ltr" | "rtl";
type HastElement = NonNullable<ExtraProps["node"]>;

/** KaTeX's own wrappers: the inline equation and the display one. */
const MATH_CLASSES = ["katex", "katex-display"];

/** Whether a class list (a React className string or a hast class array) names KaTeX's wrapper. */
const isMath = (className: unknown): boolean =>
	(typeof className === "string" ? className.split(/\s+/) : Array.isArray(className) ? className : []).some((name) => MATH_CLASSES.includes(String(name)));

/** The text a reader takes in as prose: a hast subtree without its math, code
 *  and keys, which have no direction of their own (the run scan reads each as
 *  one literal, see `chunkOf`). Already parsed, so its characters are literal
 *  (`\$` is a dollar sign, not math). Exported for hermetic tests. */
export function proseText(node: HastElement): string {
	let text = "";
	for (const child of node.children) {
		if (child.type === "text") text += child.value;
		else if (child.type === "element" && child.tagName !== "code" && child.tagName !== "kbd" && !isMath(child.properties.className)) text += proseText(child);
	}
	return text;
}

/** The direction the content of the nearest enclosing block flows in. */
const FlowContext = createContext<Direction | null>(null);

/** A block's direction and the direction its content flows in. The letters of
 *  the block's own text decide (`undefined` when it has none); a block with no
 *  letters flows like what encloses it, the enclosing block or else the page.
 *  The block states its direction as `dir`, except an LTR block in an LTR flow,
 *  which has nothing to override: a right-to-left flow still needs it on an
 *  English paragraph. Recomputed on every render, so a streaming block turns
 *  right-to-left as soon as its first right-to-left letter arrives. */
function useBlockFlow(node: HastElement | undefined): { dir: Direction | undefined; flow: Direction } {
	const inherited = useContext(FlowContext) ?? "ltr";
	const own = node ? proseDirection(proseText(node)) : undefined;
	return { dir: own === "ltr" && inherited === "ltr" ? undefined : own, flow: own ?? inherited };
}

/** Inline markup stays inside its sentence. The parts of a list or table
 *  (items, rows, cells) hold sentences of their own. Every other element is a
 *  nested block or a code fence and is left as it is. */
const INLINE_TAGS = new Set(["a", "abbr", "b", "br", "del", "em", "i", "img", "input", "mark", "s", "span", "strong", "sub", "sup", "u"]);
const PART_TAGS = new Set(["li", "thead", "tbody", "tfoot", "tr", "td", "th"]);
/** Formatting a left-to-right run may cut through. Links, code and math are never cut. */
const FORMATTING_TAGS = new Set(["b", "em", "i", "strong"]);

interface ElementProps {
	children?: ReactNode;
	className?: string;
}

/** The chunks of a right-to-left context's children. Inline markup adds its own
 *  text, so a phrase is found across it (`Newton's **second law**`, `**C**++`);
 *  code, keys and math read as one left-to-right letter; a line break, an item,
 *  a cell or a nested block ends every run. Formatting that a run spills into or
 *  out of is cut at the run boundary (`Newton's **second law ينص**` gives two
 *  `strong` pieces), so the run is isolated whole; a run that a link, code or
 *  math sticks out of is left to that element, a context of its own (`own`). */
function chunksOf(children: ReactNode): InlineChunk[] {
	const nodes = Children.toArray(children);
	const chunks = nodes.map(chunkOf);
	const cuts = runCuts(nodes, chunks);
	return nodes.flatMap((node, index) => {
		const offsets = cuts[index]!;
		if (!offsets.length || !isValidElement<ElementProps>(node)) return [chunks[index]!];
		const pieces: Array<ReactElement<ElementProps>> = [];
		let rest = node;
		let from = 0;
		for (const offset of offsets) {
			const [left, right] = cutAt(rest, offset - from)!;
			pieces.push(left);
			rest = right;
			from = offset;
		}
		pieces.push(rest);
		// The pieces are siblings, so each takes a key of its own; every other node keeps its key.
		return pieces.map((piece, n) => chunkOf(cloneElement(piece, { key: `${node.key}:${n}` })));
	});
}

/** One child of a right-to-left context. */
function chunkOf(child: ReactNode): InlineChunk {
	if (typeof child === "string") return { text: child };
	const whole = { node: child, own: () => child };
	if (!isValidElement<ElementProps>(child)) return { text: BREAK_TEXT, element: whole };
	const tag = markdownTag(child);
	if (tag === "code" || (tag === "span" && isMath(child.props.className))) return { text: LITERAL_TEXT, element: { ...whole, isolated: true } };
	// Keys are one literal too; with no `dir` of their own, alone they are wrapped (`Ctrl+,`).
	if (tag === "kbd") return { text: LITERAL_TEXT, element: whole };
	if (tag === null || !(INLINE_TAGS.has(tag) || PART_TAGS.has(tag))) return { text: BREAK_TEXT, element: whole };
	const inner = chunksOf(child.props.children);
	// Void elements (images, checkboxes) have no content to isolate.
	const own = () => (inner.length ? cloneElement(child, undefined, isolateChunks(inner)) : child);
	const breaks = tag === "br" || PART_TAGS.has(tag);
	return { text: breaks ? BREAK_TEXT : inner.map((chunk) => chunk.text).join(""), element: { node: child, own } };
}

/** For each node, the offsets into its text where a left-to-right run enters or
 *  leaves it. A run inside one element, or one that some part it sticks out of
 *  cannot be cut for, gives none. */
function runCuts(nodes: readonly ReactNode[], chunks: readonly InlineChunk[]): number[][] {
	const spans: Array<{ start: number; end: number }> = [];
	let length = 0;
	for (const chunk of chunks) {
		spans.push({ start: length, end: length + chunk.text.length });
		length += chunk.text.length;
	}
	const cuts: number[][] = nodes.map(() => []);
	let at = 0;
	for (const run of ltrRuns(chunks.map((chunk) => chunk.text).join(""))) {
		const start = at;
		const end = start + run.text.length;
		at = end;
		if (!run.ltr) continue;
		const planned: Array<[number, number]> = [];
		let whole = true;
		chunks.forEach((chunk, index) => {
			const span = spans[index]!;
			const node = nodes[index];
			const apart = span.end <= start || end <= span.start;
			const inRun = start <= span.start && span.end <= end;
			const holdsRun = span.start <= start && end <= span.end;
			if (!chunk.element || apart || inRun || holdsRun) return;
			const offset = (start > span.start ? start : end) - span.start;
			if (isValidElement<ElementProps>(node) && cutAt(node, offset)) planned.push([index, offset]);
			else whole = false;
		});
		if (whole) for (const [index, offset] of planned) cuts[index]!.push(offset);
	}
	return cuts;
}

/** `element` cut `at` characters into its text: two copies with its tag and
 *  props, holding the children before and after the cut. Formatting inside it is
 *  cut the same way; `null` when the element, or a part the cut falls inside,
 *  is not formatting. */
function cutAt(element: ReactElement<ElementProps>, at: number): [ReactElement<ElementProps>, ReactElement<ElementProps>] | null {
	if (!FORMATTING_TAGS.has(markdownTag(element) ?? "")) return null;
	const left: ReactNode[] = [];
	const right: ReactNode[] = [];
	let offset = 0;
	for (const child of Children.toArray(element.props.children)) {
		const end = offset + chunkOf(child).text.length;
		if (end <= at) left.push(child);
		else if (offset >= at) right.push(child);
		else if (typeof child === "string") {
			left.push(child.slice(0, at - offset));
			right.push(child.slice(at - offset));
		} else {
			const halves = isValidElement<ElementProps>(child) ? cutAt(child, at - offset) : null;
			if (!halves) return null;
			left.push(halves[0]);
			right.push(halves[1]);
		}
		offset = end;
	}
	return [cloneElement(element, undefined, ...left), cloneElement(element, undefined, ...right)];
}

/** The content of a block: nested blocks inherit its flow, and a right-to-left
 *  flow isolates the phrases of its text. Streamdown memoizes its list items,
 *  cells and links on their source position alone; they still take the isolated
 *  text when a streaming block turns right-to-left, because `chunksOf` goes
 *  through `Children.toArray`, which re-prefixes their keys and so remounts
 *  them. */
function Flow({ flow, children }: { flow: Direction; children: ReactNode }) {
	return (
		<FlowContext.Provider value={flow}>
			{flow === "rtl" ? isolateChunks(chunksOf(children)) : children}
		</FlowContext.Provider>
	);
}

/** Streamdown unwraps a paragraph that holds only an image or a code fence,
 *  so block content never nests in a <p>; the override keeps that rule. */
function standsAlone(children: ReactNode): boolean {
	const content = (Array.isArray(children) ? children : [children]).filter((child) => child !== null && child !== undefined && child !== "");
	const [only] = content;
	if (content.length !== 1 || !isValidElement(only)) return false;
	const tag = markdownTag(only);
	return tag === "img" || (tag === "code" && "data-block" in (only.props as object));
}

export function MarkdownParagraph(props: ComponentProps<"p"> & ExtraProps) {
	const { children, node, ...rest } = props;
	const { dir, flow } = useBlockFlow(node);
	if (standsAlone(children)) return <>{children}</>;
	return (
		<p {...rest} dir={dir}>
			<Flow flow={flow}>{children}</Flow>
		</p>
	);
}

/** Overriding a tag displaces Streamdown's styled component for it, so the
 *  look is restored by hand: the verbatim default classes, list nesting on the
 *  logical side. Headings and lists share one body: the direction rule. */
const DIRECTED_LOOK = {
	h1: ["mt-6 mb-2 font-semibold text-3xl", "heading-1"],
	h2: ["mt-6 mb-2 font-semibold text-2xl", "heading-2"],
	h3: ["mt-6 mb-2 font-semibold text-xl", "heading-3"],
	h4: ["mt-6 mb-2 font-semibold text-lg", "heading-4"],
	h5: ["mt-6 mb-2 font-semibold text-base", "heading-5"],
	h6: ["mt-6 mb-2 font-semibold text-sm", "heading-6"],
	ul: ["list-inside list-disc whitespace-normal [li_&]:ps-6", "unordered-list"],
	ol: ["list-inside list-decimal whitespace-normal [li_&]:ps-6", "ordered-list"],
} as const;

function directedBlock(tag: keyof typeof DIRECTED_LOOK) {
	const [look, name] = DIRECTED_LOOK[tag];
	const Tag: ElementType = tag;
	function DirectedBlock({ children, className, node, ...rest }: HTMLAttributes<HTMLElement> & ExtraProps) {
		const { dir, flow } = useBlockFlow(node);
		return (
			<Tag className={cn(look, className)} data-streamdown={name} dir={dir} {...rest}>
				<Flow flow={flow}>{children}</Flow>
			</Tag>
		);
	}
	DirectedBlock.displayName = `Markdown${tag.toUpperCase()}`;
	return DirectedBlock;
}

// ─── Code + mermaid fences (the Streamdown `code` override) ──────────────────

/** The fence source from a code element's children — a bare string in the
 *  common case; an element wrapping a string when rehype nests it. Pure. */
export function codeSource(children: ReactNode): string {
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (isValidElement(children)) {
		const inner = (children.props as { children?: ReactNode }).children;
		if (typeof inner === "string") return inner;
	}
	return "";
}

/** Mermaid, in the message flow: the bare chart (dark theme, rendered via
 *  the app's own plugin — components/mermaid-render.ts), the hover corner
 *  with copy + expand, the house error fallback. No container chrome, no
 *  zoom pill — the zoom/pan home is the session overlay. While the fence is
 *  still streaming (the trailing open fence), a quiet skeleton instead of a
 *  doomed parse. */
function MermaidInline({ chart }: { chart: string }) {
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const overlay = useSessionMermaid();
	const incomplete = useIsCodeFenceIncomplete();
	// The font-parity cap (owner rule, 2026-09-19): the house CSS
	// (`max-width: 100% !important`) overrides mermaid's own natural-size cap,
	// so a chart would otherwise stretch to the full column and render its
	// text larger than the session's own text. Cap the holder at the width
	// where the chart's 16px base font lands at the SESSION font (measured
	// live from the wrapper — --lh-prose-size today): a chart may shrink to
	// fit the column, but never blow its text up past the chat's.
	const holderRef = useRef<HTMLDivElement>(null);
	const [capW, setCapW] = useState<number | null>(null);
	useEffect(() => {
		if (!svg || !holderRef.current) return;
		const fs = Number.parseFloat(getComputedStyle(holderRef.current).fontSize);
		if (!Number.isFinite(fs) || fs <= 0) return;
		const { w } = chartSize(svg);
		setCapW((w * fs) / MERMAID_FONT_SIZE);
	}, [svg]);

	useEffect(() => {
		if (incomplete) return;
		let cancelled = false;
		setSvg(null);
		setError(null);
		renderMermaid(chart)
			.then((s) => {
				if (!cancelled) setSvg(s);
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [chart, attempt, incomplete]);

	if (incomplete || (svg === null && error === null)) {
		return (
			<div data-testid="md-mermaid" className="my-4 flex justify-center p-4" aria-busy="true">
				<span className="inline-block size-4 animate-spin rounded-full border border-current border-b-2 text-muted-foreground" />
			</div>
		);
	}
	if (error !== null) {
		return <MermaidError chart={chart} error={error} retry={() => setAttempt((a) => a + 1)} />;
	}
	return (
		// data-streamdown="mermaid" keeps the house CSS hook (the svg
		// max-width rule in globals.css) alive for this app-owned block.
		<div data-testid="md-mermaid" data-streamdown="mermaid" className="group/md relative my-4">
			<div
				ref={holderRef}
				className="mx-auto flex w-full justify-center"
				style={capW === null ? undefined : { maxWidth: `${capW}px` }}
				dangerouslySetInnerHTML={{ __html: svg ?? "" }}
			/>
			<div className="absolute top-0 right-0 flex items-start gap-0.5">
				<CopyCorner getText={() => chart} label="Copy diagram source" />
				{overlay && (
					<Hint
					// Full-screen overlay copy (tooltip wave) — "session view" was
					// internal direction-speak for the same thing.
					label="Open full-screen"
					side="bottom"
				>
<button
						type="button"
						aria-label="Expand diagram"
						data-testid="md-mermaid-expand"
												className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/md:opacity-100"
						onClick={(e) => {
							blurAfterPointerClick(e);
							overlay.openMermaid(chart);
						}}
					>
						<MaximizeIcon className="size-3.5" />
					</button>
				</Hint>
				)}
			</div>
		</div>
	);
}

/** The Streamdown `code` override: inline code passes through with the
 *  house inline classes; block fences split — mermaid renders as the bare
 *  chart above, everything else delegates to streamdown's exported
 *  CodeBlock (shiki highlighting + line numbers preserved) inside a
 *  hover-copy wrapper, with NO children so its sticky button row never
 *  mounts. The container/look is CSS-melted in globals.css
 *  (data-streamdown="code-block"…). */
export function MarkdownCode(props: ComponentProps<"code"> & ExtraProps) {
	const incomplete = useIsCodeFenceIncomplete();
	const { children, className, node, ...rest } = props;

	// Inline code: no data-block (the pre handler stamps block fences only).
	if (!("data-block" in props)) {
		return (
			<code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)} data-streamdown="inline-code" dir="ltr" {...rest}>
				{children}
			</code>
		);
	}

	const language = /language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
	const meta = (node?.properties?.metastring as string | undefined) ?? "";
	const source = codeSource(children);

	if (language === "mermaid") return <MermaidInline chart={source} />;

	const startMatch = /startLine=(\d+)/.exec(meta);
	const startLine = startMatch ? Number.parseInt(startMatch[1]!, 10) : undefined;
	const lineNumbers = !/\bnoLineNumbers\b/.test(meta);
	return (
		<div className="group/md relative" data-testid="md-code">
			<CopyCorner className="absolute top-1.5 right-2 z-10" getText={() => source} label="Copy code" />
			<CodeBlock
				code={source}
				language={language}
				className={className}
				dir="ltr"
				isIncomplete={incomplete}
				startLine={startLine !== undefined && startLine >= 1 ? startLine : undefined}
				lineNumbers={lineNumbers}
			/>
		</div>
	);
}

// ─── Key-idea callouts (the Streamdown `blockquote` override) ────────────────

/** GitHub-style alert markers — the syntax the models already know from a
 *  million READMEs. The PROMPT teaches only [!IMPORTANT] (one emphasis
 *  device, one meaning: load-bearing); the renderer accepts all five and
 *  boxes them identically — a stray [!NOTE] still meant "this deserves
 *  emphasis", and a literal marker line must never leak as text (owner
 *  design, callout round 2026-10-07). */
const ALERT_MARKER_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

export interface ParsedAlert {
	kind: string;
	/** The blockquote children with the marker line stripped — prose intact. */
	children: ReactNode;
}

const significant = (c: ReactNode) => c !== null && c !== undefined && c !== "" && !(typeof c === "string" && c.trim() === "");

/** The element's markdown tag — Streamdown wraps every block in its own
 *  styled component (MarkdownParagraph, …), so the React type is rarely
 *  the raw "p": the hast node carried in props tells the truth. */
function markdownTag(el: React.ReactElement): string | null {
	if (typeof el.type === "string") return el.type;
	const node = (el.props as { node?: { tagName?: string } }).node;
	return node?.tagName ?? null;
}

/** Pure: does this blockquote open with a GitHub alert marker? Returns the
 *  kind and the children with the marker line removed (the marker's own
 *  paragraph dropped entirely when it stands alone — `> [!IMPORTANT]` then
 *  a blank quote line then content; a standalone marker also drops the
 *  <br> hard-break artifact that carried its line break). Non-alert
 *  blockquotes pass through untouched. Exported for hermetic tests. */
export function parseAlertMarker(children: ReactNode): ParsedAlert | null {
	const list = Array.isArray(children) ? children : [children];
	const para = list.find(significant);
	if (!isValidElement(para) || markdownTag(para) !== "p") return null;
	const inner = (para.props as { children?: ReactNode }).children;
	const innerList = Array.isArray(inner) ? inner : [inner];
	const lead = innerList.find(significant);
	if (typeof lead !== "string") return null;
	const match = ALERT_MARKER_RE.exec(lead);
	if (!match) return null;
	const kind = match[1]!.toLowerCase();
	const stripped = lead.slice(match[0].length);
	// Rebuild the paragraph without the marker line; drop it entirely when
	// the marker stood alone (nothing but the marker text in the paragraph).
	const leadIdxInner = innerList.indexOf(lead);
	const hasFollowing = innerList.some((c, i) => i > leadIdxInner && significant(c));
	let rebuiltPara: ReactNode = null;
	if (stripped.trim() !== "" || hasFollowing) {
		let rest = innerList.map((c) => (c === lead ? (stripped === "" ? null : stripped) : c));
		if (stripped === "") {
			// the hard-break <br> that ended the marker line is now leading junk
			while (rest.length && (rest[0] === null || (isValidElement(rest[0]) && markdownTag(rest[0]) === "br"))) rest = rest.slice(1);
		}
		rebuiltPara = cloneElement(para, {}, ...rest);
	}
	const leadIdx = list.indexOf(para);
	const restChildren = [...list.slice(0, leadIdx), ...(rebuiltPara ? [rebuiltPara] : []), ...list.slice(leadIdx + 1)];
	return { kind, children: restChildren };
}

/** The key-idea callout (owner rulings, 2026-10-07): SHARP corners, a white
 *  stroke, NO background, NO label, NO icon — just the outline. The box
 *  hugs its text (width: fit-content, capped at the column) instead of
 *  stretching full-width into empty space. */
export function MarkdownBlockquote(props: ComponentProps<"blockquote"> & ExtraProps) {
	const { children, node, ...rest } = props;
	const { dir, flow } = useBlockFlow(node);
	const alert = parseAlertMarker(children);
	if (!alert) {
		// Plain quote — Streamdown's own styling, restored by hand: overriding
		// `blockquote` displaced its styled component (the classes below are
		// its verbatim defaults), and bare <blockquote> rendered unstyled
		// (owner report, 2026-10-07).
		return (
			<blockquote
				{...rest}
				className="my-4 border-s-4 border-muted-foreground/30 ps-4 text-muted-foreground italic"
				data-streamdown="blockquote"
				dir={dir}
			>
				<Flow flow={flow}>{children}</Flow>
			</blockquote>
		);
	}
	return (
		<div
			data-testid="md-callout"
			data-alert-kind={alert.kind}
			className="my-4 w-fit max-w-full border border-white px-4 py-3 [&> :first-child]:mt-0 [&> :last-child]:mb-0"
			dir={dir}
		>
			<Flow flow={flow}>{alert.children}</Flow>
		</div>
	);
}

// ─── Tables (the Streamdown `table` override) ────────────────────────────────

/** A plain PROSE table: no wrapper box, no button rows — just the table
 *  (streamdown's inner cells keep their padding/typography; the hairline
 *  rules live in globals.css on the data-streamdown attributes) inside a
 *  horizontal-scroller for wide ones, with the corner copy. The copy
 *  serializes the REAL DOM table (the library's own extractor → Markdown). */
export function MarkdownTable(props: ComponentProps<"table"> & ExtraProps) {
	const { children, node, ...rest } = props;
	const { dir, flow } = useBlockFlow(node);
	const ref = useRef<HTMLTableElement>(null);
	return (
		// The wrapper carries the direction: the table inherits it, and the
		// scroller then opens at the table's first column.
		<div className="group/md relative my-4" data-testid="md-table" dir={dir}>
			<CopyCorner
				// Contained in the table's top corner at the inline end: top-right
				// in a left-to-right table, top-left in a right-to-left one (owner
				// note, 2026-09-19: the old -top-3 lifted only half the 24px button
				// above the 12px offset, so it straddled the top outline). 4px
				// inset, z above the cells it hovers over; the scroll container
				// stays under it (the corner is fixed to the wrapper, not the
				// scrolling table).
				className="absolute top-1 end-1 z-10"
				label="Copy table"
				getText={() => (ref.current ? tableDataToMarkdown(extractTableDataFromElement(ref.current)) : "")}
			/>
			<div className="overflow-x-auto">
				<table
					ref={ref}
					// No text-sm here — the table text runs at the session prose size
				// (owner note, 2026-09-19: streamdown's cells pin their own text-sm
				// 12.5px; globals.css overrides cells to inherit, so tables match the
				// 16px chat text for a consistent look).
					className="w-full border-collapse"
					data-streamdown="table"
					{...rest}
				>
					<Flow flow={flow}>{children}</Flow>
				</table>
			</div>
		</div>
	);
}

// ─── Display math (the Streamdown `span` override) ────────────────────────────

/** KaTeX display equations are wrapped in a SPAN.katex-display (rehype-katex
 *  renders them as spans with display:block CSS — NOT divs; verified in the
 *  static render). They gain the corner copy (the raw TeX — KaTeX embeds it
 *  in the MathML <annotation>; read from the DOM on click, no re-parse).
 *  Every equation, inline or display, is stamped left-to-right: math has no
 *  direction of its own and must not take the sentence's. Every other span
 *  passes through untouched. */
export function MathDisplay(props: ComponentProps<"span"> & ExtraProps) {
	const { children, className, node, ...rest } = props;
	const ref = useRef<HTMLSpanElement>(null);
	if (!className?.includes("katex-display")) {
		return (
			<span className={className} dir={isMath(className) ? "ltr" : undefined} {...rest}>
				{children}
			</span>
		);
	}
	return (
		// BLOCK, not inline: the katex-display child is itself display:block
		// (KaTeX's CSS), and an inline wrapper around a block child gets
		// FRAGMENTED by the anonymous-block rules — the absolutely positioned
		// corner then has no clean containing block and pointer events never
		// land on it (owner report: the math corner neither highlights on hover
		// nor copies; everything else works). display:block gives the corner a
		// real box; z-10 keeps it above the equation spans it overlays.
		<span className="group/md relative block z-0" data-testid="md-math">
			<CopyCorner
				className="absolute top-0 right-0 z-10"
				label="Copy equation source"
				getText={() => ref.current?.querySelector("annotation")?.textContent ?? ""}
			/>
			<span ref={ref} className={className} dir="ltr" {...rest}>
				{children}
			</span>
		</span>
	);
}

// ─── The stable override set (module identity: Streamdown is memoized) ────────

/** Bold as the REAL element (appearance fix, 2026-09-23): streamdown's
 *  default `strong` renders `<span class="font-semibold" data-streamdown=
 *  "strong">` — and `.lh-prose :where(strong, b)` matches strong/b
 *  ELEMENTS, so neither the factory ink (#ee928c) nor a settings
 *  boldColor ever landed on bold text (italic worked: streamdown leaves
 *  `em` native). Rendering the semantic element restores screen-reader
 *  emphasis AND lets the designed token rule apply unmodified — color
 *  --lh-ink-strong, weight 700 (beating the old 600 utility). */
export function MarkdownStrong(props: ComponentProps<"strong"> & ExtraProps) {
	const { children, className, node, ...rest } = props;
	return (
		<strong data-streamdown="strong" className={className} {...rest}>
			{children}
		</strong>
	);
}

export const mdComponents = {
	code: MarkdownCode,
	table: MarkdownTable,
	span: MathDisplay,
	strong: MarkdownStrong,
	blockquote: MarkdownBlockquote,
	p: MarkdownParagraph,
	h1: directedBlock("h1"),
	h2: directedBlock("h2"),
	h3: directedBlock("h3"),
	h4: directedBlock("h4"),
	h5: directedBlock("h5"),
	h6: directedBlock("h6"),
	ul: directedBlock("ul"),
	ol: directedBlock("ol"),
};
