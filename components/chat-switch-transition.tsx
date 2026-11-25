"use client";

import type {} from "react/canary";
import * as React from "react";

const transcript = {
	"chat-switch-next": "chat-switch-next",
	"chat-switch-previous": "chat-switch-previous",
	default: "none",
};
const dock = {
	"chat-switch-next": "chat-switch-dock",
	"chat-switch-previous": "chat-switch-dock",
	"chat-switch-enter": "chat-switch-dock",
	default: "none",
};

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
