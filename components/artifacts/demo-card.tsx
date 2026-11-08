"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { DownloadIcon, MaximizeIcon, XIcon } from "lucide-react";
import { Toggle } from "@/components/settings/controls";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { ChatActionsContext } from "@/components/chat";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import type { ArtifactPartProps, DemoResult } from "@/src/core";

/**
 * Demo artifact card (W6): while the part is input-available, a job activity
 * card (the chat view's jobs feed — the job-card idiom); when output-available, the demo
 * runs in a SANDBOXED iframe (sandbox="allow-scripts", no allow-same-origin →
 * no access to app storage/cookies/DOM).
 *
 * The bridge script (contracts.ts "Demo iframe bridge") is auto-injected into
 * every demo by buildDemoSrcDoc — never the model's job: ResizeObserver →
 * postMessage {type:"demo-resize",height} (parent sizes the iframe) and
 * window.onerror → {type:"demo-error",message} (error chip on the card, with
 * a "Send to teacher" button that feeds the error back into the lesson — the
 * fix loop). Escape keydown → {type:"demo-escape"}: the card turns it into
 * a fullscreen close (focus inside the sandbox never reaches the parent's
 * keydown listeners); the reducer ignores it. The parent also posts
 * {type:"lh-scrollbar",thumb,hover} after load: the bridge styles the demo's
 * scrollbars like the app's (the sandbox inherits none of the app's CSS —
 * and a srcDoc built from theme colors would mismatch SSR hydration).
 * The bridge also paints <html> white when the demo sets no background of its
 * own — the iframe ELEMENT itself is card-colored (see the className note).
 *
 * Bridge message handling is a pure function (reduceDemoBridgeState) so
 * tests cover it without a DOM.
 */

// ─── bridge injection + message handling (pure, testable) ───────────────────

export const DEMO_BRIDGE_SCRIPT = `<script>(function(){
var send=function(m){try{parent.postMessage(m,"*")}catch(e){}};
var painted=false;
var clear=function(c){return!c||c==="transparent"||/\\/\\s*0\\)$/.test(c)||/^rgba\\([^)]*,\\s*0\\)$/.test(c)};
var paint=function(){
var de=document.documentElement,b=document.body;
if(!b)return;
if(painted)de.style.removeProperty("background-color");
if(clear(getComputedStyle(de).backgroundColor)&&clear(getComputedStyle(b).backgroundColor)){de.style.setProperty("background-color","#fff");painted=true}else{painted=false}
};
var post=function(){
paint();
var b=document.body;
if(!b){send({type:"demo-resize",height:document.documentElement.scrollHeight});return}
var h=Math.max(b.scrollHeight,b.getBoundingClientRect().height);
var cs=getComputedStyle(b);
h+=(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0);
send({type:"demo-resize",height:Math.ceil(h)})
};
if(typeof ResizeObserver!=="undefined"){new ResizeObserver(post).observe(document.documentElement)}
window.addEventListener("resize",post);
window.addEventListener("load",post);
window.addEventListener("error",function(e){send({type:"demo-error",message:e.message||String(e)})});
window.addEventListener("keydown",function(e){if(e.key==="Escape")send({type:"demo-escape"})});
window.addEventListener("message",function(e){
var d=e.data;
if(e.source!==parent||!d||d.type!=="lh-scrollbar")return;
var ok=/^[\\w\\s(),.%\\/-]+$/;
if(!ok.test(d.thumb)||!ok.test(d.hover))return;
var s=document.getElementById("lh-scrollbar");
if(!s){s=document.createElement("style");s.id="lh-scrollbar";var h=document.head||document.documentElement;h.insertBefore(s,h.firstChild)}
s.textContent="*{scrollbar-width:thin;scrollbar-color:"+d.thumb+" transparent}::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:"+d.thumb+";border-radius:8px}::-webkit-scrollbar-thumb:hover{background:"+d.hover+"}"
});
setTimeout(post,50);
setTimeout(post,400);
})();</script>`;

/** Inject the bridge before </body> (or at the end of a body-less document). */
export function buildDemoSrcDoc(html: string): string {
	if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${DEMO_BRIDGE_SCRIPT}</body>`);
	return `${html}${DEMO_BRIDGE_SCRIPT}`;
}

/** The app's current scrollbar colors, resolved to concrete values (the
 *  sandboxed demo can't see the app's theme variables). Browser only. */
function appScrollbarColors(): { thumb: string; hover: string } {
	const resolve = (name: string) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${name})`;
		document.body.appendChild(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	};
	return { thumb: resolve("--color-border"), hover: resolve("--color-muted-foreground") };
}

