"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isSidebarWidth, SIDEBAR_DEFAULT_WIDTH as DEFAULT, SIDEBAR_MIN_WIDTH as MIN, SIDEBAR_MAX_WIDTH as MAX } from "@/src/core/sidebar-width";
import { cn } from "@/lib/utils";

export function ResizableSidebar({ open, children }: { open: boolean; children: ReactNode }) {
	const [preferred, setPreferred] = useState(DEFAULT);
	const [limit, setLimit] = useState(MAX);
	const [dragWidth, setDragWidth] = useState<number | null>(null);
	const [saveError, setSaveError] = useState(false);
	const edited = useRef(false);
	const writes = useRef(Promise.resolve());
	const start = useRef<{ id: number; x: number; width: number } | null>(null);
	const width = Math.min(dragWidth ?? preferred, limit);
	const clamp = (n: number) => Math.max(MIN, Math.min(limit, Math.round(n)));

	useEffect(() => {
		let active = true;
		const resize = () => setLimit(Math.max(MIN, Math.min(MAX, window.innerWidth -
			(navigator.userAgent.includes("Electron") ? 640 : Math.min(640, window.innerWidth * 0.25)))));
		resize();
		window.addEventListener("resize", resize);
		void fetch("/api/settings", {cache:"no-store"}).then(r => r.ok ? r.json() : null).then(body => {
			const saved = body?.settings?.sidebar?.width;
			if (active && !edited.current && isSidebarWidth(saved)) setPreferred(saved);
		}).catch(() => {});
		return () => { active = false; window.removeEventListener("resize", resize); };
	}, []);
	function save(value: number) {
		edited.current = true;
		setPreferred(value);
		setSaveError(false);
		writes.current = writes.current.then(async () => {
			const r = await fetch("/api/settings/sidebar", { method: "PUT", keepalive: true,
				headers: { "Content-Type": "application/json" }, body: JSON.stringify({width: value}) });
			if (!r.ok) throw Error();
			setSaveError(false);
		}).catch(() => setSaveError(true));
	}
	function cancel() { start.current = null; setDragWidth(null); }
	return <aside aria-hidden={!open} className={cn("sidebar-motion relative shrink-0 overflow-hidden duration-200", open ? "w-(--session-sidebar-width)" : "w-0")}
		style={{"--session-sidebar-width": width + "px", ...(dragWidth !== null ? {transition: "none"} : {})} as CSSProperties}>
		{children}
		{open && <div role="separator" aria-label="Resize session sidebar" aria-orientation="vertical" tabIndex={0}
			aria-valuemin={MIN} aria-valuemax={limit} aria-valuenow={width}
			className="lh-no-drag absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none select-none focus-visible:outline-ring"
			onPointerDown={e => {
				if (!e.isPrimary || e.button !== 0) return;
				e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
				start.current = {id:e.pointerId, x:e.clientX, width}; setDragWidth(width);
			}}
			onPointerMove={e => { const d=start.current; if(d?.id===e.pointerId) setDragWidth(clamp(d.width+e.clientX-d.x)); }}
			onPointerUp={e => {
				const d=start.current; if (!d || d.id!==e.pointerId) return;
				const next=clamp(d.width+e.clientX-d.x); cancel(); if(next!==d.width) save(next);
			}} onLostPointerCapture={cancel} onPointerCancel={cancel}
			onKeyDown={e => {
				const step=e.shiftKey ? 32 : 8;
				const next=e.key==="ArrowLeft" ? width-step : e.key==="ArrowRight" ? width+step : e.key==="Home" ? DEFAULT : null;
				if(next===null) return; e.preventDefault(); e.stopPropagation(); save(clamp(next));
			}}
		/>}
		{open && saveError && <button onClick={() => save(preferred)} className="absolute bottom-12 left-2 rounded border bg-background px-2 text-xs" role="alert">Width not saved. Retry</button>}
	</aside>;
}
