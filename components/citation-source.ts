import { messageAnchorId, type TutorCitation } from "@/src/core";
import { scrollSessionTarget, type SessionScrollContext } from "./session-navigation";
import { resolveCitationRange, sourceElements } from "./selection-text";

/**
 * Where a citation's words live in the transcript, shown with the CSS Custom
 * Highlight API (the same mechanism session find uses) so the transcript's
 * React-owned markup is never touched.
 */

type HighlightRegistry = { set(name: string, highlight: unknown): void; delete(name: string): boolean };

function registry(): HighlightRegistry | null {
	const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
	return css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === "function" ? css.highlights : null;
}

/** ::highlight() rules ship in an injected <style>, never globals.css —
 *  the PostCSS/Tailwind pipeline rejects the pseudo-element (session find's
 *  precedent). */
const STYLE_ID = "lh-citation-style";
function injectStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
::highlight(lh-citation-comment) { background-color: color-mix(in oklab, var(--primary) 30%, transparent); }
::highlight(lh-citation) { background-color: color-mix(in oklab, var(--primary) 45%, transparent); }`;
	document.head.appendChild(style);
}

/** Paint a named highlight over a range; returns the cleanup. No-op where
 *  the Highlight API is missing. */
export function highlightRange(name: "lh-citation" | "lh-citation-comment", range: Range): () => void {
	const highlights = registry();
	if (!highlights) return () => {};
	injectStyles();
	const HighlightCtor = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
	highlights.set(name, new HighlightCtor(range));
	return () => { highlights.delete(name); };
}

// ─── Go to source ────────────────────────────────────────────────────────────


export type RevealPlan = "navigate" | "highlight" | "message" | "missing";

export function revealPlan({ citationChatId, currentChatId, rangeFound, messageFound }: {
	citationChatId: string; currentChatId: string; rangeFound: boolean; messageFound: boolean;
}): RevealPlan {
	if (citationChatId !== currentChatId) return "navigate";
	if (rangeFound) return "highlight";
	return messageFound ? "message" : "missing";
}

/** The graph links' arrival path: the chat, scrolled to the message. */
export function citationSourceHref({ chatId, messageId }: Pick<TutorCitation, "chatId" | "messageId">): string {
	return `/chat/${encodeURIComponent(chatId)}#${encodeURIComponent(messageAnchorId(messageId))}`;
}

let stopPulse: (() => void) | null = null;

/** Two quick pulses, a hold, then gone (one steady hold under reduced motion). */
function pulse(range: Range, reducedMotion: boolean): void {
	stopPulse?.();
	const steps: Array<[on: boolean, at: number]> = reducedMotion
		? [[true, 0], [false, 1_800]]
		: [[true, 0], [false, 325], [true, 650], [false, 975], [true, 1_300], [false, 2_900]];
	let clear: () => void = () => {};
	const timers = steps.map(([on, at]) => window.setTimeout(() => {
		clear();
		clear = on ? highlightRange("lh-citation", range) : () => {};
	}, at));
	stopPulse = () => { timers.forEach((timer) => window.clearTimeout(timer)); clear(); stopPulse = null; };
}

/** Show a citation's words: highlight the quote, else flash its message,
 *  or open the other chat at that message. */
export function revealCitationSource({ transcript, scroll, citation, currentChatId, navigate }: {
	transcript: HTMLElement | null;
	scroll: SessionScrollContext | null;
	citation: TutorCitation;
	currentChatId: string;
	navigate: (href: string) => void;
}): RevealPlan {
	const range = transcript && citation.chatId === currentChatId ? resolveCitationRange(transcript, citation.messageId, citation) : null;
	const message = transcript
		? (transcript.ownerDocument.getElementById(messageAnchorId(citation.messageId)) ?? sourceElements(transcript, citation.messageId)[0] ?? null)
		: null;
	const plan = revealPlan({ citationChatId: citation.chatId, currentChatId, rangeFound: range !== null, messageFound: message !== null });
	if (plan === "navigate") navigate(citationSourceHref(citation));
	else if (plan === "highlight" && transcript) {
		scrollSessionTarget(range!, transcript, scroll);
		pulse(range!, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
	} else if (plan === "message" && transcript && message instanceof HTMLElement) {
		scrollSessionTarget(message, transcript, scroll);
		message.classList.add("lh-source-highlight");
		window.setTimeout(() => message.classList.remove("lh-source-highlight"), 2_000);
	}
	return plan;
}
