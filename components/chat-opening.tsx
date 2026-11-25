"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Chat } from "@/components/chat";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { kbdEventForAction, projectView, type LhMessage } from "@/src/core";
import { transcriptRows } from "./transcript-rows";

type ChatSeed = Pick<ComponentProps<typeof Chat>, "chatId" | "title" | "kind" | "initialMessages" | "initialError" | "initiallyInFlight" | "initiallyCompacting">;
const FIND_EVENT = kbdEventForAction("find");

export function ChatOpening({ chatId, title, recent, initialConfigured }: {
	chatId: string;
	title: string;
	recent: LhMessage[];
	initialConfigured: boolean;
}) {
	const [seed, setSeed] = useState<ChatSeed | null>(null);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const findRequested = useRef(false);

	useEffect(() => {
		if (seed) {
			if (findRequested.current) window.dispatchEvent(new CustomEvent(FIND_EVENT));
			findRequested.current = false;
			return;
		}
		const recordFind = () => { findRequested.current = true; };
		window.addEventListener(FIND_EVENT, recordFind);
		return () => window.removeEventListener(FIND_EVENT, recordFind);
	}, [seed]);

	useEffect(() => {
		const controller = new AbortController();
		const load = async () => {
			try {
				const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}?view=bootstrap`, {
					signal: controller.signal, cache: "no-store",
				});
				if (!response.ok) throw new Error("Could not load chat history");
				const result = await response.json() as ChatSeed;
				if (!controller.signal.aborted) setSeed(result);
			} catch {
				if (!controller.signal.aborted) setFailed(true);
			}
		};
		// Let the preview paint before starting the full record request. The
		// timeout also makes progress if a hidden tab suppresses animation frames.
		let nextFrame = 0;
		let started = false;
		const start = () => {
			if (started) return;
			started = true;
			void load();
		};
		const frame = requestAnimationFrame(() => {
			nextFrame = requestAnimationFrame(start);
		});
		const timeout = window.setTimeout(start, 250);
		return () => {
			cancelAnimationFrame(frame);
			cancelAnimationFrame(nextFrame);
			window.clearTimeout(timeout);
			controller.abort();
		};
	}, [chatId, attempt]);

	if (seed) return <Chat {...seed} initialConfigured={initialConfigured} />;

	// Only the canonical Chat may run a turn, register plugin actions, or
	// infer question/phase state. This opening view is a short text preview.
	const rows = transcriptRows(projectView(recent)).flatMap(row => {
		const text = row.message.parts.slice(row.start, row.end).flatMap(part => part.type === "text" && part.text ? [part.text] : []);
		return text.length ? [{ key: row.key, role: row.message.role, text }] : [];
	}).slice(-6);
	return (
		<div data-chat-opening="" data-session-surface="" className="flex h-dvh min-w-0 flex-col">
			<TopBar><span className="min-w-0 truncate font-title text-3xl tracking-tight">{title}</span></TopBar>
			<Conversation initial="instant" className="min-h-0 flex-1" aria-busy={!failed}>
				<ConversationContent className="min-h-full justify-end p-0">
					<div inert className="lh-transcript-column mx-auto flex w-full flex-col gap-4 px-6 py-4">
						{rows.map(row => row.role === "user" ? (
							<div key={row.key} className="w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 bg-card py-1 pl-[14px] pr-4 font-ui text-xs">
								<div className="font-medium uppercase tracking-wide text-muted-foreground">You</div>
								<div className="lh-prose whitespace-pre-wrap text-foreground">{row.text.join("\n")}</div>
							</div>
						) : (
							<Message key={row.key} from="assistant" className="max-w-full">
								<MessageContent className="w-full">
									{row.text.map((text, i) => <MessageResponse key={i}>{text}</MessageResponse>)}
								</MessageContent>
							</Message>
						))}
					</div>
				</ConversationContent>
			</Conversation>
			<div className="flex shrink-0 items-center justify-center gap-3 border-t border-border px-6 py-3 font-ui text-xs text-muted-foreground">
				<span role="status">{failed ? "Could not load chat history." : "Loading chat history…"}</span>
				{failed && <Button size="sm" variant="outline" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>Retry</Button>}
			</div>
		</div>
	);
}
