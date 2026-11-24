import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { safeFetch } from "./safe-fetch.ts";

/**
 * search_youtube: keyless YouTube search routed through SSRF-guarded safeFetch.
 *
 * Uses YouTube's built-in Subtitles/CC search filter (`sp=EgIoAQ%3D%3D`) first
 * so returned videos are biased toward captioned educational content ready for
 * `show_media`. Requires no external search API key.
 */

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const SEARCH_TIMEOUT_MS = 12_000;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface YouTubeSearchHit {
	videoId: string;
	url: string;
	title: string;
	channel: string;
	duration?: string;
	views?: string;
	hasCaptionsBadge: boolean;
}

const searchYouTubeInput = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "YouTube search query (e.g. '3Blue1Brown Fourier transform visual explanation').",
	}),
	count: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 8,
			description: "Maximum number of video results to return (default 5, max 8).",
		}),
	),
});

function readRunsText(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	const obj = node as { simpleText?: unknown; runs?: Array<{ text?: unknown }> };
	if (typeof obj.simpleText === "string") return obj.simpleText.trim();
	if (Array.isArray(obj.runs)) {
		return obj.runs
			.map((r) => (typeof r?.text === "string" ? r.text : ""))
			.join("")
			.trim();
	}
	return "";
}

/** Extract the ytInitialData JSON blob from a YouTube search results HTML page. */
function extractYtInitialData(html: string): unknown | null {
	const markers = ["var ytInitialData = ", 'window["ytInitialData"] = ', "ytInitialData = "];
	let start = -1;
	for (const marker of markers) {
		const idx = html.indexOf(marker);
		if (idx >= 0) {
			start = html.indexOf("{", idx + marker.length);
			if (start >= 0) break;
		}
	}
	if (start < 0) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;
	for (let i = start; i < html.length && i < start + 2_500_000; i++) {
		const ch = html[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end < 0) return null;

	try {
		return JSON.parse(html.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** Parse video hits from a YouTube search results HTML page. Pure & deterministic. */
export function parseYouTubeSearchResults(html: string, maxResults = 5): YouTubeSearchHit[] {
	const data = extractYtInitialData(html);
	if (!data) return [];

	const hits: YouTubeSearchHit[] = [];
	const seen = new Set<string>();
	const stack: unknown[] = [data];

	while (stack.length > 0 && hits.length < maxResults) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
			continue;
		}
		const obj = current as Record<string, unknown>;
		if (obj.videoRenderer && typeof obj.videoRenderer === "object") {
			const v = obj.videoRenderer as Record<string, unknown>;
			const videoId = typeof v.videoId === "string" ? v.videoId : "";
			if (YOUTUBE_ID_RE.test(videoId) && !seen.has(videoId)) {
				const title = readRunsText(v.title);
				const channel = readRunsText(v.ownerText) || readRunsText(v.longBylineText) || readRunsText(v.shortBylineText);
				const duration = readRunsText(v.lengthText) || undefined;
				const views = readRunsText(v.shortViewCountText) || undefined;
				const badges = Array.isArray(v.badges) ? v.badges : [];
				const hasCaptionsBadge = badges.some((b) => {
					const label = (b as { metadataBadgeRenderer?: { label?: unknown } })?.metadataBadgeRenderer?.label;
					return typeof label === "string" && /\b(cc|subtitles|captions)\b/i.test(label);
				});
				if (title) {
					seen.add(videoId);
					hits.push({
						videoId,
						url: `https://www.youtube.com/watch?v=${videoId}`,
						title,
						channel: channel || "Unknown channel",
						...(duration ? { duration } : {}),
						...(views ? { views } : {}),
						hasCaptionsBadge,
					});
				}
			}
			continue;
		}
		const values = Object.values(obj);
		for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
	}

	return hits;
}

async function runYouTubeQuery(query: string, count: number, captionsFilter: boolean, signal?: AbortSignal): Promise<YouTubeSearchHit[]> {
	const params = new URLSearchParams({ search_query: query });
	if (captionsFilter) params.set("sp", "EgIoAQ=="); // YouTube's built-in Subtitles/CC filter
	const url = `https://www.youtube.com/results?${params.toString()}`;
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const res = await safeFetch(url, {
		headers: {
			"User-Agent": USER_AGENT,
			"Accept-Language": "en-US,en;q=0.9",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		},
		signal: combined,
	});
	if (!res.ok) throw new Error(`YouTube search returned HTTP ${res.status}`);
	const html = await res.text();
	return parseYouTubeSearchResults(html, count);
}

export async function searchYouTubeVideos(
	query: string,
	count = 5,
	signal?: AbortSignal,
): Promise<YouTubeSearchHit[]> {
	const clamped = Math.max(1, Math.min(8, Math.floor(count)));
	const captioned = await runYouTubeQuery(query, clamped, true, signal);
	if (captioned.length > 0) return captioned;
	return runYouTubeQuery(query, clamped, false, signal);
}

export const searchYouTubeTool: AgentTool<typeof searchYouTubeInput> = {
	name: "search_youtube",
	label: "search_youtube",
	description:
		"Search YouTube directly for videos with subtitles/captions (no search API key required). " +
		"Returns verified video titles, channels, durations, and URLs. " +
		"Follow up with `show_media` on your chosen URL to verify/extract its timestamped subtitles and embed it in the lesson.",
	parameters: searchYouTubeInput,
	execute: serverExecute("search_youtube", searchYouTubeInput, async ({ query, count }, { signal }) => {
		const trimmed = query.trim();
		if (!trimmed) throw new Error("Provide a non-empty YouTube search query.");
		const hits = await searchYouTubeVideos(trimmed, count ?? 5, signal);
		if (hits.length === 0) {
			return `No YouTube videos found for "${trimmed}". Try broader or alternative search terms.`;
		}
		const lines = hits.map((hit, i) => {
			const meta = [hit.channel, hit.duration, hit.views, hit.hasCaptionsBadge ? "CC" : undefined].filter(Boolean).join(" · ");
			return `${i + 1}. ${hit.title} (${meta})\n   ${hit.url}`;
		});
		return `YouTube results for "${trimmed}":\n${lines.join("\n")}\n\nCall show_media with one of these URLs to fetch its timestamped subtitles and embed it.`;
	}),
};
