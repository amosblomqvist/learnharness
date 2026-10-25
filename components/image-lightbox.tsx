"use client";

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	type WheelEvent as ReactWheelEvent,
} from "react";
import { imageFileName, rasterMimeOf } from "@/src/core";
import { useEscapeClaim } from "@/components/escape-claim";
import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "@/components/pan-zoom";
import { DownloadIcon, MaximizeIcon, XIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";

/** Mount inside the session area so the app chrome stays usable. */
const STEP = 1.25;

function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
	useEscapeClaim(onClose);
	const mime = rasterMimeOf(url);
	const closeRef = useRef<HTMLButtonElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
	const [view, setView] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
	const [floor, setFloor] = useState(1);
	const drag = useRef<{ id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
	const justDragged = useRef(false);

	// Focus the close button, give focus back to the opener on unmount.
	useEffect(() => {
		const prev = document.activeElement as HTMLElement | null;
		closeRef.current?.focus();
		return () => {
			if (prev && typeof prev.focus === "function" && prev.isConnected) prev.focus();
		};
	}, []);

	const stageSize = () => {
		const el = stageRef.current;
		return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
	};
	const fit = useCallback(() => {
		if (!natural) return;
		const vp = stageSize();
		const z = fitZoomFor(natural, vp);
		setFloor(z);
		setView(fitGraphView(natural, vp, z));
	}, [natural]);
	useEffect(fit, [fit]);
	useEffect(() => {
		const el = stageRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [fit]);

	const zoomBy = (factor: number, focus?: { x: number; y: number }) => {
		if (!natural) return;
		const vp = stageSize();
		setView((v) => zoomedGraphView(v, factor, floor, focus ?? { x: vp.w / 2, y: vp.h / 2 }, natural, vp));
	};
	const onWheel = (e: ReactWheelEvent) => {
		const r = stageRef.current?.getBoundingClientRect();
		zoomBy(e.deltaY < 0 ? STEP : 1 / STEP, r ? { x: e.clientX - r.left, y: e.clientY - r.top } : undefined);
	};

	const endDrag = (e?: ReactPointerEvent) => {
		const d = drag.current;
		drag.current = null;
		if (d?.moved) {
			justDragged.current = true;
			setTimeout(() => (justDragged.current = false), 0);
		}
		if (e && d) {
			try {
				e.currentTarget.releasePointerCapture?.(d.id);
			} catch {
				/* capture already gone */
			}
		}
	};
	// A pointer cancelled by unmount must not leave a stale drag behind.
	useEffect(() => () => void (drag.current = null), []);

	const onPointerDown = (e: ReactPointerEvent<HTMLImageElement>) => {
		if (!natural || view.zoom <= floor) return; // at the fit there is nothing to pan
		drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
		e.currentTarget.setPointerCapture?.(e.pointerId);
	};
	const onPointerMove = (e: ReactPointerEvent) => {
		const d = drag.current;
		if (!d || d.id !== e.pointerId) return;
		const dx = e.clientX - d.sx;
		const dy = e.clientY - d.sy;
		if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
		setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
	};

	const download = () => {
		const a = document.createElement("a");
		a.href = url;
		a.download = imageFileName(url);
		a.click();
	};
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "+" || e.key === "=") zoomBy(STEP);
		else if (e.key === "-") zoomBy(1 / STEP);
		else if (e.key === "0") fit();
		else return;
		e.preventDefault();
	};

	const btn =
		"flex size-9 items-center justify-center rounded-lg border bg-card text-muted-foreground transition-colors hover:text-foreground";
	if (!mime) return null;
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Image"
			data-testid="image-lightbox"
			tabIndex={-1}
			onKeyDown={onKeyDown}
			className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
		>
			<div className="absolute right-4 top-4 z-10 flex gap-2">
				<button type="button" aria-label="Zoom in" onClick={() => zoomBy(STEP)} className={btn}>
					<ZoomInIcon className="size-4" />
				</button>
				<button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / STEP)} className={btn}>
					<ZoomOutIcon className="size-4" />
				</button>
				<button type="button" aria-label="Fit to window" onClick={fit} className={btn}>
					<MaximizeIcon className="size-4" />
				</button>
				<button type="button" aria-label="Download image" onClick={download} className={btn}>
					<DownloadIcon className="size-4" />
				</button>
				<button ref={closeRef} type="button" aria-label="Close image" onClick={onClose} className={btn}>
					<XIcon className="size-4" />
				</button>
			</div>
			{/* The stage: a backdrop click (not a drag) closes. */}
			<div
				ref={stageRef}
				data-testid="image-lightbox-stage"
				className="absolute inset-0 overflow-hidden"
				onClick={() => !justDragged.current && onClose()}
				onWheel={onWheel}
			>
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img
					src={url}
					alt="Image"
					draggable={false}
					onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
					onClick={(e) => e.stopPropagation()}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
					style={{
						position: "absolute",
						left: 0,
						top: 0,
						maxWidth: "none",
						transformOrigin: "0 0",
						transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
						cursor: view.zoom > floor ? "grab" : "default",
						touchAction: "none",
						visibility: natural ? "visible" : "hidden",
					}}
					className="rounded-lg border bg-card shadow-lg"
				/>
			</div>
		</div>
	);
}

/**
 * The open state + mount every surface shares: `open(url)` shows the
 * picture (non-raster URLs are refused), and `lightbox` is the node to
 * render inside the surface's relative session area (null while closed).
 */
export function useImageLightbox(): { open: (url: string) => void; lightbox: ReactNode } {
	const [url, setUrl] = useState<string | null>(null);
	const close = useCallback(() => setUrl(null), []);
	const open = useCallback((u: string) => setUrl(rasterMimeOf(u) ? u : null), []);
	return {
		open,
		lightbox: url === null ? null : <ImageLightbox url={url} onClose={close} />,
	};
}
