import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatInputError, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES, parseChatInput } from "../src/core/input-events.ts";
import { newAttachmentUserMessage, toLlmMessages } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import { estimateMessageTokens } from "../src/core/compaction.ts";
import { handleChatInput, handleChatRequest } from "../src/server/chat-handler.ts";
import { chatStore } from "../src/store/chats.ts";
import { prepareChatAttachments } from "../src/server/chat-attachments.ts";
import { piModels } from "../src/agent/models.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const image = { name: "diagram.png", mimeType: "image/png" as const, data: encode(png) };

function textPdf(text: string): Uint8Array {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (let i = 0; i < objects.length; i++) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}

describe("chat attachments", () => {
	it("exports shared limits and strips client supplied fields while parsing", () => {
		assert.equal(MAX_ATTACHMENTS, 4);
		assert.equal(MAX_ATTACHMENT_BYTES, 5 * 1024 * 1024);
		assert.equal(MAX_TOTAL_ATTACHMENT_BYTES, 10 * 1024 * 1024);
		assert.deepEqual(parseChatInput({ type: "text", text: " ", attachments: [{ ...image, secret: true }] }), {
			type: "text", text: " ", attachments: [image],
		});
	});

	it("rejects blank messages without files, malformed base64, unsafe names, and excess files", () => {
		assert.throws(() => parseChatInput({ type: "text", text: "  " }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "text", text: "look", attachments: [{ ...image, data: "a?==" }] }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "text", text: "look", attachments: [{ ...image, name: "../x.png" }] }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "text", text: "look", attachments: Array.from({ length: 5 }, (_, i) => ({ ...image, name: `${i}.png` })) }), ChatInputError);
	});

	it("accepts the exact per-file and aggregate byte limits", () => {
		const data = btoa("x".repeat(MAX_ATTACHMENT_BYTES));
		const exactFile = { ...image, data };
		assert.equal(parseChatInput({ type: "text", text: "look", attachments: [exactFile] }).type, "text");
		assert.equal(parseChatInput({ type: "text", text: "look", attachments: [exactFile, { ...exactFile, name: "second.png" }] }).type, "text");
		assert.throws(() => parseChatInput({ type: "text", text: "look", attachments: [{ ...image, data: btoa("x".repeat(MAX_ATTACHMENT_BYTES + 1)) }] }), ChatInputError);
	});

	it("rejects declared image types whose signature does not match", async () => {
		await assert.rejects(() => prepareChatAttachments([{ ...image, data: encode(Uint8Array.from([1, 2, 3])) }]), /does not match its declared file type/);
	});

	it("rejects a malformed PDF before changing the saved chat record", async () => {
		const chat = chatStore.createChat("Attachment validation test");
		const before = chatStore.getChat(chat.id)!.messages;
		try {
			const malformedPdf = { name: "broken.pdf", mimeType: "application/pdf" as const, data: encode(new TextEncoder().encode("%PDF-not-a-document")) };
			const response = await handleChatInput(chat.id, { type: "text", text: "", attachments: [malformedPdf] });
			assert.equal(response.status, 400);
			assert.deepEqual(chatStore.getChat(chat.id)!.messages, before);
		} finally {
			chatStore.deleteChat(chat.id);
		}
	});

	it("refuses photos for a text-only model before starting or writing a turn", async () => {
		const model = piModels().getModels("openrouter").find((candidate) => !candidate.input.includes("image"));
		assert.ok(model);
		assert.equal(model.input.includes("image"), false);
		const chat = chatStore.createChat("Text-only attachment gate test");
		const previousKey = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "synthetic-key-no-provider-calls";
		try {
			chatStore.saveSettings(chat.id, { model: { provider: model.provider, id: model.id } });
			const before = chatStore.getChat(chat.id)!.messages;
			const response = await handleChatInput(chat.id, { type: "text", text: "", attachments: [image] }, () => { throw new Error("A refused upload must not build an agent"); });
			assert.equal(response.status, 400);
			assert.match(await response.text(), /does not support image attachments/);
			assert.deepEqual(chatStore.getChat(chat.id)!.messages, before);
			assert.equal(isTurnRunning(chat.id), false);
		} finally {
			if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = previousKey;
			chatStore.deleteChat(chat.id);
		}
	});

	it("returns 400 for null JSON and caps streamed bodies without Content-Length", async () => {
		const nullBody = await handleChatRequest(new Request("http://localhost/api/chat", { method: "POST", body: "null" }));
		assert.equal(nullBody.status, 400);

		const chunk = new Uint8Array(8 * 1024 * 1024);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); controller.close(); },
		});
		const request = new Request("http://localhost/api/chat", {
			method: "POST",
			body: stream,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		assert.equal(request.headers.has("content-length"), false);
		const oversized = await handleChatRequest(request);
		assert.equal(oversized.status, 413);
	});

	it("extracts page-labeled PDF text for the model while keeping it out of transcript text", async () => {
		const bytes = textPdf("attachment proof");
		const [prepared] = await prepareChatAttachments([{ name: "sample.pdf", mimeType: "application/pdf", data: encode(bytes) }]);
		assert.match(prepared!.text ?? "", /\[Page 1\]/);
		assert.match(prepared!.text ?? "", /attachment proof/);
		const message = newAttachmentUserMessage("Explain this", [{ name: prepared!.name, mimeType: prepared!.mimeType, data: prepared!.data }], `Attached PDF: ${prepared!.name}\n${prepared!.text}`);
		const view = projectView([message]);
		assert.deepEqual(view[0]!.parts.map((part) => part.type), ["text", "attachment"]);
		assert.equal((view[0]!.parts[0] as { text: string }).text, "Explain this");
		const modelContent = (toLlmMessages([message] as never)[0] as { content: Array<{ text?: string }> }).content;
		assert.match(modelContent.at(-1)?.text ?? "", /\[Page 1\]/);
		assert.equal(JSON.stringify(view).includes("\[Page 1\]"), false);
	});

	it("gives a clear error for a valid PDF without extractable text", async () => {
		await assert.rejects(() => prepareChatAttachments([{ name: "scan.pdf", mimeType: "application/pdf", data: encode(textPdf("")) }]), /no extractable text/);
	});

	it("passes native image content to vision models and attachment metadata to the view", () => {
		const message = newAttachmentUserMessage("What is this?", [image]);
		assert.deepEqual((toLlmMessages([message] as never)[0] as { content: Array<{ type: string }> }).content.map((part) => part.type), ["text", "image"]);
		assert.deepEqual(projectView([message])[0]!.parts[1], { type: "attachment", data: image });
	});

	it("includes filenames in markdown and extracted PDF text in context sizing", () => {
		const message = newAttachmentUserMessage("Review", [{ name: "lesson.pdf", mimeType: "application/pdf", data: "JVBERi0=" }], `Attached PDF: lesson.pdf\n${"text ".repeat(1000)}`);
		const markdown = sessionMarkdown([message]);
		assert.match(markdown, /lesson\.pdf/);
		assert.equal(markdown.includes("JVBERi0="), false);
		assert.ok(estimateMessageTokens(message) >= 1000);
	});
});