export interface DemoBridgeState {
	height: number | null;
	error: string | null;
}

export const INITIAL_DEMO_BRIDGE_STATE: DemoBridgeState = { height: null, error: null };

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2400;

/** Pure reducer over incoming postMessage data (contracts.ts DemoBridgeMessage). */
export function reduceDemoBridgeState(state: DemoBridgeState, data: unknown): DemoBridgeState {
	if (typeof data !== "object" || data === null) return state;
	const message = data as { type?: unknown; height?: unknown; message?: unknown };
	if (message.type === "demo-resize") {
		if (typeof message.height !== "number" || !Number.isFinite(message.height) || message.height <= 0) return state;
		const height = Math.min(Math.max(Math.round(message.height), MIN_HEIGHT), MAX_HEIGHT);
		return height === state.height ? state : { ...state, height };
	}
	if (message.type === "demo-error") {
		const text = typeof message.message === "string" && message.message.trim() ? message.message : "unknown error";
		return text === state.error ? state : { ...state, error: text };
	}
	return state;
}

// ─── the demo card ──────────────────────────────────────────────────────────

/** The demo tool-call box: the part's output is the dispatch ack — the box
 * is the DispatchCard (live status via the chat view's jobs feed). The demo
 * itself renders from the steer message via DemoOutputCard. */
export function DemoCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="demo" />;
}

/** The demo artifact — exported: the steer card renders the delivered
 *  result. `messageId` + `initialInverted` carry the PERSISTED invert
 *  switch (details.ui.inverted via the artifact-ui route, owner 2026-10-07). */
export function DemoOutputCard({
	output,
	messageId,
	initialInverted = false,
}: {
	output: unknown;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const result = output as DemoResult | undefined;
	if (!result || typeof result.html !== "string" || typeof result.title !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Demo completed, but the result could not be displayed.
			</div>
		);
	}
	const failed = result.html.length === 0;
	if (failed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="demo-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Interactive demo
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The demo could not be built."}</p>
			</div>
		);
	}
	return (
		<DemoFrame title={result.title} html={result.html} messageId={messageId} initialInverted={initialInverted} />
	);
}

/** Zoom duration — matches the iframe's duration-200 transition. */
const ZOOM_MS = 200;

interface ZoomBox {
	top: number;
	left: number;
	width: number;
	height: number;
}

