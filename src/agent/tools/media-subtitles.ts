/**
 * Subtitle & caption extraction for audio/video lessons.
 *
 * Enforces the harness invariant that any audio or video collected/embedded by
 * the agent must have readable subtitles or a transcript available so the agent
 * can ground its teaching directly in the media's spoken content.
 *
 * Supports:
 *   - YouTube caption tracks (fetched through SSRF-guarded `safeFetch`)
 *   - Local WebVTT (.vtt) and SubRip (.srt) subtitle files
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { formatMediaTimestamp, MAX_MEDIA_TRANSCRIPT_CHARS } from "../../core/contracts.ts";
import { safeFetch } from "./safe-fetch.ts";
import { resolveSourcePath } from "./fs-shared.ts";

export interface SubtitleCue {
	startSec: number;
	endSec?: number;
	text: string;
}

export class NoSubtitlesError extends Error {}

const MAX_SUBTITLE_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB
const YOUTUBE_FETCH_TIMEOUT_MS = 12_000;
const ALLOWED_CAPTION_HOSTS = new Set([
	"www.youtube.com",
	"youtube.com",
	"m.youtube.com",
	"timedtext.google.com",
]);

function decodeEntities(input: string): string {
	// YouTube timedtext sometimes double-encodes entities (e.g. &amp;#39;).
	const decodeOnce = (s: string) =>
		s
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/&quot;/gi, '"')
			.replace(/&#39;|&apos;/gi, "'")
			.replace(/&#(\d+);/g, (_m, code) => {
				const n = Number.parseInt(code, 10);
				return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
			})
			.replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
				const n = Number.parseInt(hex, 16);
				return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
			});
	return decodeOnce(decodeOnce(input));
}

function cleanCueText(raw: string): string {
	return decodeEntities(raw.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

function parseTimestamp(raw: string): number | null {
	const cleaned = raw.trim().replace(",", ".");
	const parts = cleaned.split(":");
	if (parts.length === 2) {
		const m = Number.parseFloat(parts[0]!);
		const s = Number.parseFloat(parts[1]!);
		return Number.isFinite(m) && Number.isFinite(s) ? m * 60 + s : null;
	}
	if (parts.length === 3) {
		const h = Number.parseFloat(parts[0]!);
		const m = Number.parseFloat(parts[1]!);
		const s = Number.parseFloat(parts[2]!);
		return Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s) ? h * 3600 + m * 60 + s : null;
	}
	return null;
}

/** Parse WebVTT (.vtt) or SubRip (.srt) text into timestamped subtitle cues. */
export function parseSubtitlesVttOrSrt(raw: string): SubtitleCue[] {
	const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const blocks = normalized.split(/\n{2,}/);
	const cues: SubtitleCue[] = [];

	for (const block of blocks) {
		const lines = block
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		if (lines.length === 0) continue;
		if (/^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(lines[0]!)) continue;

		const timeIdx = lines.findIndex((l) => l.includes("-->"));
		if (timeIdx < 0) continue;

		const timeLine = lines[timeIdx]!;
		const [startRaw, endAndSettings] = timeLine.split("-->");
		if (!startRaw || !endAndSettings) continue;
		const endRaw = endAndSettings.trim().split(/\s+/)[0] ?? "";
		const startSec = parseTimestamp(startRaw);
		const endSec = parseTimestamp(endRaw);
		if (startSec === null) continue;

		const text = cleanCueText(lines.slice(timeIdx + 1).join(" "));
		if (!text) continue;
		const prev = cues[cues.length - 1];
		if (prev && prev.text === text) continue;
		cues.push({ startSec, ...(endSec !== null ? { endSec } : {}), text });
	}
	return cues;
}

