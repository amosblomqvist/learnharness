"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import type { Components } from "streamdown";
import { MessageResponse, streamdownPlugins } from "@/components/ai-elements/message";
import { HostDialog } from "@/components/host-dialog";
import { useInteractionLayers, type CloseOutcome, type OpeningLease } from "@/components/interaction-layers";
import { MarkdownDisplayOnlyContext, mdComponents } from "@/components/md-blocks";
import { Button } from "@/components/ui/button";

export interface StartupMessageOffer {
	message: { id: string; title: string; publishedAt: string; bodyMarkdown: string };
	deadlineAt: number;
}

const plainMarkdown = ["a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"];
let markdownComponents: Components;
function getMarkdownComponents() {
	// Resolve lazily, like HostMarkdown, because the shared renderer imports host UI.
	return markdownComponents ??= {
		...mdComponents,
		a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{children}</a> : <>{children}</>,
		pre: ({ children }) => <pre className="overflow-x-auto">{children}</pre>,
		code: ({ children }) => <code>{children}</code>,
	};
}

export function StartupMessageBody({ markdown }: { markdown: string }) {
	// Use the session renderer's prose typography and Markdown styles, while
	// keeping remote announcements passive (no HTML, embeds, or rich fences).
	return <MarkdownDisplayOnlyContext.Provider value={true}>
		<MessageResponse mode="static" skipHtml rehypePlugins={[]} allowedElements={plainMarkdown}
			plugins={{ cjk: streamdownPlugins.cjk }} components={getMarkdownComponents()} controls={false}
			urlTransform={(value, key) => {
				if (key !== "href" || !value.startsWith("https://")) return;
				try {
					const url = new URL(value);
					if (url.protocol === "https:" && !url.username && !url.password) return url.href;
				} catch { /* Non-HTTPS or invalid links render as text. */ }
			}}>{markdown}</MessageResponse>
	</MarkdownDisplayOnlyContext.Provider>;
}

export function StartupMessage() {
	const controller = useInteractionLayers();
	const headingId = useId();
	const layerId = `startup-message:${headingId}`;
	const request = useRef<Promise<StartupMessageOffer | null> | null>(null);
	const closing = useRef(false);
	const [open, setOpen] = useState<{ message: StartupMessageOffer["message"]; lease: OpeningLease } | null>(null);

	useLayoutEffect(() => {
		const bridge = window.lh;
		if (!bridge?.takeStartupMessage || !bridge.dismissStartupMessage) return;
		const foregroundBusy = () => controller.getSnapshot().some(layer => layer.kind === "modal" || layer.kind === "popup");
		let busy = foregroundBusy();
		let active = true;
		let lease: OpeningLease | null = null;
		let openingDeadline: ReturnType<typeof setTimeout> | undefined;
		const events = ["keydown", "pointerdown", "wheel", "dragenter", "blur"] as const;
		const stopWatching = () => {
			clearTimeout(openingDeadline);
			for (const event of events) window.removeEventListener(event, interrupt, true);
			unsubscribe();
		};
		const interrupt = () => {
			busy = true;
			stopWatching();
			if (lease) { lease.release(); setOpen(null); }
		};
		for (const event of events) window.addEventListener(event, interrupt, true);
		const unsubscribe = controller.subscribe(() => {
			if (controller.getLayer(layerId)) stopWatching();
			else if (foregroundBusy()) interrupt();
		});
		// Share the one request across Strict Mode effect replay. The desktop
		// process never offers a second message in this launch.
		request.current ??= bridge.takeStartupMessage().catch(() => null);
		void request.current.then(result => {
			if (!active || !result || busy || foregroundBusy() || !document.hasFocus() || Date.now() >= result.deadlineAt) {
				stopWatching();
				return;
			}
			lease = controller.reserveOpening("startup-message", {
				allowInitialMount: () => Date.now() < result.deadlineAt,
				onRevoke: interrupt,
			});
			if (lease?.activate()) {
				openingDeadline = setTimeout(interrupt, result.deadlineAt - Date.now());
				setOpen({ message: result.message, lease });
			} else stopWatching();
		});
		return () => { active = false; stopWatching(); lease?.release(); };
	}, [controller, layerId]);

	if (!open) return null;
	function dismiss(): CloseOutcome {
		if (closing.current || !open) return "pending";
		closing.current = true;
		// Let the local write settle before closing, but never trap someone
		// in the dialog if storage has become unwritable.
		void Promise.resolve(window.lh?.dismissStartupMessage?.(open.message.id)).catch(() => {}).then(() => {
			open.lease.release();
			setOpen(null);
		});
		return "pending";
	}

	return <HostDialog open layerId={layerId} openingLease={open.lease} aria-labelledby={headingId} onClose={dismiss}
		backdropProps={{ className: "fixed inset-0 flex items-center justify-center bg-background/80" }}
		frame={<div className="mx-4 flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-xl" />}>
		<header className="flex min-h-15 shrink-0 items-center gap-3 border-b border-border px-5 py-3">
			<h2 id={headingId} className="min-w-0 break-words font-title text-2xl tracking-tight">{open.message.title}</h2>
			<Button type="button" aria-label="Close announcement" variant="ghost" size="icon-xs"
				className="ml-auto size-7 rounded-sm text-muted-foreground hover:text-foreground" onClick={dismiss}>
				<XIcon aria-hidden="true" className="size-3.5" />
			</Button>
		</header>
		<div className="min-h-0 overflow-y-auto break-words p-5"><StartupMessageBody markdown={open.message.bodyMarkdown} /></div>
		<footer className="flex shrink-0 justify-end border-t border-border px-5 py-3">
			<Button type="button" variant="outline" size="sm" className="font-ui" onClick={dismiss}>Close</Button>
		</footer>
	</HostDialog>;
}
