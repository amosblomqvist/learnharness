import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import {
	formatMediaForModel,
	formatMediaTimestamp,
	inputAppends,
	isShowMediaDetails,
	newUserMessage,
	normalizeMediaMimeType,
	parseChatInput,
	parseUserSteerInput,
	parseYouTubeVideoId,
	projectView,
	toLlmMessages,
	validateMediaAttachmentArray,
	type MediaAttachment,
} from "../src/core/index.ts";
import { mediaStore } from "../src/store/media.ts";
import { buildMediaFileResponse, parseByteRange, sniffMediaMime } from "../src/server/media.ts";
import { createShowMediaTool } from "../src/agent/tools/show-media.ts";
import { parseYouTubeSearchResults, searchYouTubeTool } from "../src/agent/tools/search-youtube.ts";
import {
	extractYouTubeCaptionTracks,
	formatSubtitleCues,
	parseSubtitlesVttOrSrt,
	parseYouTubeTimedTextXml,
} from "../src/agent/tools/media-subtitles.ts";
import { safeFetchOverride } from "../src/agent/tools/safe-fetch.ts";
import { setFileAccessPolicy } from "../src/agent/tools/file-access.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { artifactRenderers } from "../components/artifacts/index.ts";
import {
	buildSessionMediaUrl,
	buildYouTubeEmbedUrl,
	MediaCard,
	SessionMediaPlayer,
	SubmittedMedia,
	YouTubeMediaCard,
} from "../components/artifacts/media-card.tsx";
import { ComposerMediaTray } from "../components/composer-media-tray.tsx";
import { ChatActionsContext } from "../components/chat.tsx";

const createdChats: string[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	while (createdChats.length) {
		mediaStore.deleteMediaForChat(createdChats.pop()!);
	}
	while (tempDirs.length) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
	setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
	safeFetchOverride.current = undefined;
});

describe("media contracts & YouTube parsing", () => {
	it("parses watch, youtu.be, shorts, and embed URLs with timestamps", () => {
		assert.deepEqual(parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s"), {
			videoId: "dQw4w9WgXcQ",
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			startSec: 90,
		});
		assert.deepEqual(parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=45"), {
			videoId: "dQw4w9WgXcQ",
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			startSec: 45,
		});
		assert.deepEqual(parseYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), {
			videoId: "dQw4w9WgXcQ",
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		});
		assert.equal(parseYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), null);
		assert.equal(parseYouTubeVideoId("javascript:alert(1)"), null);
	});

	it("normalizes MIME aliases and formats timestamps", () => {
		assert.equal(normalizeMediaMimeType("audio/mp3; charset=binary"), "audio/mpeg");
		assert.equal(normalizeMediaMimeType("audio/x-wav"), "audio/wav");
		assert.equal(normalizeMediaMimeType("video/mp4"), "video/mp4");
		assert.equal(normalizeMediaMimeType("application/x-executable"), null);
		assert.equal(formatMediaTimestamp(0), "0:00");
		assert.equal(formatMediaTimestamp(95), "1:35");
		assert.equal(formatMediaTimestamp(3661), "1:01:01");
	});

	it("validates attachments and formats model-facing context with transcripts", () => {
		const id = "a".repeat(64);
		const list = validateMediaAttachmentArray([
			{
				id,
				kind: "audio",
				mimeType: "audio/mpeg",
				filename: "lecture.mp3",
				sizeBytes: 12345,
				durationSec: 65,
				transcript: "Eigenvalues scale eigenvectors without changing their direction.",
			},
		]);
		assert.equal(list.length, 1);
		const formatted = formatMediaForModel(list);
		assert.match(formatted, /\[Attached audio: lecture\.mp3 \(audio\/mpeg, 1:05; mediaId: a{64}\)\]/);
		assert.match(formatted, /Transcript:\nEigenvalues scale eigenvectors/);
	});
});