/** Parse YouTube timedtext XML (<text start="..." dur="..."> or srv3 <p t="..." d="...">). */
export function parseYouTubeTimedTextXml(xml: string): SubtitleCue[] {
	const cues: SubtitleCue[] = [];

	// Classic XML format: <text start="1.23" dur="2.5">Hello</text>
	const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
	for (const match of xml.matchAll(textRe)) {
		const attrs = match[1] ?? "";
		const startMatch = /\bstart\s*=\s*["']([^"']+)["']/i.exec(attrs);
		const durMatch = /\bdur\s*=\s*["']([^"']+)["']/i.exec(attrs);
		const startSec = startMatch ? Number.parseFloat(startMatch[1]!) : Number.NaN;
		if (!Number.isFinite(startSec)) continue;
		const durSec = durMatch ? Number.parseFloat(durMatch[1]!) : Number.NaN;
		const text = cleanCueText(match[2] ?? "");
		if (!text) continue;
		cues.push({
			startSec,
			...(Number.isFinite(durSec) && durSec > 0 ? { endSec: startSec + durSec } : {}),
			text,
		});
	}
	if (cues.length > 0) return cues;

	// srv3 XML format: <p t="1230" d="2500"><s>Hello</s></p>
	const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
	for (const match of xml.matchAll(pRe)) {
		const attrs = match[1] ?? "";
		const tMatch = /\bt\s*=\s*["'](\d+)["']/i.exec(attrs);
		const dMatch = /\bd\s*=\s*["'](\d+)["']/i.exec(attrs);
		if (!tMatch) continue;
		const startSec = Number.parseInt(tMatch[1]!, 10) / 1000;
		const durSec = dMatch ? Number.parseInt(dMatch[1]!, 10) / 1000 : Number.NaN;
		const text = cleanCueText(match[2] ?? "");
		if (!text) continue;
		cues.push({
			startSec,
			...(Number.isFinite(durSec) && durSec > 0 ? { endSec: startSec + durSec } : {}),
			text,
		});
	}
	return cues;
}

/** Parse YouTube json3 caption payload if returned instead of XML. */
export function parseYouTubeJson3(raw: string): SubtitleCue[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const events = (parsed as { events?: unknown })?.events;
	if (!Array.isArray(events)) return [];
	const cues: SubtitleCue[] = [];
	for (const ev of events) {
		if (!ev || typeof ev !== "object") continue;
		const e = ev as { tStartMs?: unknown; dDurationMs?: unknown; segs?: Array<{ utf8?: unknown }> };
		if (typeof e.tStartMs !== "number" || !Array.isArray(e.segs)) continue;
		const text = cleanCueText(e.segs.map((s) => (typeof s?.utf8 === "string" ? s.utf8 : "")).join(""));
		if (!text) continue;
		const startSec = e.tStartMs / 1000;
		const endSec = typeof e.dDurationMs === "number" && e.dDurationMs > 0 ? (e.tStartMs + e.dDurationMs) / 1000 : undefined;
		cues.push({ startSec, ...(endSec !== undefined ? { endSec } : {}), text });
	}
	return cues;
}

/** Format cues into compact timestamped lines, optionally sliced to [startSec, endSec]. */
export function formatSubtitleCues(
	cues: readonly SubtitleCue[],
	opts?: { startSec?: number; endSec?: number; maxChars?: number },
): string {
	const startSec = opts?.startSec;
	const endSec = opts?.endSec;
	const maxChars = opts?.maxChars ?? Math.min(12_000, MAX_MEDIA_TRANSCRIPT_CHARS);

	const filtered = cues.filter((cue) => {
		const cueEnd = cue.endSec ?? cue.startSec + 4;
		if (startSec !== undefined && cueEnd < startSec) return false;
		if (endSec !== undefined && cue.startSec > endSec) return false;
		return true;
	});

	if (filtered.length === 0) return "";

	const lines: string[] = [];
	let totalChars = 0;
	let truncated = false;
	for (const cue of filtered) {
		const line = `[${formatMediaTimestamp(cue.startSec)}] ${cue.text}`;
		if (totalChars + line.length + 1 > maxChars) {
			truncated = true;
			break;
		}
		lines.push(line);
		totalChars += line.length + 1;
	}
	if (truncated) {
		lines.push("[… subtitles truncated; pass tighter startSec/endSec to inspect a specific segment …]");
	}
	return lines.join("\n");
}

interface CaptionTrack {
	baseUrl?: string;
	languageCode?: string;
	kind?: string;
}

/** Extract captionTracks array from a YouTube watch page HTML string. */
export function extractYouTubeCaptionTracks(html: string): CaptionTrack[] {
	const marker = '"captionTracks":';
	const idx = html.indexOf(marker);
	if (idx < 0) return [];
	const arrayStart = html.indexOf("[", idx + marker.length);
	if (arrayStart < 0) return [];

	// Walk balanced brackets while respecting JSON strings/escapes.
	let depth = 0;
	let inString = false;
	let escaped = false;
	let arrayEnd = -1;
	for (let i = arrayStart; i < html.length && i < arrayStart + 100_000; i++) {
		const ch = html[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth === 0) {
				arrayEnd = i;
				break;
			}
		}
	}
	if (arrayEnd < 0) return [];

	try {
		const parsed = JSON.parse(html.slice(arrayStart, arrayEnd + 1)) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is CaptionTrack => Boolean(item && typeof item === "object" && typeof (item as CaptionTrack).baseUrl === "string"));
	} catch {
		return [];
	}
}

