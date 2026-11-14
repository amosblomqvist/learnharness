"use client";

import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { MistakeRecord } from "@/src/core";
import { useServerEvent } from "@/components/server-events";

/** The open session's recorded mistakes, keyed by `<chatId>:<toolCallId>` —
 *  the answer cards read their short "why" from here. Empty outside a chat
 *  (tests, previews), which renders no analysis. */
export const MistakesContext = createContext<ReadonlyMap<string, MistakeRecord>>(new Map());

/** Load a session's mistakes; refresh when they change (analysis landing). */
export function useChatMistakes(chatId: string): ReadonlyMap<string, MistakeRecord> {
	const [map, setMap] = useState<ReadonlyMap<string, MistakeRecord>>(new Map());
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const inFlight = useRef<AbortController | null>(null);
	const load = useCallback(async () => {
		inFlight.current?.abort();
		const controller = new AbortController();
		inFlight.current = controller;
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/mistakes`, { cache: "no-store", signal: controller.signal });
			if (!res.ok || controller.signal.aborted) return;
			const body = (await res.json()) as { mistakes?: MistakeRecord[] };
			if (controller.signal.aborted) return;
			const list = body.mistakes ?? [];
			setMap((prev) => (prev.size === 0 && list.length === 0 ? prev : new Map(list.map((m) => [m.id, m]))));
		} catch {
			/* keep what we have */
		} finally {
			if (inFlight.current === controller) inFlight.current = null;
		}
	}, [chatId]);
	useEffect(() => {
		void load();
		return () => {
			inFlight.current?.abort();
			clearTimeout(timer.current);
			clearTimeout(settleTimer.current);
		};
	}, [load]);
	const schedule = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => void load(), 250);
	}, [load]);
	useServerEvent("mistakes-changed", schedule);
	// A turn settling is when new misses get recorded. The delayed read has
	// the same lifetime as the view: never fire after unmount or a chat swap.
	useServerEvent("turn-settled", (p) => {
		if (p.chatId !== chatId) return;
		clearTimeout(settleTimer.current);
		settleTimer.current = setTimeout(() => void load(), 800);
	});
	return map;
}
