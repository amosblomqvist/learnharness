"use client";
/**
 * The invert switch, shared by figures and demos (auto-invert,
 * 2026-10-29). The persisted value is a PIN (core/artifact-invert.ts):
 * absent = auto. While an unpinned artifact's tone is still pending in
 * dark mode the stage HOLDS hidden (so a light figure never flashes
 * white before inverting) — at most HOLD_MS, then the tone settles as
 * "unknown" for this mount and the artifact shows as generated. The hold
 * is the .lh-artifact-hold class (app/globals.css), whose animation also
 * releases it at HOLD_MS before hydration.
 */
import { useContext, useEffect, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import { useRenderedMode } from "@/components/rendered-mode";
import { effectiveInverted, nextInvertPin, type ArtifactTone } from "@/src/core";

export const HOLD_MS = 300;

export function useArtifactInvert({
	initialPin,
	tone,
	messageId,
}: {
	initialPin: boolean | undefined;
	tone: ArtifactTone | "pending";
	messageId?: string;
}) {
	const actions = useContext(ChatActionsContext);
	const mode = useRenderedMode();
	const [pin, setPin] = useState<boolean | undefined>(initialPin);
	// First answer wins for this mount: the measured tone, or "unknown"
	// once the hold times out (a later measurement is ignored — the
	// artifact is already showing as generated).
	const [settled, setSettled] = useState<ArtifactTone | null>(tone === "pending" ? null : tone);
	useEffect(() => {
		if (settled === null && tone !== "pending") setSettled(tone);
	}, [tone, settled]);
	useEffect(() => {
		if (settled !== null) return;
		const t = setTimeout(() => setSettled("unknown"), HOLD_MS);
		return () => clearTimeout(t);
	}, [settled]);
	const effectiveTone: ArtifactTone = settled ?? "unknown";
	const held = pin === undefined && mode === "dark" && settled === null;
	// The silent artifact-ui route persists the pin (null = back to auto);
	// without a chat page (tests, previews) the toggle stays local-only.
	const toggle = (next: boolean) => {
		const stored = nextInvertPin(next, mode, effectiveTone);
		setPin(stored ?? undefined);
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: stored } }),
		}).catch(() => {});
	};
	return { inverted: effectiveInverted(pin, mode, effectiveTone), held, toggle };
}