describe("subtitle parsing (VTT, SRT, YouTube XML)", () => {
	it("parses WebVTT and SRT cues and slices to startSec–endSec", () => {
		const vtt = [
			"WEBVTT",
			"",
			"00:00:05.000 --> 00:00:10.000",
			"First <i>intro</i> line.",
			"",
			"00:00:30.000 --> 00:00:40.000",
			"Key Fourier transform insight.",
			"",
			"00:01:30.000 --> 00:01:40.000",
			"Later summary.",
		].join("\n");
		const cues = parseSubtitlesVttOrSrt(vtt);
		assert.equal(cues.length, 3);
		assert.equal(cues[0]!.text, "First intro line.");

		const sliced = formatSubtitleCues(cues, { startSec: 25, endSec: 50 });
		assert.equal(sliced, "[0:30] Key Fourier transform insight.");

		const srt = "1\n00:00:02,000 --> 00:00:05,000\nStress falls on the &amp; second syllable.\n";
		const srtCues = parseSubtitlesVttOrSrt(srt);
		assert.equal(srtCues.length, 1);
		assert.equal(srtCues[0]!.text, "Stress falls on the & second syllable.");
	});

	it("parses YouTube XML captions and extracts captionTracks from watch HTML", () => {
		const xml = `<transcript><text start="12.5" dur="4.2">Vectors don&amp;#39;t change direction</text></transcript>`;
		const cues = parseYouTubeTimedTextXml(xml);
		assert.equal(cues.length, 1);
		assert.equal(cues[0]!.text, "Vectors don't change direction");

		const html = `var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc12345678","languageCode":"en"}]}}};`;
		const tracks = extractYouTubeCaptionTracks(html);
		assert.equal(tracks.length, 1);
		assert.equal(tracks[0]!.languageCode, "en");
	});
});

describe("MediaStore & HTTP Range streaming", () => {
	it("deduplicates content by SHA-256, persists transcripts, serves Range 206, and cleans up on delete", async () => {
		const chatId = `test_media_${Date.now().toString(36)}`;
		createdChats.push(chatId);
		const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5, 6]);
		assert.equal(sniffMediaMime(bytes), "audio/mpeg");

		const first = mediaStore.saveMedia(chatId, bytes, { kind: "audio", mimeType: "audio/mpeg", filename: "clip.mp3" });
		const second = mediaStore.saveMedia(chatId, bytes, { kind: "audio", mimeType: "audio/mpeg", filename: "clip2.mp3" });
		assert.equal(first.id, second.id);
		assert.equal(first.id, createHash("sha256").update(bytes).digest("hex"));
		assert.ok(mediaStore.getMediaFilePath(chatId, first.id));

		mediaStore.updateMediaTranscript(chatId, first.id, "[0:00] Sample transcript");
		assert.equal(mediaStore.getMediaMeta(chatId, first.id)?.transcript, "[0:00] Sample transcript");

		const fullRes = buildMediaFileResponse(new Request("http://localhost/api/chats/x/media/y"), chatId, first.id);
		assert.equal(fullRes.status, 200);
		assert.equal(fullRes.headers.get("accept-ranges"), "bytes");
		assert.equal(fullRes.headers.get("content-type"), "audio/mpeg");
		assert.equal((await fullRes.arrayBuffer()).byteLength, bytes.byteLength);

		assert.deepEqual(parseByteRange("bytes=0-3", 16), { start: 0, end: 3 });
		assert.deepEqual(parseByteRange("bytes=10-", 16), { start: 10, end: 15 });
		assert.equal(parseByteRange("bytes=20-25", 16), null);

		const rangeRes = buildMediaFileResponse(
			new Request("http://localhost/api/chats/x/media/y", { headers: { Range: "bytes=2-5" } }),
			chatId,
			first.id,
		);
		assert.equal(rangeRes.status, 206);
		assert.equal(rangeRes.headers.get("content-range"), "bytes 2-5/16");
		assert.equal((await rangeRes.arrayBuffer()).byteLength, 4);

		const badRange = buildMediaFileResponse(
			new Request("http://localhost/api/chats/x/media/y", { headers: { Range: "bytes=99-100" } }),
			chatId,
			first.id,
		);
		assert.equal(badRange.status, 416);

		assert.equal(mediaStore.deleteMediaForChat(chatId), 1);
		assert.equal(mediaStore.getMediaMeta(chatId, first.id), null);
	});
});

