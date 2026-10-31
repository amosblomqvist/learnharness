import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AttachmentPicker, AttachmentPreview, AttachmentTray, validateAttachmentFiles } from "../components/chat-attachments.tsx";
import { Composer } from "../components/composer.tsx";
import type { ChatAttachment } from "../src/core/index.ts";

const photo: ChatAttachment = { name: "photo.png", mimeType: "image/png", data: "aGVsbG8=" };
const file = (overrides = {}) => ({ name: "lesson.pdf", type: "application/pdf", size: 100, ...overrides });

describe("attachment drafts", () => {
	for (const type of ["application/pdf", "image/png", "image/jpeg", "image/webp"]) {
		it(`accepts ${type}`, () => assert.doesNotThrow(() => validateAttachmentFiles([file({ type })], [])));
	}
	it("rejects empty, unsupported and oversized files before reading", () => {
		assert.throws(() => validateAttachmentFiles([file({ size: 0 })], []), /empty/);
		assert.throws(() => validateAttachmentFiles([file({ type: "image/svg+xml" })], []), /choose a PDF/);
		assert.throws(() => validateAttachmentFiles([file({ size: 5 * 1024 * 1024 + 1 })], []), /5 MB/);
	});
	it("includes existing drafts in count and byte limits", () => {
		assert.throws(() => validateAttachmentFiles([file()], [photo, photo, photo, photo]), /up to 4/);
		assert.throws(() => validateAttachmentFiles([file({ size: 5 * 1024 * 1024 }), file({ size: 5 * 1024 * 1024 })], [photo]), /10 MB/);
	});
	it("keeps an empty tray out of the existing composer layout", () => {
		assert.equal(renderToStaticMarkup(<AttachmentTray files={[]} reading={false} disabled={false} onRemove={() => {}} />), "");
	});
	it("offers a keyboard accessible multiple file picker", () => {
		const html = renderToStaticMarkup(<AttachmentPicker disabled={false} onFiles={() => {}} />);
		const { document } = parseHTML(html);
		assert.ok(document.querySelector('input[type="file"][multiple]'));
		assert.ok(document.querySelector('button[aria-label="Attach PDFs or photos"]'));
		assert.match(html, /\.pdf/);
	});
	it("renders a named download, thumbnail and removal action", () => {
		const { document } = parseHTML(renderToStaticMarkup(<AttachmentTray files={[photo]} reading={false} disabled={false} onRemove={() => {}} />));
		assert.equal(document.querySelector("a")?.getAttribute("download"), "photo.png");
		assert.equal(document.querySelector("img")?.getAttribute("alt"), "photo.png");
		assert.ok(document.querySelector('button[aria-label="Remove photo.png"]'));
	});
	it("escapes filenames instead of injecting markup", () => {
		const html = renderToStaticMarkup(<AttachmentPreview file={{ ...photo, name: '<script>alert("x")</script>' }} />);
		assert.ok(!html.includes("<script>"));
	});
	it("announces file read errors", () => {
		assert.match(renderToStaticMarkup(<AttachmentTray files={[]} error="Could not read the file." reading={false} disabled={false} onRemove={() => {}} />), /role="alert"/);
	});
	it("preserves an explicit Stop button while an attachment draft waits", () => {
		const { document } = parseHTML(renderToStaticMarkup(<Composer busy value="caption" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend sendBlocked />));
		const stop = document.querySelector('button[aria-label="Stop"]');
		assert.ok(stop);
		assert.equal(stop.getAttribute("type"), "button");
		assert.equal(stop.hasAttribute("disabled"), false);
	});
});