function zoomBox(r: DOMRect): ZoomBox {
	return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function DemoFrame({
	title,
	html,
	messageId,
	initialInverted = false,
}: {
	title: string;
	html: string;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const actions = useContext(ChatActionsContext);
	const overlay = useSessionMermaid();
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [state, setState] = useState<DemoBridgeState>(INITIAL_DEMO_BRIDGE_STATE);
	// Fullscreen (2026-10-30): the iframe NEVER remounts (moving an iframe in
	// the DOM reloads it — white blink, lost demo state). It stays in this
	// card, goes position:fixed at its own rect and zooms (FLIP) to the chat
	// page DemoOverlay's slot; closing zooms it back. null = inline.
	const [zoom, setZoom] = useState<{ phase: "open" | "closing"; box: ZoomBox; settled: boolean } | null>(null);
	const slotRef = useRef<HTMLDivElement | null>(null);
	// Scrollbar colors go to the bridge once per iframe load: onLoad covers
	// client-mounted iframes; an SSR'd one finished loading BEFORE hydration
	// (onLoad never fires), so its first bridge message triggers it instead.
	const styledRef = useRef(false);
	const styleScrollbars = () => {
		styledRef.current = true;
		iframeRef.current?.contentWindow?.postMessage({ type: "lh-scrollbar", ...appScrollbarColors() }, "*");
	};
	// Brightness inversion (owner, 2026-10-07): the switch state PERSISTS on
	// the steer record (details.ui.inverted) — seeded here, written through
	// the silent artifact-ui route on toggle. Without a chat page (tests,
	// previews) the toggle stays local-only. The filter rides the iframe
	// element, which carries the card's white backing, so one filter flips
	// page + content together while hue-rotate(180deg) undoes invert's hue
	// flip.
	const [inverted, setInverted] = useState(initialInverted);
	const toggleInverted = (next: boolean) => {
		setInverted(next);
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};
	const srcDoc = useMemo(() => buildDemoSrcDoc(html), [html]);
	const openFullscreen = () => {
		const iframe = iframeRef.current;
		if (!overlay || !iframe) return;
		setZoom({ phase: "open", box: zoomBox(iframe.getBoundingClientRect()), settled: false });
		overlay.openDemo({
			title,
			inverted,
			onInvertedChange: toggleInverted,
			// Zoom back onto the card's slot (the placeholder holds its place).
			onClose: () => {
				const slot = slotRef.current;
				setZoom((z) => (z && slot ? { phase: "closing", box: zoomBox(slot.getBoundingClientRect()), settled: false } : null));
			},
		});
	};

	// Open: the first render pinned the iframe fixed at the card's rect; flush
	// that style, then move to the overlay slot (the transition runs between
	// the two). The slot is tracked afterwards so a window resize re-fits.
	useEffect(() => {
		if (zoom?.phase !== "open") return;
		const slot = document.querySelector("[data-demo-overlay-slot]");
		if (!slot) return;
		iframeRef.current?.getBoundingClientRect();
		const fit = () => setZoom((z) => (z?.phase === "open" ? { ...z, box: zoomBox(slot.getBoundingClientRect()) } : z));
		const raf = requestAnimationFrame(fit);
		const ro = new ResizeObserver(fit);
		ro.observe(slot);
		// Scrollbars stay OFF while the rect animates (they pop in/out as the
		// height changes — the right-edge blink); on once it has landed.
		const settle = setTimeout(() => setZoom((z) => (z?.phase === "open" ? { ...z, settled: true } : z)), ZOOM_MS);
		return () => {
			cancelAnimationFrame(raf);
			clearTimeout(settle);
			ro.disconnect();
		};
	}, [zoom?.phase]);

	// Close: once the iframe has landed on the slot, drop back to inline flow.
	useEffect(() => {
		if (zoom?.phase !== "closing") return;
		const t = setTimeout(() => setZoom(null), ZOOM_MS);
		return () => clearTimeout(t);
	}, [zoom?.phase]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			// Only messages from THIS demo's iframe (the sandbox gives it an
			// opaque origin; the window reference still matches).
			if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
			// Esc inside the sandbox never reaches the parent's keydown
			// listeners — the bridge forwards it; no-op when nothing is open.
			if ((event.data as { type?: unknown } | null)?.type === "demo-escape") {
				overlay?.closeDemo();
				return;
			}
			if (!styledRef.current) styleScrollbars();
			setState((prev) => reduceDemoBridgeState(prev, event.data));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [overlay]);

	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="demo-card">
			{/* Caption header (owner, 2026-10-07): kind label + title in the
			   label's size/tracking (title normal-case, foreground) — the
			   figure card's grammar plus a name. Switch + download far right. */}
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						interactive demo
					</span>
					<span className="truncate text-xs font-medium tracking-wide text-foreground">{title}</span>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Toggle
						checked={inverted}
						onChange={toggleInverted}
						label="Invert demo brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<button
						type="button"
						aria-label="Download demo as HTML"
						title="Download as HTML"
						onClick={() => downloadFile(`${slugFilename(title)}.html`, html, "text/html")}
						data-testid="demo-download"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" />
					</button>
					{overlay && (
						<button
							type="button"
							aria-label="Open demo fullscreen"
							title="Open fullscreen"
							onClick={openFullscreen}
							data-testid="demo-fullscreen"
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
				</div>
			</div>
			{state.error && (
				<DemoErrorChip
					title={title}
					message={state.error}
					onSend={actions ? () => actions.sendText(`The demo "${title}" threw an error: ${state.error}`) : undefined}
				/>
			)}
			{/* Stable children (placeholder slot + iframe) keep the iframe mounted
			    across inline <-> fixed: only its CSS changes. */}
			<div ref={slotRef} className="mt-2">
				{zoom && <DemoFullscreenPlaceholder height={state.height ?? 360} onClose={() => overlay?.closeDemo()} />}
				<iframe
					ref={iframeRef}
					title={title}
					// allow-scripts ONLY — no allow-same-origin: the demo can run code
					// but never touch the app's storage, cookies, or DOM.
					sandbox="allow-scripts"
					srcDoc={srcDoc}
					// scrolling OFF (owner, 2026-10-07): the bridge auto-sizes the
					// iframe to its content, so an internal scrollbar can only appear
					// before the first resize lands — and a scrollable iframe TRAPS
					// the wheel (session scrolling stalls over the demo). With
					// scrolling disabled the wheel chains straight to the session.
					// Fullscreen (2026-10-30) is the one exception: once the zoom has
					// landed the demo gets the session area and scrolls inside it.
					scrolling={zoom?.phase === "open" && zoom.settled ? undefined : "no"}
					className={cn(
						// The element's own backing is what shows while an out-of-process
						// iframe hasn't painted (the white flash on scroll): the card's
						// color, not white. The demo's white lives in ITS document (the
						// bridge's paint()); inverted, a white backing flips dark with it.
						"w-full rounded-lg border",
						inverted ? "bg-white" : "bg-card",
						zoom && "z-40 transition-[top,left,width,height] duration-200 ease-out motion-reduce:transition-none",
					)}
					// content-box: the bridge reports the CONTENT height — with the
					// preflight's border-box the 2px border would eat into it and clip
					// the bottom of the demo (smoke finding, 2026-10-07). Zoomed, the
					// rect is a measured border box instead.
					style={
						zoom
							? { position: "fixed", ...zoom.box, boxSizing: "border-box", filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }
							: {
									height: state.height ?? 360,
									boxSizing: "content-box",
									filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined,
								}
					}
					onLoad={styleScrollbars}
					data-testid="demo-iframe"
				/>
			</div>
		</div>
	);
}

/**
 * Fullscreen demo chrome (owner, 2026-10-30): mounted by the chat page INSIDE
 * the session area (the MermaidOverlay shell — top bar stays draggable). It
 * holds NO iframe: the card's own iframe zooms over the empty slot below the
 * header (data-demo-overlay-slot), so the demo never reloads. Esc here is the
 * document listener (focus outside the sandbox); inside it the card forwards
 * the bridge's "demo-escape".
 */
export function DemoOverlay({
	title,
	initialInverted,
	onInvertedChange,
	onClose,
}: {
	title: string;
	initialInverted: boolean;
	onInvertedChange: (next: boolean) => void;
	onClose: () => void;
}) {
	const [inverted, setInverted] = useState(initialInverted);
	const toggleInverted = (next: boolean) => {
		setInverted(next);
		onInvertedChange(next);
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div
			// z-39, one under the other overlays (z-40): the zoomed iframe lives in
			// the scroller (earlier in the DOM) at z-40, so it clears this backdrop but
			// every later-mounted z-40 overlay (plan, mermaid, figure) covers both.
			className="absolute inset-0 z-[39] flex flex-col bg-background/80 p-4 backdrop-blur-sm"
			data-testid="demo-overlay"
		>
			<div className="mb-2 flex items-center gap-2">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						interactive demo
					</span>
					<span className="truncate text-xs font-medium tracking-wide text-foreground">{title}</span>
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-1.5">
					<Toggle
						checked={inverted}
						onChange={toggleInverted}
						label="Invert demo brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close fullscreen demo"
						data-testid="demo-overlay-close"
						className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-4" />
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1" data-demo-overlay-slot="" />
		</div>
	);
}

/** The card's stand-in while its demo runs fullscreen — same height as the
 *  iframe it replaced, so the transcript doesn't jump. */
export function DemoFullscreenPlaceholder({ height, onClose }: { height: number; onClose: () => void }) {
	return (
		<div
			className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground"
			style={{ height, boxSizing: "content-box" }}
			data-testid="demo-fullscreen-placeholder"
		>
			<span>Open in fullscreen</span>
			<button
				type="button"
				onClick={onClose}
				data-testid="demo-fullscreen-close"
				className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent hover:text-foreground"
			>
				Close fullscreen
			</button>
		</div>
	);
}

export function DemoErrorChip({
	title,
	message,
	onSend,
}: {
	title: string;
	message: string;
	onSend?: () => void;
}) {
	return (
		<div
			className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
			data-testid="demo-error-chip"
		>
			<span className="font-medium">This demo threw an error</span>
			<span className="min-w-0 flex-1 truncate font-mono text-xs" title={message}>
				{message}
			</span>
			{onSend && (
				<button
					type="button"
					onClick={onSend}
					className="rounded-md border border-red-500/40 px-2 py-1 text-xs font-medium hover:bg-red-500/15"
					data-testid="demo-error-send"
				>
					Send to teacher
				</button>
			)}
		</div>
	);
}
