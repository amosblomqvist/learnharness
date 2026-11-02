"use client";

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
const Chat = lazy(() => import("@/components/chat").then(module => ({ default: module.Chat })));
const NewSession = lazy(() => import("@/components/new-session").then(module => ({ default: module.NewSession })));
import { PaneContext, type WorkspaceState, type SessionViewState } from "./pane-context";
import { slotsConfigured } from "@/src/core";
import type { LhMessage } from "@/src/core";

type ChatRecord = { id: string; title: string; kind?: "teach" | "practice"; messages: LhMessage[]; turnError?: string; turnInFlight?: boolean; compacting?: boolean };

function SessionPane({ pane, state, activate, hidden }: {
	pane: WorkspaceState["panes"][number]; state: WorkspaceState; activate: () => void; hidden: boolean;
}) {
	const root = useRef<HTMLDivElement>(null);
	const [record, setRecord] = useState<ChatRecord | null>(null);
	const [failure, setFailure] = useState("");
	const [saveError, setSaveError] = useState(false);
	const [configured, setConfigured] = useState(false);
	useEffect(() => { void fetch("/api/settings").then(r => r.json()).then((data: { settings: { models?: Parameters<typeof slotsConfigured>[0] } | null }) => setConfigured(slotsConfigured(data.settings?.models))).catch(() => {}); }, []);
	const sessionId = pane.sessionId;
	const viewsRef = useRef(state.views);
	viewsRef.current = state.views;
	const viewKey = sessionId ?? `pane:${pane.id}`;
	const getView = () => viewsRef.current[viewKey] ?? {};
	const saveView = (patch: Partial<SessionViewState>) => {
		const view = { ...getView(), ...patch };
		viewsRef.current = { ...viewsRef.current, [viewKey]: view };
		void window.lh?.workspace?.save({ views: { [viewKey]: patch } }).then(() => setSaveError(false)).catch(() => setSaveError(true));
	};
	useEffect(() => {
		if (!sessionId) return;
		const abort = new AbortController();
		void fetch(`/api/chats/${encodeURIComponent(sessionId)}`, { signal: abort.signal, cache: "no-store" })
			.then(async (response) => {
				if (response.status === 404) { void window.lh?.workspace?.open(null, "active", pane.id); return; }
				if (!response.ok) throw new Error("The session cannot load.");
				setRecord(await response.json());
			})
			.catch((error: Error) => { if (!abort.signal.aborted) setFailure(error.message); });
		return () => abort.abort();
	}, [sessionId]);
	return <PaneContext.Provider value={{ id: pane.id, active: !hidden && state.activePaneId === pane.id, root, getView, saveView }}>
		<div ref={root} data-workspace-pane={pane.id} data-active={state.activePaneId === pane.id} className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden border-2 border-transparent data-[active=true]:border-primary" onPointerDownCapture={activate} onFocusCapture={activate}>
			<div className="flex shrink-0 items-center justify-between border-b px-3 py-1 text-xs">
				<div className="flex min-w-0 items-center gap-2"><button className="truncate" onClick={activate}>{record?.title ?? "New session"}</button>{!hidden && state.activePaneId === pane.id && <span aria-current="true" data-testid="active-pane-label" className="rounded bg-primary px-1.5 py-0.5 font-medium text-primary-foreground">Active</span>}</div>
				<div className="flex gap-3"><button onClick={() => { window.dispatchEvent(new Event("lh:flush-views")); void window.lh?.workspace?.move(pane.id); }}>Move to New Window</button><button aria-label="Close pane" onClick={() => { window.dispatchEvent(new Event("lh:flush-views")); void window.lh?.workspace?.close(pane.id); }}>×</button></div>
			</div>
			{saveError && <p role="status" className="px-3 py-1 text-xs text-destructive">The view state could not save. Keep this window open.</p>}
			<div className="min-h-0 flex-1 [&>div]:h-full">
				<Suspense fallback={<p className="p-4">Loading session…</p>}>
				{!sessionId || failure === "deleted" ? <NewSession initialConfigured={configured} /> : record ? <Chat key={sessionId} chatId={record.id} title={record.title} kind={record.kind} initialMessages={record.messages} initialError={record.turnError} initiallyInFlight={record.turnInFlight} initiallyCompacting={record.compacting} initialConfigured={configured} /> : <p className="p-4">{failure || "Loading session…"}</p>}
				</Suspense>
			</div>
		</div>
	</PaneContext.Provider>;
}