describe("core input-events, native-messages, and view projection for media", () => {
	it("accepts media-only text/steer inputs, strips lhMedia on wire, and projects media parts to UI", () => {
		const attachment: MediaAttachment = {
			id: "b".repeat(64),
			kind: "video",
			mimeType: "video/mp4",
			filename: "experiment.mp4",
			sizeBytes: 5000,
			durationSec: 12,
			width: 1280,
			height: 720,
			transcript: "Watch the pendulum swing.",
			keyframeCount: 2,
		};

		const parsedText = parseChatInput({ type: "text", text: "", media: [attachment] });
		assert.equal(parsedText.type, "text");
		assert.equal(parsedText.media?.length, 1);

		const parsedSteer = parseUserSteerInput({ type: "steer", id: "steer_1", text: "", media: [attachment] });
		assert.equal(parsedSteer.media?.length, 1);

		const appends = inputAppends({ messages: [] }, parsedText);
		assert.equal(appends.length, 1);
		assert.equal(appends[0]!.lhMedia?.[0]?.id, attachment.id);

		const wire = toLlmMessages([newUserMessage("Check this clip", undefined, [attachment])]);
		assert.equal(wire.length, 1);
		assert.equal("lhMedia" in wire[0]!, false);
		assert.match(String(wire[0]!.content), /Check this clip/);
		assert.match(String(wire[0]!.content), /Attached video: experiment\.mp4/);
		assert.match(String(wire[0]!.content), /Watch the pendulum swing\./);

		const view = projectView(appends);
		assert.equal(view.length, 1);
		assert.ok(view[0]!.parts.some((p) => p.type === "media" && (p.media as MediaAttachment).id === attachment.id));
	});
});

