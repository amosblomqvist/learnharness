"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Toggle } from "@/components/settings/controls";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { ChatActionsContext } from "@/components/chat";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { useArtifactInvert } from "@/components/artifacts/use-artifact-invert";
import { toneFromCssColor, toneFromSamples, type ArtifactPartProps, type ArtifactTone, type DemoResult } from "@/src/core";

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
 * fix loop), plus {type:"demo-tone",samples} — so a demo drawn light
 * auto-inverts in the dark app. After load (+2 frames, so canvases have
 * drawn) the bridge samples eight points just inside the page edges: each
 * is the first opaque background under that point (a canvas reports its
 * own pixel, copied via drawImage so the demo's context is never touched),
 * "media" for svg/img/video, or null for an empty edge (the card's white
 * holder shows). The server-rendered iframe can load (and report) before
 * the card hydrates, so the card also ASKS on mount
 * ({type:"demo-tone-request"}).
 *
 * Bridge message handling is a pure function (reduceDemoBridgeState) so
 * tests cover it without a DOM.
 */

// ─── bridge injection + message handling (pure, testable) ───────────────────

export const DEMO_BRIDGE_SCRIPT = `<script>(function(){
var send=function(m){try{parent.postMessage(m,"*")}catch(e){}};
var post=function(){
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
setTimeout(post,50);
setTimeout(post,400);
var bg=function(el){for(var e=el;e;e=e.parentElement){var c=getComputedStyle(e).backgroundColor;if(c&&c!=="transparent"&&!/^rgba\(.*,\s*0\)$/.test(c))return c}return null};
var px=document.createElement("canvas");px.width=px.height=1;var pg=px.getContext("2d",{willReadFrequently:true});
var sample=function(x,y){var el=document.elementFromPoint(x,y);if(!el)return null;
if(el.tagName==="CANVAS"){try{var r=el.getBoundingClientRect();pg.clearRect(0,0,1,1);pg.drawImage(el,Math.floor((x-r.left)*el.width/r.width),Math.floor((y-r.top)*el.height/r.height),1,1,0,0,1,1);var d=pg.getImageData(0,0,1,1).data;if(d[3]>0)return"rgba("+d[0]+","+d[1]+","+d[2]+","+(d[3]/255)+")"}catch(e){return"media"}return bg(el.parentElement)}
if(el.closest("svg")||/^(IMG|VIDEO|PICTURE|IFRAME|OBJECT|EMBED)$/.test(el.tagName))return"media";
return bg(el)};
var tone=function(){try{var W=innerWidth,H=Math.min(innerHeight,document.documentElement.scrollHeight),xs=[2,W/2,W-3],ys=[2,H/2,H-3],s=[];
for(var a=0;a<3;a++)for(var b=0;b<3;b++){if(a!==1||b!==1)s.push(sample(xs[a],ys[b]))}
send({type:"demo-tone",samples:s})}catch(e){}};
var loaded=false;
window.addEventListener("load",function(){loaded=true;requestAnimationFrame(function(){requestAnimationFrame(tone)})});
window.addEventListener("message",function(e){if(loaded&&e.source===parent&&e.data&&e.data.type==="demo-tone-request")tone()});
})();</script>`;

/** Inject the bridge before </body> (or at the end of a body-less document). */
export function buildDemoSrcDoc(html: string): string {
	if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${DEMO_BRIDGE_SCRIPT}</body>`);
	return `${html}${DEMO_BRIDGE_SCRIPT}`;
}

export interface DemoBridgeState {
	height: number | null;
	error: string | null;
	/** Whether the page was drawn light; null = not reported yet. */
	tone: ArtifactTone | null;
}

export const INITIAL_DEMO_BRIDGE_STATE: DemoBridgeState = { height: null, error: null, tone: null };

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
	if (message.type === "demo-tone") {
		const { samples } = data as { samples?: unknown };
		if (!Array.isArray(samples) || !samples.every((x) => x === null || typeof x === "string")) return state;
		// An empty edge (or a transparent color) is the white holder showing.
		const tones = (samples as (string | null)[]).map((x): ArtifactTone =>
			x === null ? "light" : x === "media" ? "unknown" : (toneFromCssColor(x) ?? "light"),
		);
		const tone = toneFromSamples(tones);
		return tone === state.tone ? state : { ...state, tone };
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
 *  result. `messageId` + `initialPin` carry the PERSISTED invert switch
 *  (details.ui.inverted via the artifact-ui route, owner 2026-10-07) —
 *  absent = auto, following the rendered mode (auto-invert, 2026-10-29). */
export function DemoOutputCard({
	output,
	messageId,
	initialPin,
}: {
	output: unknown;
	messageId?: string;
	initialPin?: boolean;
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
		<DemoFrame title={result.title} html={result.html} messageId={messageId} initialPin={initialPin} />
	);
}

function DemoFrame({
	title,
	html,
	messageId,
	initialPin,
}: {
	title: string;
	html: string;
	messageId?: string;
	initialPin?: boolean;
}) {
	const actions = useContext(ChatActionsContext);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [state, setState] = useState<DemoBridgeState>(INITIAL_DEMO_BRIDGE_STATE);
	// Brightness inversion (owner, 2026-10-07): the switch state PERSISTS on
	// the steer record (details.ui.inverted) as a pin — absent = auto: a demo
	// whose page the bridge reports light shows inverted while the app
	// renders dark (use-artifact-invert.ts, 2026-10-29). The filter rides
	// the iframe element, which carries the card's white backing, so one
	// filter flips page + content together while hue-rotate(180deg) undoes
	// invert's hue flip.
	const { inverted, held, toggle: toggleInverted } = useArtifactInvert({
		initialPin,
		tone: state.tone ?? "pending",
		messageId,
	});
	const srcDoc = useMemo(() => buildDemoSrcDoc(html), [html]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			// Only messages from THIS demo's iframe (the sandbox gives it an
			// opaque origin; the window reference still matches).
			if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
			setState((prev) => reduceDemoBridgeState(prev, event.data));
		};
		window.addEventListener("message", onMessage);
		// A report sent before hydration was lost — ask again. If the frame
		// has not loaded yet, its own on-load report arrives after this.
		iframeRef.current?.contentWindow?.postMessage({ type: "demo-tone-request" }, "*");
		return () => window.removeEventListener("message", onMessage);
	}, []);

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
				</div>
			</div>
			{state.error && (
				<DemoErrorChip
					title={title}
					message={state.error}
					onSend={actions ? () => actions.sendText(`The demo "${title}" threw an error: ${state.error}`) : undefined}
				/>
			)}
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
				scrolling="no"
				className={`mt-2 w-full rounded-lg border bg-white${held ? " lh-artifact-hold" : ""}`}
				// content-box: the bridge reports the CONTENT height — with the
				// preflight's border-box the 2px border would eat into it and clip
				// the bottom of the demo (smoke finding, 2026-10-07).
				style={{
					height: state.height ?? 360,
					boxSizing: "content-box",
					filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined,
				}}
				data-testid="demo-iframe"
			/>
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
