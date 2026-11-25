"use client";

import type {} from "react/canary";
import * as React from "react";

const transcript = {
	"chat-switch-next": "chat-switch-next",
	"chat-switch-previous": "chat-switch-previous",
	"chat-switch-enter": "chat-switch-enter",
	default: "none",
};
const dock = {
	"chat-switch-next": "chat-switch-dock-down",
	"chat-switch-previous": "chat-switch-dock-up",
	"chat-switch-enter": "chat-switch-dock-down",
	default: "none",
};

/** React waits for a running view transition before committing another one. */
export function finishChatSwitchAnimation() {
	if (!document.startViewTransition) return;
	for (const animation of document.getAnimations()) {
		const effect = animation.effect;
		if (effect instanceof KeyframeEffect && /^::view-transition-[\w-]+\(chat-switch-(transcript|dock)\)$/.test(effect.pseudoElement ?? "")) {
			animation.finish();
		}
	}
}

/** Animate the captured viewport while its real scroll layout stays put. */
export function ChatSwitchTransition({ part, children }: { part: "transcript" | "dock"; children: React.ReactNode }) {
	const ViewTransition = React.ViewTransition;
	if (!ViewTransition) return children;
	const fixed = part === "dock";
	return (
		<ViewTransition name={`chat-switch-${part}`} default="none" share={fixed ? dock : transcript}
			enter={fixed ? dock : { "chat-switch-enter": "chat-switch-enter", default: "none" }}>
			{children}
		</ViewTransition>
	);
}