describe("show_media teacher tool (mandatory subtitles enforcement)", () => {
	it("allows captioned YouTube videos, returns subtitles to agent, and rejects uncaptioned YouTube videos", async () => {
		const chatId = `test_show_media_yt_${Date.now().toString(36)}`;
		createdChats.push(chatId);
		const tool = createShowMediaTool({ chatId, mediaStore });

		safeFetchOverride.current = async (url) => {
			if (url.includes("watch?v=dQw4w9WgXcQ")) {
				return new Response(
					`<html><script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en","languageCode":"en"}]}}};</script></html>`,
					{ status: 200 },
				);
			}
			if (url.includes("api/timedtext?v=dQw4w9WgXcQ")) {
				return new Response(
					`<transcript><text start="10" dur="5">Intro</text><text start="35" dur="8">Main lesson point</text><text start="120" dur="4">Outro</text></transcript>`,
					{ status: 200 },
				);
			}
			// Uncaptioned video
			return new Response(`<html><script>var ytInitialPlayerResponse = {};</script></html>`, { status: 200 });
		};

		const ytRes = await tool.execute("call-1", {
			youtubeUrl: "https://youtu.be/dQw4w9WgXcQ?t=30",
			endSec: 90,
			caption: "Key visual intuition",
		});
		assert.equal(isShowMediaDetails(ytRes.details), true);
		assert.deepEqual(ytRes.details, {
			source: "youtube",
			videoId: "dQw4w9WgXcQ",
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			caption: "Key visual intuition",
			startSec: 30,
			endSec: 90,
			transcript: "[0:35] Main lesson point",
			subtitleLanguage: "en",
		});
		const textBlock = ytRes.content.find((c) => c.type === "text");
		assert.ok(textBlock && textBlock.type === "text");
		assert.match(textBlock.text, /\[0:35\] Main lesson point/);

		// Uncaptioned YouTube video is refused!
		await assert.rejects(
			() => tool.execute("call-nocap", { youtubeUrl: "https://youtu.be/aaaaaaaaaaa" }),
			/no accessible subtitles\/captions/i,
		);
	});

	it("requires sibling/explicit subtitles or STT for local files and session mediaId clips", async () => {
		const chatId = `test_show_media_local_${Date.now().toString(36)}`;
		createdChats.push(chatId);
		const tool = createShowMediaTool({ chatId, mediaStore });

		const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "lh-media-ok-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lh-media-out-"));
		tempDirs.push(allowed, outside);
		const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb]);
		const noSubPath = path.join(allowed, "nosubs.mp3");
		const withSubPath = path.join(allowed, "pronunciation.mp3");
		const vttPath = path.join(allowed, "pronunciation.vtt");
		const outsidePath = path.join(outside, "secret.mp3");
		fs.writeFileSync(noSubPath, mp3Bytes);
		fs.writeFileSync(withSubPath, mp3Bytes);
		fs.writeFileSync(vttPath, "WEBVTT\n\n00:00:02.000 --> 00:00:06.000\nNotice the rising tone.\n");
		fs.writeFileSync(outsidePath, mp3Bytes);

		setFileAccessPolicy(() => ({ restricted: true, folders: [allowed] }));
		// Outside allowed folder is rejected
		await assert.rejects(() => tool.execute("call-out", { path: outsidePath }));
		// Missing subtitles (and no STT transcriber) is rejected!
		await assert.rejects(() => tool.execute("call-nosub", { path: noSubPath }), /No subtitles or transcript available/i);

		// With sibling .vtt file -> succeeds and returns timestamped transcript
		const localRes = await tool.execute("call-2", {
			path: withSubPath,
			startSec: 2,
			endSec: 8,
			caption: "Listen to the stress",
		});
		assert.equal(isShowMediaDetails(localRes.details), true);
		const details = localRes.details as Extract<ReturnType<typeof isShowMediaDetails> extends true ? never : any, any>;
		assert.equal(details.source, "local");
		assert.equal(details.kind, "audio");
		assert.equal(details.transcript, "[0:02] Notice the rising tone.");

		// Replaying session mediaId succeeds because transcript was cached in MediaStore
		const replayRes = await tool.execute("call-3", { mediaId: details.mediaId, startSec: 4 });
		assert.equal((replayRes.details as { transcript?: string }).transcript, "[0:02] Notice the rising tone.");

		// Session mediaId without transcript is rejected when no transcriber is present
		const rawEntry = mediaStore.saveMedia(chatId, new Uint8Array([0x49, 0x44, 0x33, 0x03, 1, 2, 3, 4]), {
			kind: "audio",
			mimeType: "audio/mpeg",
			filename: "untranscribed.mp3",
		});
		await assert.rejects(() => tool.execute("call-untranscribed", { mediaId: rawEntry.id }), /no subtitles or transcript available/i);

		// With injected STT transcriber fallback -> succeeds and caches transcript!
		const toolWithStt = createShowMediaTool({
			chatId,
			mediaStore,
			transcribeMedia: async () => "Transcribed via STT.",
		});
		const sttRes = await toolWithStt.execute("call-stt", { mediaId: rawEntry.id });
		assert.equal((sttRes.details as { transcript?: string }).transcript, "Transcribed via STT.");
		assert.equal(mediaStore.getMediaMeta(chatId, rawEntry.id)?.transcript, "Transcribed via STT.");

		// Rejects invalid source combinations / bad timestamp ranges
		await assert.rejects(() => tool.execute("call-4", {}));
		await assert.rejects(() => tool.execute("call-5", { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", startSec: 50, endSec: 20 }));
	});
});

describe("search_youtube keyless tool", () => {
	it("parses ytInitialData videoRenderer hits and returns verified YouTube URLs", async () => {
		const fakeHtml = `<html><script>var ytInitialData = {"contents":{"twoColumnSearchResultsRenderer":{"primaryContents":{"sectionListRenderer":{"contents":[{"itemSectionRenderer":{"contents":[{"videoRenderer":{"videoId":"spUNpyF58BY","title":{"runs":[{"text":"But what is the Fourier Transform? A visual introduction."}]},"ownerText":{"runs":[{"text":"3Blue1Brown"}]},"lengthText":{"simpleText":"20:57"},"shortViewCountText":{"simpleText":"18M views"},"badges":[{"metadataBadgeRenderer":{"label":"CC"}}]}}]}}]}}}}};</script></html>`;

		const parsed = parseYouTubeSearchResults(fakeHtml, 5);
		assert.equal(parsed.length, 1);
		assert.deepEqual(parsed[0], {
			videoId: "spUNpyF58BY",
			url: "https://www.youtube.com/watch?v=spUNpyF58BY",
			title: "But what is the Fourier Transform? A visual introduction.",
			channel: "3Blue1Brown",
			duration: "20:57",
			views: "18M views",
			hasCaptionsBadge: true,
		});

		let requestedUrl = "";
		safeFetchOverride.current = async (url) => {
			requestedUrl = url;
			return new Response(fakeHtml, { status: 200 });
		};

		const res = await searchYouTubeTool.execute("yt-search-1", { query: "Fourier transform visual" });
		assert.match(requestedUrl, /youtube\.com\/results\?search_query=Fourier\+transform\+visual&sp=EgIoAQ/);
		const textBlock = res.content.find((c) => c.type === "text");
		assert.ok(textBlock && textBlock.type === "text");
		assert.match(textBlock.text, /3Blue1Brown/);
		assert.match(textBlock.text, /https:\/\/www\.youtube\.com\/watch\?v=spUNpyF58BY/);
	});
});

