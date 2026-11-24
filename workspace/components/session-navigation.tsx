"use client";

import { useCallback, useEffect, useRef } from "react";
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom";
import { messageAnchorId, messageIdFromHash } from "@/src/core";

export type SessionScrollContext = Pick<StickToBottomContext, "scrollRef" | "stopScroll">;

/** Scroll only the session's own containers (including tall question/code
 * areas), never sidebar/chrome. Inner containers move first, then the main
 * transcript. stopScroll releases the sticky-bottom animation BEFORE jumping. */
export function scrollSessionTarget(target: Range | HTMLElement, scope: HTMLElement, context: SessionScrollContext | null): void {
	const node = "startContainer" in target ? target.startContainer : target;
	const main = context?.scrollRef.current;
	if (main?.contains(node)) context!.stopScroll();
	for (let element = node.parentElement; element && scope.contains(element); element = element.parentElement) {
		const view = element.ownerDocument.defaultView;
		const style = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(element) : null;
		if (element !== main && (!style || !/(auto|scroll)/.test(style.overflowY) || element.scrollHeight <= element.clientHeight)) continue;
		const rect = target.getBoundingClientRect();
		const container = element.getBoundingClientRect();
		element.scrollTo({ top: element.scrollTop + rect.top - container.top - 16, behavior: "instant" });
	}
}

/** React owns message markup; this controller adds no messages or content.
 * Arrival on a full load is the browser's own hash scroll; this watcher owns
 * SPA arrivals (graph links) and later hash changes. The mount path polls on
 * a short interval ON PURPOSE: the transcript scroller's ref is attached by a
 * LATER SIBLING (StickToBottom.Content), hydration orderings vary, and a
 * frame-chained rAF proved cancellable mid-flight in dev (the owner's
 * every-link-lands-at-bottom report, 2026-10-13) — a synchronous tick that
 * retries until both elements exist has no cancellation window. */
export function SessionMessageNavigation() {
	const context = useStickToBottomContext();
	// ABSORB IDENTITY CHURN (the 2026-10-13 heisenbug): use-stick-to-bottom
	// re-creates stopScroll (and thus this context) while its initial scroll
	// settles. Reading it through a ref keeps `jump`'s identity STABLE, so the
	// effects below run once — a dep-churned cleanup used to cancel the queued
	// jump / strip the flash mid-flight, which is exactly the owner's
	// every-link-lands-at-bottom report (it only reproduced WITHOUT debug
	// logging shifting the timing).
	const contextRef = useRef(context);
	contextRef.current = context;
	const lastJump = useRef<{ hash: string; target: HTMLElement } | null>(null);
	const flash = useRef<{ target: HTMLElement; timer: number } | null>(null);
	const clearFlash = useCallback(() => {
		if (!flash.current) return;
		window.clearTimeout(flash.current.timer);
		flash.current.target.classList.remove("lh-source-highlight");
		flash.current = null;
	}, []);
	/** Synchronous arrival: release the bottom-follow lock, scroll every
	 * session container so the passage sits near the top, flash it. Returns
	 * true when this hash is (now) jumped-to. */
	const jump = useCallback((): boolean => {
		const { scrollRef, stopScroll } = contextRef.current;
		const hash = window.location.hash;
		const messageId = messageIdFromHash(hash);
		const main = scrollRef.current;
		const target = messageId ? document.getElementById(messageAnchorId(messageId)) : null;
		if (!main || !target || !main.contains(target)) return false;
		if (lastJump.current?.hash === hash && lastJump.current.target === target) return true;
		stopScroll();
		scrollSessionTarget(target, main, { scrollRef, stopScroll });
		clearFlash();
		target.classList.add("lh-source-highlight");
		flash.current = { target, timer: window.setTimeout(clearFlash, 2_000) };
		lastJump.current = { hash, target };
		return true;
	}, [clearFlash]);

	// Arrival on mount (a graph link opened this session, or a full load
	// carried the hash): retry on a short interval until the scroller and the
	// anchor both exist, then stop. The ~4s watchdog covers a never-arriving
	// anchor (a deleted message) — the session simply opens where it opens.
	useEffect(() => {
		if (!window.location.hash) return;
		let ticks = 0;
		const id = window.setInterval(() => {
			// Keep watching PAST the first success: hydration / record adoption
			// can REPLACE the node that was just jumped to (observed on cold
			// dev loads, 2026-10-13) — jump() re-targets the fresh node and
			// re-flashes it, while steady-state ticks are no-ops via the
			// lastJump guard. ~20s watchdog covers a cold compile (observed
			// 6.8s SSR flush) or slow first load; a deleted-message anchor
			// gives up and the session opens as-is.
			if (++ticks > 300) window.clearInterval(id);
			else jump();
		}, 64);
		return () => window.clearInterval(id);
	}, [jump]);

	useEffect(() => {
		const onHash = () => {
			lastJump.current = null;
			clearFlash();
			jump();
		};
		window.addEventListener("hashchange", onHash);
		window.addEventListener("popstate", onHash);
		// Cleanup removes LISTENERS ONLY: never clearFlash/lastJump here — a
	// dep-churned re-run must not strip a live flash (see the note above).
		return () => {
			window.removeEventListener("hashchange", onHash);
			window.removeEventListener("popstate", onHash);
		};
	}, [jump, clearFlash]);
	return null;
}
