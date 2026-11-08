import assert from "node:assert/strict";
import { it } from "node:test";
import JSZip from "jszip";
import { parsePptx, parseDocx, parseDocumentFile } from "../src/server/document-parser.ts";

it("parsePptx extracts slide text in order with slide markers", async () => {
	const zip = new JSZip();
	zip.file(
		"ppt/slides/slide2.xml",
		`<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Content of Slide 2</a:t></a:r></a:p></p:sld>`,
	);
	zip.file(
		"ppt/slides/slide1.xml",
		`<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Title of Slide 1 &amp; Intro</a:t></a:r></a:p></p:sld>`,
	);

	const buffer = await zip.generateAsync({ type: "nodebuffer" });
	const result = await parsePptx(buffer);

	assert.equal(result.slideCount, 2);
	assert.ok(result.text.includes("--- Slide 1 ---"));
	assert.ok(result.text.includes("Title of Slide 1 & Intro"));
	assert.ok(result.text.includes("--- Slide 2 ---"));
	assert.ok(result.text.includes("Content of Slide 2"));
	// Slide 1 must appear before Slide 2
	assert.ok(result.text.indexOf("Slide 1") < result.text.indexOf("Slide 2"));
});

it("parseDocx extracts paragraphs and decodes entities", async () => {
	const zip = new JSZip();
	zip.file(
		"word/document.xml",
		`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>First Paragraph</w:t></w:r></w:p><w:p><w:r><w:t>Second &lt;Tag&gt; Paragraph</w:t></w:r></w:p></w:body></w:document>`,
	);

	const buffer = await zip.generateAsync({ type: "nodebuffer" });
	const result = await parseDocx(buffer);

	assert.equal(result.paragraphCount, 2);
	assert.ok(result.text.includes("First Paragraph"));
	assert.ok(result.text.includes("Second <Tag> Paragraph"));
});

it("parseDocumentFile handles txt and md files directly", async () => {
	const text = "# Chapter 1\nThis is a sample lecture note.";
	const buffer = Buffer.from(text, "utf-8");
	const parsed = await parseDocumentFile("doc_1", "notes.md", buffer, "lecture");

	assert.equal(parsed.id, "doc_1");
	assert.equal(parsed.fileName, "notes.md");
	assert.equal(parsed.category, "lecture");
	assert.equal(parsed.extension, ".md");
	assert.equal(parsed.text, text);
	assert.equal(parsed.summary.charCount, text.length);
});
