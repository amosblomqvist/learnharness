"use client";

import { AlertCircleIcon, Loader2Icon, MusicIcon, VideoIcon, XIcon } from "lucide-react";
import { formatMediaTimestamp } from "@/src/core";
import type { PendingMediaItem } from "@/lib/client-media";

/** Compact strip of pending image/audio/video attachments inside the composer shell. */
export function ComposerMediaTray({
	items,
	onRemove,
}: {
	items: readonly PendingMediaItem[];
	onRemove: (localId: string) => void;
}) {
	if (!items.length) return null;
	return (
		<div
			data-testid="composer-media-tray"
			className="flex flex-wrap items-center gap-2 border-b border-border/50 px-2.5 py-2"
		>
			{items.map((item) => {
				if (item.kind === "image" && item.previewUrl && item.status !== "error") {
					return (
						<div
							key={item.localId}
							data-testid="pending-media-image"
							className="group relative size-12 shrink-0 overflow-hidden rounded-md border border-border/70 bg-secondary/40"
						>
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img
								src={item.previewUrl}
								alt={item.filename}
								className="size-full object-cover"
								draggable={false}
							/>
							{item.status === "preparing" && (
								<div className="absolute inset-0 flex items-center justify-center bg-background/60">
									<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
								</div>
							)}
							<button
								type="button"
								aria-label={`Remove ${item.filename}`}
								onClick={() => onRemove(item.localId)}
								className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-background/85 text-foreground shadow-xs transition-opacity hover:bg-background"
							>
								<XIcon className="size-2.5" aria-hidden />
							</button>
						</div>
					);
				}

				const isError = item.status === "error";
				const duration = item.attachment?.durationSec;
				return (
					<div
						key={item.localId}
						data-testid={`pending-media-${item.kind}`}
						title={isError ? item.error : item.filename}
						className={
							isError
								? "flex max-w-60 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 font-ui text-xs text-destructive"
								: "flex max-w-60 items-center gap-1.5 rounded-md border border-border/70 bg-secondary/50 px-2 py-1 font-ui text-xs text-foreground"
						}
					>
						{item.status === "preparing" ? (
							<Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
						) : isError ? (
							<AlertCircleIcon className="size-3.5 shrink-0" aria-hidden />
						) : item.kind === "audio" ? (
							<MusicIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
						) : (
							<VideoIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
						)}
						<span className="min-w-0 truncate">{isError ? (item.error ?? item.filename) : item.filename}</span>
						{!isError && duration !== undefined && (
							<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
								{formatMediaTimestamp(duration)}
							</span>
						)}
						{!isError && item.status === "preparing" && (
							<span className="shrink-0 text-[11px] text-muted-foreground">Preparing…</span>
						)}
						<button
							type="button"
							aria-label={`Remove ${item.filename}`}
							onClick={() => onRemove(item.localId)}
							className="ml-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<XIcon className="size-3" aria-hidden />
						</button>
					</div>
				);
			})}
		</div>
	);
}
