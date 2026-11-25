"use client";

import { useEffect, useRef } from "react";

type DropTarget = (text: string) => void;
let primaryTarget: DropTarget | undefined;
let fallbackTarget: DropTarget | undefined;

/** Route an unfocused drop to the active dock, then the page composer. */
export function appendToFileDropTarget(text: string): boolean {
	const target = primaryTarget ?? fallbackTarget;
	if (!target) return false;
	target(text);
	return true;
}

export function appendFilePathText(current: string, paths: string): string {
	return current ? current.trimEnd() + " " + paths : paths;
}

export function useFileDropTarget(append: DropTarget, { enabled = true, fallback = false } = {}) {
	const latest = useRef(append);
	latest.current = append;
	useEffect(() => {
		if (!enabled) return;
		const target: DropTarget = (text) => latest.current(text);
		if (fallback) fallbackTarget = target;
		else primaryTarget = target;
		return () => {
			if (primaryTarget === target) primaryTarget = undefined;
			if (fallbackTarget === target) fallbackTarget = undefined;
		};
	}, [enabled, fallback]);
}
