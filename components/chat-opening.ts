"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { Chat } from "@/components/chat";
import { kbdEventForAction } from "@/src/core";

export type ChatSeed = Pick<ComponentProps<typeof Chat>, "chatId" | "title" | "kind" | "initialMessages" | "initialError" | "initiallyInFlight" | "initiallyCompacting">;
const FIND_EVENT = kbdEventForAction("find");

export function useChatOpening(chatId: string, loading: boolean, onLoaded: (seed: ChatSeed) => void) {
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const findRequested = useRef(false);

	useEffect(() => {
		if (!loading) {
			if (findRequested.current) window.dispatchEvent(new CustomEvent(FIND_EVENT));
			findRequested.current = false;
			return;
		}
		const recordFind = () => { findRequested.current = true; };
		window.addEventListener(FIND_EVENT, recordFind);
		return () => window.removeEventListener(FIND_EVENT, recordFind);
	}, [loading]);

	useEffect(() => {
		if (!loading) return;
		const controller = new AbortController();
		const load = async () => {
			try {
				const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}?view=bootstrap`, {
					signal: controller.signal, cache: "no-store",
				});
				if (!response.ok) throw new Error("Could not load chat history");
				const result = await response.json() as ChatSeed;
				if (!controller.signal.aborted) onLoaded(result);
			} catch {
				if (!controller.signal.aborted) setFailed(true);
			}
		};
		void load();
		return () => controller.abort();
	}, [chatId, attempt, loading, onLoaded]);

	return { failed, retry: () => { setFailed(false); setAttempt(value => value + 1); } };
}
