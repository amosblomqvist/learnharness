"use client";

import { createContext, useContext, useRef, type RefObject } from "react";

export interface SessionViewState {
	draft?: string;
	questionDraft?: { questionId: string; text: string } | null;
	scrollTop?: number;
}
export interface WorkspaceState {
	id: string;
	panes: { id: string; sessionId: string | null }[];
	activePaneId: string;
	split: number;
	views: Record<string, SessionViewState>;
	keyboardOverrides?: string | null;
}
export interface WorkspaceBridge {
	get(): Promise<WorkspaceState>;
	onChanged(cb: (state: WorkspaceState) => void): () => void;
	open(sessionId: string | null, disposition: "active" | "beside" | "window", paneId?: string): Promise<void>;
	move(paneId: string): Promise<void>;
	close(paneId: string): Promise<void>;
	save(state: { activePaneId?: string; split?: number; keyboardOverrides?: string | null; views?: Record<string, SessionViewState> }): Promise<void>;
}
export interface PaneScope {
	id: string;
	active: boolean;
	root: RefObject<HTMLDivElement | null>;
	getView(): SessionViewState;
	saveView(patch: Partial<SessionViewState>): void;
}
export const PaneContext = createContext<PaneScope | null>(null);
export const usePane = () => useContext(PaneContext);

/** The default preserves ordinary browser pages, which have one surface. */
export function usePaneActive(): boolean {
	return usePane()?.active ?? true;
}

export function usePaneCommand() {
	const active = usePaneActive();
	const activeRef = useRef(active);
	activeRef.current = active;
	return () => activeRef.current;
}
