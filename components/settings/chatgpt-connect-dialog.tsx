"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";

export interface ChatGPTStatus {
	available: boolean;
	connected: boolean;
	connecting?: boolean;
	phase?: "idle" | "preparing" | "waiting" | "exchanging" | "verifying" | "connected" | "error";
	authorizationUrl?: string;
	error?: string;
}

const PROGRESS: Record<NonNullable<ChatGPTStatus["phase"]>, { label: string; percent: number }> = {
	idle: { label: "Ready to connect", percent: 0 },
	preparing: { label: "Preparing a secure sign-in…", percent: 15 },
	waiting: { label: "Waiting for authorization in your browser…", percent: 45 },
	exchanging: { label: "Exchanging the authorization code…", percent: 72 },
	verifying: { label: "Verifying your ChatGPT account…", percent: 90 },
	connected: { label: "ChatGPT is connected", percent: 100 },
	error: { label: "Connection was not completed", percent: 100 },
};

export function ChatGPTConnectDialog({
	status,
	copied,
	onCopy,
	onOpenBrowser,
	onRetry,
	onClose,
}: {
	status: ChatGPTStatus;
	copied: boolean;
	onCopy: () => void;
	onOpenBrowser: () => void;
	onRetry: () => void;
	onClose: () => void;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	const progress = PROGRESS[status.phase ?? "preparing"];

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [onClose]);

	return createPortal(
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="chatgpt-connect-title"
			data-testid="chatgpt-connect-dialog"
			className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-sm"
			{...backdropDismiss}
		>
			<div className="mx-4 w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
				<div className="flex items-start gap-4">
					<div className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full border ${
						status.connected
							? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
							: status.phase === "error"
								? "border-red-500/40 bg-red-500/10 text-red-500"
								: "border-border bg-accent text-foreground"
					}`}>
						{status.connected ? (
							<svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 8.5 3 3 7-7" /></svg>
						) : status.phase === "error" ? (
							<span className="text-sm font-semibold">!</span>
						) : (
							<span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
						)}
					</div>
					<div className="min-w-0 flex-1">
						<h2 id="chatgpt-connect-title" className="font-title text-xl tracking-tight">Connect ChatGPT</h2>
						<p className="mt-1 text-xs text-muted-foreground">Use your ChatGPT plan alongside your existing API-key providers.</p>
					</div>
				</div>

				<div className="mt-5" aria-live="polite">
					<div className="flex items-center justify-between gap-3 text-xs">
						<span className={status.phase === "error" ? "text-red-500" : "text-foreground"}>{progress.label}</span>
						<span className="font-mono text-[10px] text-muted-foreground">{progress.percent}%</span>
					</div>
					<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-accent">
						<div className={`h-full rounded-full transition-[width] duration-500 ${status.phase === "error" ? "bg-red-500" : "bg-foreground"}`} style={{ width: `${progress.percent}%` }} />
					</div>
				</div>

				<div className="mt-5">
					<label htmlFor="chatgpt-authorization-link" className="text-[11px] font-medium text-muted-foreground">Authorization link</label>
					<div className="mt-1.5 flex gap-2">
						<input
							id="chatgpt-authorization-link"
							readOnly
							value={status.authorizationUrl ?? "Generating secure link…"}
							onFocus={(event) => status.authorizationUrl && event.currentTarget.select()}
							className="h-9 min-w-0 flex-1 rounded-sm border border-border bg-background px-2 font-mono text-[10px] text-muted-foreground outline-none focus:border-muted-foreground/60"
						/>
						<button type="button" disabled={!status.authorizationUrl} onClick={onCopy} data-testid="chatgpt-copy-link" className="h-9 shrink-0 rounded-sm border border-border px-3 text-xs text-foreground transition-colors hover:bg-accent disabled:text-muted-foreground/40">
							{copied ? "Copied" : "Copy link"}
						</button>
					</div>
					<p className="mt-2 text-[11px] text-muted-foreground">The browser opens automatically. Copy this link if you want to continue in another browser.</p>
				</div>

				{status.error && status.phase === "error" && <p role="alert" className="mt-4 rounded-sm border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-500">{status.error}</p>}

				<div className="mt-5 flex items-center justify-end gap-2">
					{status.connecting && <button type="button" disabled={!status.authorizationUrl} onClick={onOpenBrowser} className="mr-auto rounded-sm px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:text-muted-foreground/30">Open browser</button>}
					{status.phase === "error" && <button type="button" onClick={onRetry} className="rounded-sm border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent">Try again</button>}
					<button type="button" onClick={onClose} className="rounded-sm bg-foreground px-3 py-1.5 text-xs text-background transition-opacity hover:opacity-85">
						{status.connected ? "Done" : status.connecting ? "Cancel" : "Close"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