function chooseBestCaptionTrack(tracks: readonly CaptionTrack[]): CaptionTrack | null {
	if (!tracks.length) return null;
	const isEn = (t: CaptionTrack) => typeof t.languageCode === "string" && (t.languageCode === "en" || t.languageCode.startsWith("en-"));
	const isHuman = (t: CaptionTrack) => t.kind !== "asr";
	return (
		tracks.find((t) => isEn(t) && isHuman(t)) ??
		tracks.find((t) => isEn(t)) ??
		tracks.find((t) => isHuman(t)) ??
		tracks[0] ??
		null
	);
}

function withTimeoutSignal(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Subtitle fetch timed out")), ms);
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

const INNERTUBE_ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";

async function fetchCaptionTracksViaInnertube(videoId: string, signal: AbortSignal): Promise<CaptionTrack[]> {
	try {
		const res = await safeFetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": INNERTUBE_ANDROID_UA,
				"Accept-Language": "en-US,en;q=0.9",
			},
			body: JSON.stringify({
				context: {
					client: {
						clientName: "ANDROID",
						clientVersion: "20.10.38",
						hl: "en",
						gl: "US",
					},
				},
				videoId,
			}),
			signal,
		});
		if (!res.ok) return [];
		const data = (await res.json()) as {
			captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: unknown } };
		};
		const raw = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
		if (!Array.isArray(raw)) return [];
		return raw.filter((item): item is CaptionTrack => Boolean(item && typeof item === "object" && typeof (item as CaptionTrack).baseUrl === "string"));
	} catch {
		return [];
	}
}

async function fetchTrackBody(track: CaptionTrack, signal: AbortSignal): Promise<SubtitleCue[]> {
	if (!track.baseUrl) return [];
	let trackUrl: URL;
	try {
		trackUrl = new URL(track.baseUrl);
	} catch {
		return [];
	}
	if ((trackUrl.protocol !== "https:" && trackUrl.protocol !== "http:") || !ALLOWED_CAPTION_HOSTS.has(trackUrl.hostname.toLowerCase())) {
		return [];
	}
	const capRes = await safeFetch(trackUrl.toString(), {
		headers: { "Accept-Language": "en-US,en;q=0.9" },
		signal,
	});
	if (!capRes.ok) return [];
	const body = await capRes.text();
	if (!body.trim()) return [];
	return body.trimStart().startsWith("{")
		? parseYouTubeJson3(body)
		: parseYouTubeTimedTextXml(body);
}

/**
 * Fetch and parse timestamped subtitles for a YouTube video.
 * Prefers YouTube's Innertube player endpoint (whose timedtext URLs work reliably)
 * and falls back to watch-page captionTracks extraction.
 * Throws NoSubtitlesError if captions are unavailable or empty.
 */
