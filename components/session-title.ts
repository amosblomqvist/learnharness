"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerEvent, useServerResync } from "./server-events";

/** Titles can change while a lesson streams. Refresh only title state on a
 * notification; adopting a whole transcript here would interrupt the stream. */
export function useSessionTitle(chatId: string, initialTitle: string) {
	const [title, setTitle] = useState(initialTitle);
	const revision = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++revision.current;
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
			if (!response.ok) return;
			const record = await response.json() as { title?: string };
			if (request === revision.current && typeof record.title === "string") setTitle(record.title);
		} catch {
			// Keep the last known title; the next notification/reconnect retries.
		}
	}, [chatId]);
	const applyRename = useCallback((next: string) => {
		// A completed manual rename supersedes any older read still in flight.
		revision.current++;
		setTitle(next);
	}, []);
	useEffect(() => {
		setTitle(initialTitle);
		void refresh();
		return () => { revision.current++; };
	}, [initialTitle, refresh]);
	useServerEvent("chats-changed", () => void refresh());
	useServerResync(() => void refresh());
	return [title, applyRename] as const;
}
