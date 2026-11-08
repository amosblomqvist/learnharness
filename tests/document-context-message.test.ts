import assert from "node:assert/strict";
import { it } from "node:test";
import {
	newDocumentContextMessage,
	toLlmMessages,
	formatDocumentContextText,
	type DocumentContextItem,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { serializeForSummary, buildCompactionPrompt } from "../src/core/compaction.ts";
import { formatDocumentsForSystemPrompt } from "../src/agent/teacher-agent.ts";

const sampleDocs: DocumentContextItem[] = [
	{
		id: "doc_1",
		fileName: "lecture1.pptx",
		category: "lecture",
		extension: ".pptx",
		size: 1024,
		text: "Slide 1: Intro to Physics\nNewton's Laws",
		summary: { pageOrSlideCount: 10, charCount: 39 },
	},
	{
		id: "doc_2",
		fileName: "midterm_exam_2024.pdf",
		category: "exam",
		extension: ".pdf",
		size: 2048,
		text: "Problem 1: An object of mass 5kg...",
		summary: { pageOrSlideCount: 3, charCount: 35 },
	},
];

it("newDocumentContextMessage constructs marker message with formatted lecture and exam sections", () => {
	const marker = newDocumentContextMessage(sampleDocs);

	assert.equal(marker.role, "custom");
	assert.equal(marker.customType, "document-context");
	assert.equal(marker.display, true);

	// Check content includes instructions and sections
	assert.ok(marker.content.includes("### 📚 COURSE & LECTURE MATERIALS:"));
	assert.ok(marker.content.includes("lecture1.pptx (10 pages/slides)"));
	assert.ok(marker.content.includes("### 📝 EXAMS & TEST FORMATS:"));
	assert.ok(marker.content.includes("midterm_exam_2024.pdf (3 pages)"));
	assert.ok(marker.content.includes("PRIMARY GOAL"));

	// Check details carries metadata for UI
	const details = marker.details as { documents: unknown[] };
	assert.equal(details.documents.length, 2);
});

it("toLlmMessages excludes document-context marker from wire messages (UI-only)", () => {
	const marker = newDocumentContextMessage(sampleDocs);
	const userMessage: LhMessage = {
		id: "msg_user_1",
		role: "user",
		content: "Hello teacher",
		timestamp: Date.now(),
	};

	const wire = toLlmMessages([marker, userMessage]);

	// document-context must NOT be sent across the wire as a user message
	assert.equal(wire.length, 1);
	assert.equal(wire[0]?.role, "user");
	const textContent = wire[0]?.content;
	const text = typeof textContent === "string" ? textContent : (textContent as Array<{ text?: string }>)[0]?.text;
	assert.equal(text, "Hello teacher");
});

it("serializeForSummary skips full document content but appends document list note", () => {
	const marker = newDocumentContextMessage(sampleDocs);
	const userMessage: LhMessage = {
		id: "msg_user_1",
		role: "user",
		content: "Please help me review",
		timestamp: Date.now(),
	};

	const summaryText = serializeForSummary([marker, userMessage]);

	// summary text should NOT include massive static document materials
	assert.ok(!summaryText.includes("### 📚 COURSE & LECTURE MATERIALS"));
	assert.ok(!summaryText.includes("Slide 1: Intro to Physics"));
	// It MUST include the concise file names note
	assert.ok(summaryText.includes("Note: The user is currently learning based on these documents: lecture1.pptx, midterm_exam_2024.pdf"));
	assert.ok(summaryText.includes("Please help me review"));
});

it("buildCompactionPrompt appends document file names note when provided", () => {
	const prompt = buildCompactionPrompt({
		spanText: "sample span",
		planTreeText: null,
		kind: "teach",
		documentNames: ["lecture1.pptx", "midterm.pdf"],
	});

	assert.ok(prompt.includes("Note: The user is currently learning based on these documents: lecture1.pptx, midterm.pdf."));
});

it("formatDocumentsForSystemPrompt wraps docs in XML tags with category-specific instructions", () => {
	const formatted = formatDocumentsForSystemPrompt(sampleDocs);

	assert.ok(formatted.includes('<document name="lecture1.pptx" category="lecture">'));
	assert.ok(formatted.includes("<instruction>"));
	assert.ok(formatted.includes("This document contains official course lecture notes and slides."));
	assert.ok(formatted.includes("<content>"));
	assert.ok(formatted.includes("Newton's Laws"));
	assert.ok(formatted.includes("</content>"));
	assert.ok(formatted.includes("</document>"));

	assert.ok(formatted.includes('<document name="midterm_exam_2024.pdf" category="exam">'));
	assert.ok(formatted.includes("CRITICAL: Absolutely DO NOT solve exam problems directly"));
	assert.ok(formatted.includes("Problem 1: An object of mass 5kg..."));
});
