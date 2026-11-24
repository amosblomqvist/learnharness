"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { DownloadIcon, ExternalLinkIcon, FileTextIcon, MaximizeIcon, MusicIcon, VideoIcon } from "lucide-react";
import { ChatActionsContext } from "@/components/chat";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import {
	formatMediaTimestamp,
	isShowMediaDetails,
	type ArtifactPartProps,
	type MediaAttachment,
	type ShowMediaDetails,
} from "@/src/core";

/**
 * Lazily register media-chrome custom elements on the client only so SSR and
 * static-render test harnesses stay pure and warning-free.
 */
let mediaChromeLoaded = false;
function useMediaChrome(): void {
	useEffect(() => {
		if (mediaChromeLoaded || typeof window === "undefined") return;
		mediaChromeLoaded = true;
		void import("media-chrome").catch(() => {
			mediaChromeLoaded = false;
		});
	}, []);
}

export function buildYouTubeEmbedUrl(videoId: string, startSec?: number, endSec?: number): string {
	const params = new URLSearchParams({ rel: "0" });
	if (startSec !== undefined && startSec > 0) params.set("start", String(Math.floor(startSec)));
	if (endSec !== undefined && endSec > 0) params.set("end", String(Math.floor(endSec)));
	return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

export function buildSessionMediaUrl(chatId: string, mediaId: string, startSec?: number, endSec?: number): string {
	const base = `/api/chats/${encodeURIComponent(chatId)}/media/${encodeURIComponent(mediaId)}`;
	if (startSec !== undefined && endSec !== undefined) return `${base}#t=${Math.floor(startSec)},${Math.floor(endSec)}`;
	if (startSec !== undefined) return `${base}#t=${Math.floor(startSec)}`;
	return base;
}

function formatRangeBadge(startSec?: number, endSec?: number): string | null {
	if (startSec !== undefined && endSec !== undefined) return `${formatMediaTimestamp(startSec)} – ${formatMediaTimestamp(endSec)}`;
	if (startSec !== undefined) return `from ${formatMediaTimestamp(startSec)}`;
	if (endSec !== undefined) return `until ${formatMediaTimestamp(endSec)}`;
	return null;
}

/**
 * Shared local audio/video player built on media-chrome web components.
 * Used by both tutor `show_media` artifact cards and learner-uploaded media in
 * the transcript so playback looks and behaves uniformly across the app.
 */
export function SessionMediaPlayer({
	chatId,
	mediaId,
	kind,
	mimeType,
	filename,
	caption,
	startSec,
	endSec,
	durationSec,
	transcript,
	compact = false,
}: {
	chatId: string;
	mediaId: string;
	kind: "audio" | "video";
	mimeType: string;
	filename: string;
	caption?: string;
	startSec?: number;
	endSec?: number;
	durationSec?: number;
	transcript?: string;
	compact?: boolean;
}) {
	useMediaChrome();
	const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
	const controllerRef = useRef<HTMLElement | null>(null);
	const [transcriptOpen, setTranscriptOpen] = useState(false);
	const src = buildSessionMediaUrl(chatId, mediaId, startSec, endSec);
	const downloadHref = `/api/chats/${encodeURIComponent(chatId)}/media/${encodeURIComponent(mediaId)}`;
	const rangeBadge = formatRangeBadge(startSec, endSec);
	const label = kind === "audio" ? "Audio" : "Video";

	const toggleFullscreen = () => {
		const target = controllerRef.current ?? mediaRef.current;
		if (!target || typeof document === "undefined") return;
		if (document.fullscreenElement) {
			void document.exitFullscreen?.().catch(() => {});
		} else {
			void target.requestFullscreen?.().catch(() => {});
		}
	};

	useEffect(() => {
		const el = mediaRef.current;
		if (!el) return;
		const onLoaded = () => {
			if (startSec !== undefined && startSec > 0 && el.currentTime < startSec) {
				try { el.currentTime = startSec; } catch { /* ignore seek before ready */ }
			}
		};
		const onTimeUpdate = () => {
			if (endSec !== undefined && endSec > 0 && el.currentTime >= endSec) {
				el.pause();
			}
		};
		el.addEventListener("loadedmetadata", onLoaded);
		if (endSec !== undefined) el.addEventListener("timeupdate", onTimeUpdate);
		return () => {
			el.removeEventListener("loadedmetadata", onLoaded);
			if (endSec !== undefined) el.removeEventListener("timeupdate", onTimeUpdate);
		};
	}, [startSec, endSec]);

	return (
		<figure
			className={compact ? "my-2 w-full max-w-xl" : "my-4 w-full max-w-2xl"}
			data-testid={`media-player-${kind}`}
		>
			{kind === "video" ? (
				<div className="overflow-hidden rounded-lg border border-border/70 bg-black">
					<media-controller
						ref={controllerRef as React.RefObject<HTMLElement | null>}
						className="block aspect-video max-h-[60vh] w-full [&:fullscreen]:h-full [&:fullscreen]:max-h-none [&:fullscreen]:w-full [&:-webkit-full-screen]:h-full [&:-webkit-full-screen]:max-h-none [&:-webkit-full-screen]:w-full"
					>
						<video
							ref={mediaRef as React.RefObject<HTMLVideoElement | null>}
							slot="media"
							src={src}
							preload="metadata"
							playsInline
							className="h-full w-full object-contain"
						>
							<source src={src} type={mimeType} />
						</video>
						<media-control-bar className="w-full">
							<media-play-button />
							<media-time-display show-duration />
							<media-time-range />
							<media-mute-button />
							<media-volume-range className="w-20" />
							<media-playback-rate-button rates="0.75 1 1.25 1.5 2" />
							<media-fullscreen-button />
						</media-control-bar>
					</media-controller>
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border border-border/70 bg-card">
					<media-controller audio className="block w-full">
						<audio
							ref={mediaRef as React.RefObject<HTMLAudioElement | null>}
							slot="media"
							src={src}
							preload="metadata"
						>
							<source src={src} type={mimeType} />
						</audio>
						<media-control-bar className="w-full">
							<media-play-button />
							<media-time-display show-duration />
							<media-time-range />
							<media-mute-button />
							<media-volume-range className="w-20" />
							<media-playback-rate-button rates="0.75 1 1.25 1.5 2" />
						</media-control-bar>
					</media-controller>
				</div>
			)}

			<figcaption className="mt-2 flex items-start justify-between gap-2">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						{kind === "audio" ? <MusicIcon className="size-3" aria-hidden /> : <VideoIcon className="size-3" aria-hidden />}
						{label}
					</span>
					<span className="truncate text-sm text-muted-foreground" data-testid="media-caption">
						{caption ?? filename}
					</span>
					{rangeBadge && (
						<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
							{rangeBadge}
						</span>
					)}
					{!rangeBadge && durationSec !== undefined && (
						<span className="font-mono text-[11px] text-muted-foreground">
							{formatMediaTimestamp(durationSec)}
						</span>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{transcript && (
						<button
							type="button"
							aria-expanded={transcriptOpen}
							onClick={() => setTranscriptOpen((open) => !open)}
							data-testid="media-transcript-toggle"
							className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							title={transcriptOpen ? "Hide transcript" : "Show transcript"}
						>
							<FileTextIcon className="size-3.5" aria-hidden />
							<span>Transcript</span>
						</button>
					)}
					{kind === "video" && (
						<button
							type="button"
							aria-label="Maximize video"
							title="Fullscreen"
							data-testid="media-maximize"
							onClick={toggleFullscreen}
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<MaximizeIcon className="size-3.5" aria-hidden />
						</button>
					)}
					<a
						href={downloadHref}
						download={filename}
						aria-label={`Download ${label.toLowerCase()}`}
						title="Download"
						data-testid="media-download"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" aria-hidden />
					</a>
				</div>
			</figcaption>
			{transcript && transcriptOpen && (
				<div
					data-testid="media-transcript"
					className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border/60 bg-background/70 px-3 py-2 font-ui text-xs whitespace-pre-wrap text-muted-foreground"
				>
					{transcript}
				</div>
			)}
		</figure>
	);
}

/** YouTube privacy-enhanced inline embed card. */
export function YouTubeMediaCard({ details }: { details: Extract<ShowMediaDetails, { source: "youtube" }> }) {
	const frameBoxRef = useRef<HTMLDivElement | null>(null);
	const [transcriptOpen, setTranscriptOpen] = useState(false);
	const embedUrl = buildYouTubeEmbedUrl(details.videoId, details.startSec, details.endSec);
	const watchUrl = details.startSec ? `${details.url}&t=${Math.floor(details.startSec)}s` : details.url;
	const rangeBadge = formatRangeBadge(details.startSec, details.endSec);

	const toggleFullscreen = () => {
		const target = frameBoxRef.current;
		if (!target || typeof document === "undefined") return;
		if (document.fullscreenElement) {
			void document.exitFullscreen?.().catch(() => {});
		} else {
			void target.requestFullscreen?.().catch(() => {});
		}
	};

	return (
		<figure className="my-4 w-full max-w-2xl" data-testid="media-card-youtube">
			<div
				ref={frameBoxRef}
				className="aspect-video w-full overflow-hidden rounded-lg border border-border/70 bg-black [&:fullscreen]:aspect-auto [&:fullscreen]:h-full [&:fullscreen]:w-full [&:fullscreen]:rounded-none [&:fullscreen]:border-0"
			>
				<iframe
					src={embedUrl}
					title={details.caption ?? "YouTube video"}
					className="h-full w-full border-0"
					loading="lazy"
					referrerPolicy="strict-origin-when-cross-origin"
					allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
					allowFullScreen
				/>
			</div>
			<figcaption className="mt-2 flex items-start justify-between gap-2">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						<VideoIcon className="size-3" aria-hidden />
						YouTube
					</span>
					{details.caption && (
						<span className="text-sm text-muted-foreground" data-testid="media-caption">
							{details.caption}
						</span>
					)}
					{rangeBadge && (
						<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
							{rangeBadge}
						</span>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{details.transcript && (
						<button
							type="button"
							aria-expanded={transcriptOpen}
							onClick={() => setTranscriptOpen((open) => !open)}
							data-testid="media-transcript-toggle"
							className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							title={transcriptOpen ? "Hide subtitles" : "Show subtitles"}
						>
							<FileTextIcon className="size-3.5" aria-hidden />
							<span>Subtitles</span>
						</button>
					)}
					<button
						type="button"
						aria-label="Maximize video"
						title="Fullscreen"
						data-testid="media-maximize"
						onClick={toggleFullscreen}
						className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<MaximizeIcon className="size-3.5" aria-hidden />
					</button>
					<a
						href={watchUrl}
						target="_blank"
						rel="noopener noreferrer"
						aria-label="Open on YouTube"
						title="Open on YouTube"
						className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<ExternalLinkIcon className="size-3.5" aria-hidden />
					</a>
				</div>
			</figcaption>
			{details.transcript && transcriptOpen && (
				<div
					data-testid="media-transcript"
					className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border/60 bg-background/70 px-3 py-2 font-ui text-xs whitespace-pre-wrap text-muted-foreground"
				>
					{details.transcript}
				</div>
			)}
		</figure>
	);
}

/** Artifact renderer for the tutor's `show_media` tool. */
export function MediaCard({ part }: ArtifactPartProps) {
	const actions = useContext(ChatActionsContext);
	if (part.state !== "output-available") return <ToolCallCard part={part} />;
	const details = part.output;
	if (!isShowMediaDetails(details)) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Media shown, but it could not be displayed.
			</div>
		);
	}
	if (details.source === "youtube") {
		return <YouTubeMediaCard details={details} />;
	}
	if (!actions?.chatId) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Media ready: {details.filename}
			</div>
		);
	}
	return (
		<SessionMediaPlayer
			chatId={actions.chatId}
			mediaId={details.mediaId}
			kind={details.kind}
			mimeType={details.mimeType}
			filename={details.filename}
			caption={details.caption}
			startSec={details.startSec}
			endSec={details.endSec}
			transcript={details.transcript}
		/>
	);
}

/** Transcript renderer for learner-uploaded audio/video attachments inside user bands. */
export function SubmittedMedia({ chatId, items }: { chatId: string; items?: readonly MediaAttachment[] }) {
	const playable = items?.filter((item) => item.kind === "audio" || item.kind === "video") ?? [];
	if (!playable.length) return null;
	return (
		<div className="mt-2 w-full space-y-2" data-testid="submitted-media">
			{playable.map((item) => (
				<SessionMediaPlayer
					key={item.id}
					chatId={chatId}
					mediaId={item.id}
					kind={item.kind as "audio" | "video"}
					mimeType={item.mimeType}
					filename={item.filename}
					durationSec={item.durationSec}
					transcript={item.transcript}
					compact
				/>
			))}
		</div>
	);
}