export async function fetchYouTubeSubtitles(
	videoId: string,
	opts?: { startSec?: number; endSec?: number; signal?: AbortSignal },
): Promise<{ transcript: string; language: string; autoGenerated: boolean }> {
	const { signal, cleanup } = withTimeoutSignal(opts?.signal, YOUTUBE_FETCH_TIMEOUT_MS);
	try {
		let track: CaptionTrack | null = null;
		let cues: SubtitleCue[] = [];

		// 1. Primary path: Innertube ANDROID player endpoint (returns working srv3 timedtext URLs).
		const innertubeTracks = await fetchCaptionTracksViaInnertube(videoId, signal);
		const innertubeBest = chooseBestCaptionTrack(innertubeTracks);
		if (innertubeBest) {
			const parsed = await fetchTrackBody(innertubeBest, signal);
			if (parsed.length > 0) {
				track = innertubeBest;
				cues = parsed;
			}
		}

		// 2. Fallback path: watch page HTML captionTracks.
		if (cues.length === 0) {
			const watchRes = await safeFetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
				headers: {
					"Accept-Language": "en-US,en;q=0.9",
					"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
				},
				signal,
			});
			if (watchRes.ok) {
				const html = await watchRes.text();
				const watchBest = chooseBestCaptionTrack(extractYouTubeCaptionTracks(html));
				if (watchBest) {
					const parsed = await fetchTrackBody(watchBest, signal);
					if (parsed.length > 0) {
						track = watchBest;
						cues = parsed;
					}
				}
			}
		}

		if (!track || cues.length === 0) {
			throw new NoSubtitlesError(
				"This YouTube video has no accessible subtitles/captions. Only audio/video with available subtitles can be used in a lesson — search for another captioned video with search_youtube or teach without it.",
			);
		}

		const transcript = formatSubtitleCues(cues, { startSec: opts?.startSec, endSec: opts?.endSec });
		if (!transcript) {
			throw new NoSubtitlesError(
				"No subtitles were found in the requested startSec–endSec range. Adjust the timestamps or check the video's captions.",
			);
		}

		return {
			transcript,
			language: track.languageCode || "unknown",
			autoGenerated: track.kind === "asr",
		};
	} finally {
		cleanup();
	}
}

async function readBoundedSubtitleFile(absolute: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const stat = await fs.stat(absolute);
		if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SUBTITLE_FILE_BYTES) return null;
		return await fs.readFile(absolute, { encoding: "utf-8", signal });
	} catch {
		return null;
	}
}

/**
 * Look for an explicit subtitle file (validated through File access rules) or
 * a sibling .vtt/.srt file next to a local audio/video file.
 */
export async function loadLocalSubtitles(
	mediaAbsolutePath: string,
	opts?: { subtitlePath?: string; startSec?: number; endSec?: number; signal?: AbortSignal },
): Promise<{ transcript: string; subtitlePath: string } | null> {
	const candidates: string[] = [];
	if (opts?.subtitlePath) {
		candidates.push(resolveSourcePath(opts.subtitlePath));
	} else {
		const dir = path.dirname(mediaAbsolutePath);
		const ext = path.extname(mediaAbsolutePath);
		const stem = ext ? path.basename(mediaAbsolutePath, ext) : path.basename(mediaAbsolutePath);
		for (const suffix of [".vtt", ".srt", ".en.vtt", ".en.srt"]) {
			try {
				candidates.push(resolveSourcePath(path.join(/* turbopackIgnore: true */ dir, `${stem}${suffix}`)));
			} catch {
				// Skip any candidate rejected by file-access rules.
			}
		}
	}

	for (const candidate of candidates) {
		const raw = await readBoundedSubtitleFile(candidate, opts?.signal);
		if (!raw) continue;
		const cues = parseSubtitlesVttOrSrt(raw);
		if (cues.length === 0) continue;
		const transcript = formatSubtitleCues(cues, { startSec: opts?.startSec, endSec: opts?.endSec });
		if (transcript) {
			return { transcript, subtitlePath: candidate };
		}
	}
	return null;
}
