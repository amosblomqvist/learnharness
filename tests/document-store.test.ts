import assert from "node:assert/strict";
import { it } from "node:test";
import { saveDocument, getDocuments, deleteDocument } from "../src/server/document-store.ts";
import type { ParsedDocument } from "../src/server/document-parser.ts";

it("document-store saves, retrieves, and deletes documents", async () => {
	const chatId = `test_chat_${Date.now()}`;
	const doc1: ParsedDocument = {
		id: "doc_test_1",
		fileName: "exam_2024.txt",
		category: "exam",
		extension: ".txt",
		size: 100,
		text: "Question 1: Calculate the derivative.",
		summary: { charCount: 38 },
	};
	const rawBuffer = Buffer.from(doc1.text, "utf-8");

	await saveDocument(chatId, doc1, rawBuffer);

	let docs = await getDocuments(chatId);
	assert.equal(docs.length, 1);
	assert.equal(docs[0]?.id, "doc_test_1");
	assert.equal(docs[0]?.category, "exam");

	const doc2: ParsedDocument = {
		id: "doc_test_2",
		fileName: "lecture_slides.pptx",
		category: "lecture",
		extension: ".pptx",
		size: 200,
		text: "Slide 1: Calculus Basics",
		summary: { pageOrSlideCount: 5, charCount: 24 },
	};

	await saveDocument(chatId, doc2);
	docs = await getDocuments(chatId);
	assert.equal(docs.length, 2);

	await deleteDocument(chatId, "doc_test_1");
	docs = await getDocuments(chatId);
	assert.equal(docs.length, 1);
	assert.equal(docs[0]?.id, "doc_test_2");
});