describe("system prompt composition for multimedia", () => {
	it("composes teacher/56-media.md and shared/30-learner-files.md with mandatory subtitles doctrine", () => {
		const teacherPrompt = composeInstructions("teacher");
		assert.match(teacherPrompt, /Subtitles are mandatory/);
		assert.match(teacherPrompt, /show_media/);
		assert.match(teacherPrompt, /Learner files and attached media/);
	});
});

describe("MediaCard, SubmittedMedia, and ComposerMediaTray UI", () => {
	it("registers show_media in artifactRenderers and renders YouTube with subtitles, audio, video, and tray cleanly in SSR", () => {
		assert.equal(artifactRenderers.show_media, MediaCard);
		assert.equal(
			buildYouTubeEmbedUrl("dQw4w9WgXcQ", 15, 45),
			"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&start=15&end=45",
		);
		assert.equal(buildSessionMediaUrl("chat_1", "a".repeat(64), 10, 20), `/api/chats/chat_1/media/${"a".repeat(64)}#t=10,20`);

		const ytHtml = renderToStaticMarkup(
			<YouTubeMediaCard
				details={{
					source: "youtube",
					videoId: "dQw4w9WgXcQ",
					url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
					caption: "Intro clip",
					startSec: 15,
					endSec: 45,
					transcript: "[0:15] Welcome to the lesson",
				}}
			/>,
		);
		assert.match(ytHtml, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
		assert.match(ytHtml, /Intro clip/);
		assert.match(ytHtml, /0:15 – 0:45/);
		assert.match(ytHtml, /Subtitles/);

		const playerHtml = renderToStaticMarkup(
			<ChatActionsContext.Provider value={{ chatId: "chat_1", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {} }}>
				<MediaCard
					part={{
						type: "tool-show_media",
						state: "output-available",
						toolCallId: "c1",
						output: {
							source: "local",
							mediaId: "c".repeat(64),
							kind: "audio",
							mimeType: "audio/mpeg",
							filename: "notes.mp3",
							caption: "Voice note",
							startSec: 5,
							transcript: "[0:05] Hello learner",
						},
					}}
				/>
			</ChatActionsContext.Provider>,
		);
		assert.match(playerHtml, /media-player-audio/);
		assert.match(playerHtml, /Voice note/);
		assert.match(playerHtml, /from 0:05/);
		assert.match(playerHtml, /Transcript/);

		const submittedHtml = renderToStaticMarkup(
			<SubmittedMedia
				chatId="chat_1"
				items={[
					{
						id: "d".repeat(64),
						kind: "video",
						mimeType: "video/mp4",
						filename: "demo.mp4",
						sizeBytes: 2048,
						durationSec: 18,
						transcript: "Hello world",
					},
				]}
			/>,
		);
		assert.match(submittedHtml, /submitted-media/);
		assert.match(submittedHtml, /media-player-video/);
		assert.match(submittedHtml, /Transcript/);

		const trayHtml = renderToStaticMarkup(
			<ComposerMediaTray
				items={[
					{
						localId: "m1",
						kind: "audio",
						filename: "memo.mp3",
						mimeType: "audio/mpeg",
						sizeBytes: 1024,
						status: "ready",
						attachment: {
							id: "e".repeat(64),
							kind: "audio",
							mimeType: "audio/mpeg",
							filename: "memo.mp3",
							sizeBytes: 1024,
							durationSec: 42,
						},
					},
				]}
				onRemove={() => {}}
			/>,
		);
		assert.match(trayHtml, /composer-media-tray/);
		assert.match(trayHtml, /memo\.mp3/);
		assert.match(trayHtml, /0:42/);

		assert.ok(SessionMediaPlayer);
	});
});