export function SessionWorkspace({ children }: { children: ReactNode }) {
	const [state, setState] = useState<WorkspaceState | null>(null);
	const [narrow, setNarrow] = useState(false);
	const [width, setWidth] = useState(1280);
	const [graph, setGraph] = useState(false);
	const [practice, setPractice] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const pathname = usePathname();
	useEffect(() => {
		const bridge = window.lh?.workspace;
		if (!bridge) return;
		const receive = (next: WorkspaceState) => {
			if (next.keyboardOverrides) localStorage.setItem("lh:keymap", next.keyboardOverrides);
			else localStorage.removeItem("lh:keymap");
			setState(next);
		};
		const off = bridge.onChanged(receive);
		const showWorkspace = () => { setGraph(false); setPractice(false); };
		window.addEventListener("lh:show-workspace", showWorkspace);
		const showGraph = () => { setGraph(true); setPractice(false); };
		const showPractice = () => { setGraph(false); setPractice(true); };
		setPractice(window.location.pathname === "/chat/new" && new URLSearchParams(window.location.search).get("mode") === "practice");
		window.addEventListener("lh:show-practice", showPractice);
		window.addEventListener("lh:show-graph", showGraph);
		const saveKeys = () => void bridge.save({ keyboardOverrides: localStorage.getItem("lh:keymap") });
		window.addEventListener("lh:keymap-changed", saveKeys);
		void bridge.get().then(receive);
		return () => { off(); window.removeEventListener("lh:show-practice", showPractice); window.removeEventListener("lh:show-workspace", showWorkspace); window.removeEventListener("lh:show-graph", showGraph); window.removeEventListener("lh:keymap-changed", saveKeys); };
	}, []);
	useEffect(() => {
		if (!state || !root.current) return;
		const observer = new ResizeObserver(([entry]) => { if (entry) { setNarrow(entry.contentRect.width < 1288); setWidth(entry.contentRect.width); } });
		observer.observe(root.current);
		return () => observer.disconnect();
	}, [!!state, pathname]);
	useEffect(() => {
		if (!state) return;
		const match = /^\/chat\/([^/]+)$/.exec(pathname);
		if (match && match[1] !== "new" && !state.panes.some((pane) => pane.sessionId === match[1])) void window.lh?.workspace?.open(decodeURIComponent(match[1]!), "active");
	}, [pathname, !!state]);
	if (!state || pathname.startsWith("/settings")) return children;
	const showPage = graph || (practice && pathname === "/chat/new");
	const effectiveSplit = Math.max(640 / width, Math.min(1 - 648 / width, state.split));
	const activate = (id: string) => { if (id !== state.activePaneId) { setState({ ...state, activePaneId: id }); void window.lh?.workspace?.save({ activePaneId: id }); } };
	return <><div ref={root} data-testid="session-workspace" style={{ display: showPage ? "none" : undefined }} className="flex h-dvh min-w-0 flex-col">
		{narrow && state.panes.length > 1 && <div data-testid="pane-switcher" className="flex shrink-0 gap-2 border-b p-2">{state.panes.map((pane, index) => <button key={pane.id} aria-pressed={pane.id === state.activePaneId} onClick={() => activate(pane.id)}>Pane {index + 1}</button>)}</div>}
		<div className="flex min-h-0 flex-1">
			{state.panes.map((pane, index) => <div key={pane.id} style={{ display: narrow && pane.id !== state.activePaneId ? "none" : "flex", width: narrow || state.panes.length === 1 ? "100%" : `${(index === 0 ? effectiveSplit : 1 - effectiveSplit) * 100}%` }} className="min-w-0">
				<SessionPane key={`${pane.id}:${pane.sessionId}`} pane={pane} state={state} hidden={showPage} activate={() => activate(pane.id)} />
				{index === 0 && state.panes.length > 1 && !narrow && <div role="separator" aria-label="Resize session panes" aria-orientation="vertical" tabIndex={0} className="w-2 shrink-0 cursor-col-resize bg-border hover:bg-primary" onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); void window.lh?.workspace?.save({ split: Math.max(.2, Math.min(.8, state.split + (event.key === "ArrowRight" ? .02 : -.02))) }); } }} onPointerDown={(event) => {
					const divider = event.currentTarget;
					divider.setPointerCapture(event.pointerId);
					const move = (e: PointerEvent) => { const rect = root.current?.getBoundingClientRect(); if (rect) void window.lh?.workspace?.save({ split: Math.max(.2, Math.min(.8, (e.clientX - rect.left) / rect.width)) }); };
					const end = () => { divider.removeEventListener("pointermove", move); divider.removeEventListener("pointerup", end); divider.removeEventListener("pointercancel", end); };
					divider.addEventListener("pointermove", move); divider.addEventListener("pointerup", end); divider.addEventListener("pointercancel", end);
				}} />}
			</div>)}
		</div>
	</div>{showPage && children}</>;
}
