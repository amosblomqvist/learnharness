import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import type { ImageContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { MAX_DRAWINGS, type IngestedDrawings } from "../src/core/drawings.ts";
import { ChatInputError, inputAppends, parseChatInput, parseDrawingUploads, parseUserSteerInput } from "../src/core/input-events.ts";
import {
	newAnswerResult,
	newThinkingMessage,
	newUserMessage,
	newUserSteer,
	toLlmMessages,
	userMessageText,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { buildAnswer, compactAnswerForModel, normalizeOptions, type QuestionData } from "../src/core/question-core.ts";
import { serializeForSummary } from "../src/core/compaction.ts";
import { messageMarkdown } from "../src/core/session-markdown.ts";
import { projectView } from "../src/core/view.ts";
import { ingestDrawings, saveDrawingSnapshots } from "../src/server/drawings.ts";
import { chatStore } from "../src/store/chats.ts";

/**
 * THE LEARNER'S DRAWINGS (2026-11-04): pad exports ride text, thinking,
 * answer, and steer inputs; the model reads native image blocks beside
 * the text, the UI reads snapshot refs.
 */

function png(width = 60, height = 40): Buffer {
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, width, height);
	ctx.strokeStyle = "#000000";
	ctx.beginPath();
	ctx.moveTo(4, 4);
	ctx.lineTo(width - 4, height - 4);
	ctx.stroke();
	return canvas.toBuffer("image/png");
}

const b64 = (bytes: Buffer) => bytes.toString("base64");

const image = (data = "AAAA"): ImageContent => ({ type: "image", data, mimeType: "image/png" });
const ingested = (n = 1): IngestedDrawings => ({
	refs: Array.from({ length: n }, (_, i) => ({ snapshotId: `${i}`.padStart(64, "a"), width: 60, height: 40 })),
	images: Array.from({ length: n }, (_, i) => image(`IMG${i}`)),
});

function quizData(): QuestionData {
	return {
		id: "q1",
		kind: "quiz",
		question: "Closest planet?",
		mode: "single-select",
		options: normalizeOptions([{ label: "Mercury" }, { label: "Venus" }]),
		correctIndices: [1],
		createdAt: "synthetic",
	};
}

describe("drawing uploads (input parsing)", () => {
	it("accepts drawings on text/thinking/answer/steer, and a drawing alone is a whole message", () => {
		const drawings = [{ data: "iVBORw0KGgo=" }];
		assert.deepEqual(parseChatInput({ type: "text", text: "", drawings }), { type: "text", text: "", drawings });
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p1", text: " ", drawings }), { type: "thinking", problemCallId: "p1", text: " ", drawings });
		const answer = parseChatInput({ type: "answer", toolCallId: "q1", answer: { kind: "quiz" }, drawings });
		assert.equal(answer.type === "answer" && answer.drawings?.length, 1);
		assert.deepEqual(parseUserSteerInput({ type: "steer", id: "s1", text: "", drawings }), { type: "steer", id: "s1", text: "", drawings });
	});

	it("still refuses empty text without a drawing", () => {
		assert.throws(() => parseChatInput({ type: "text", text: "  " }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "text", text: "", drawings: [] }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p1", text: "" }), ChatInputError);
		assert.throws(() => parseUserSteerInput({ type: "steer", id: "s1", text: "" }), ChatInputError);
	});

	it(`caps a submission at ${MAX_DRAWINGS} and refuses non-base64 data`, () => {
		assert.throws(() => parseDrawingUploads(Array.from({ length: MAX_DRAWINGS + 1 }, () => ({ data: "AAAA" }))), /at most 4/);
		assert.throws(() => parseDrawingUploads([{ data: "not base64!" }]), ChatInputError);
		assert.throws(() => parseDrawingUploads([{ data: "" }]), ChatInputError);
		assert.throws(() => parseDrawingUploads("AAAA"), ChatInputError);
		assert.equal(parseDrawingUploads(undefined), undefined);
		assert.equal(parseDrawingUploads([]), undefined);
	});
});

describe("drawing-bearing messages (two audiences)", () => {
	it("a user message carries [text, ...images] for the model and refs for the UI", () => {
		const m = newUserMessage("my working", ingested(2));
		assert.deepEqual(m.content, [{ type: "text", text: "my working" }, image("IMG0"), image("IMG1")]);
		assert.equal(m.drawings?.length, 2);
		assert.equal(userMessageText(m.content), "my working");
		// No drawings → the plain string content, unchanged.
		assert.equal(newUserMessage("plain").content, "plain");
		assert.equal(newUserMessage("plain").drawings, undefined);
	});

	it("a drawing-only message has no empty text block", () => {
		const m = newUserMessage("  ", ingested(1));
		assert.deepEqual(m.content, [image("IMG0")]);
		const steer = newUserSteer("", "steer_1", ingested(1));
		assert.equal(steer.id, "steer_1");
		assert.deepEqual(steer.content, [image("IMG0")]);
	});

	it("toLlmMessages strips the app-only refs but keeps the images", () => {
		const [wire] = toLlmMessages([newUserMessage("x", ingested(1))]) as UserMessage[];
		assert.ok(!("drawings" in wire!), "refs never reach the provider");
		assert.ok(!("id" in wire!));
		assert.deepEqual(wire!.content, [{ type: "text", text: "x" }, image("IMG0")]);
	});

	it("an answer's images FOLLOW its compact record, which counts them", () => {
		const answer = buildAnswer(quizData(), { values: ["Venus"], confidence: 70, thinking: "see drawing" });
		const result = newAnswerResult("q1", "quiz", answer, ingested(2));
		assert.equal(result.content.length, 3);
		const compact = JSON.parse((result.content[0] as { text: string }).text);
		assert.equal(compact.drawings, 2);
		assert.equal(compact.confidence, 70);
		assert.deepEqual(result.content.slice(1), [image("IMG0"), image("IMG1")]);
		assert.equal((result.details as { drawings?: unknown[] }).drawings?.length, 2, "details keeps the refs for the card");
		// Without drawings the record is unchanged.
		const plain = newAnswerResult("q1", "quiz", answer);
		assert.equal(plain.content.length, 1);
		assert.equal(JSON.parse((plain.content[0] as { text: string }).text).drawings, undefined);
	});

	it("compactAnswerForModel never counts an empty drawing list", () => {
		const answer = { ...buildAnswer(quizData(), { values: ["Venus"], confidence: 70 }), drawings: [] };
		assert.equal(compactAnswerForModel(answer).drawings, undefined);
	});

	it("a practice thinking marker carries model images and UI refs", () => {
		const marker = newThinkingMessage("p1", "attempt", ingested(1));
		assert.deepEqual(marker.images, [image("IMG0")]);
		assert.equal((marker.details as { drawings?: unknown[] }).drawings?.length, 1);
		const [wire] = toLlmMessages([marker as unknown as LhMessage]) as UserMessage[];
		assert.deepEqual(wire!.content, [{ type: "text", text: marker.content }, image("IMG0")]);
		const bare = newThinkingMessage("p1", "attempt");
		assert.equal(bare.images, undefined);
		assert.deepEqual(bare.details, { problemCallId: "p1", text: "attempt" });
	});

	it("inputAppends threads ingested drawings into each constructor", () => {
		const [m] = inputAppends({ messages: [] }, { type: "text", text: "t" }, ingested(1));
		assert.equal((m as LhMessage).drawings?.length, 1);
	});
});

describe("drawings in derived text (summary, export, view)", () => {
	it("the compaction summarizer reads text plus a count — never image bytes", () => {
		const user = newUserMessage("my steps", ingested(2));
		const thinking = newThinkingMessage("p1", "attempt", ingested(1)) as unknown as LhMessage;
		const result = newAnswerResult("q1", "quiz", buildAnswer(quizData(), { values: ["Venus"], confidence: 30 }), ingested(1)) as LhMessage & ToolResultMessage;
		const text = serializeForSummary([user, thinking, result]);
		assert.match(text, /\[LEARNER\] my steps \(attached 2 drawings\)/);
		assert.match(text, /\(attached 1 drawing\)/);
		assert.match(text, /\(image\)/);
		assert.ok(!text.includes("IMG0"), "no base64 in the summary input");
	});

	it("the markdown export names attached drawings", () => {
		const md = messageMarkdown(newUserMessage("steps", ingested(2)), "m1", false);
		assert.match(md ?? "", /steps\n\n_\(2 drawings attached\)_/);
		const alone = messageMarkdown(newUserMessage("", ingested(1)), "m2", false);
		assert.match(alone ?? "", /### Learner\n\n_\(drawing attached\)_/);
	});

	it("the view projects the typed text and a drawings part for the UI", () => {
		const view = projectView([newUserMessage("steps", ingested(1))]);
		const parts = view[0]!.parts;
		assert.equal(parts[0]!.type, "text");
		const drawingsPart = parts.find((p) => p.type === "data-drawings") as { data?: { drawings: unknown[] } } | undefined;
		assert.equal(drawingsPart?.data?.drawings.length, 1);
	});
});

describe("drawing ingestion (server)", () => {
	const chats: string[] = [];
	after(() => { for (const id of chats) chatStore.deleteChat(id); });

	it("normalizes a PNG into a ref, a model image, and a snapshot to store", async () => {
		const ingest = await ingestDrawings([{ data: b64(png(60, 40)) }]);
		assert.equal(ingest.refs.length, 1);
		assert.match(ingest.refs[0]!.snapshotId, /^[a-f0-9]{64}$/);
		assert.deepEqual([ingest.refs[0]!.width, ingest.refs[0]!.height], [60, 40]);
		assert.equal(ingest.images[0]!.type, "image");
		assert.equal(ingest.snapshots[0]!.snapshotId, ingest.refs[0]!.snapshotId);

		const chat = chatStore.createChat("Synthetic drawing ingest");
		chats.push(chat.id);
		saveDrawingSnapshots(chatStore, chat.id, ingest);
		const stored = chatStore.getChat(chat.id)?.imageSnapshots?.[ingest.refs[0]!.snapshotId];
		assert.equal(stored?.width, 60);
	});

	it("refuses anything that is not a PNG with an honest input error", async () => {
		await assert.rejects(ingestDrawings([{ data: b64(Buffer.from("not an image at all")) }]), ChatInputError);
	});
});
