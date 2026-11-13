import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	convertDocx,
	convertPdfWithMarkitdown,
	tryConvertWithMarkitdown,
	parseDocx,
} from "../src/server/markitdown.ts";
import { readTool } from "../src/agent/tools/read.ts";
import { createPluginDocumentConverter } from "../src/server/plugin-documents.ts";

function createZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
	const localHeaders: Buffer[] = [];
	const centralHeaders: Buffer[] = [];
	let offset = 0;

	for (const { name, data } of entries) {
		const nameBuf = Buffer.from(name, "utf8");
		const compressed = zlib.deflateRawSync(data);
		const local = Buffer.alloc(30 + nameBuf.length + compressed.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(0, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		nameBuf.copy(local, 30);
		compressed.copy(local, 30 + nameBuf.length);
		localHeaders.push(local);

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0, 14);
		central.writeUInt32LE(0, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);
		centralHeaders.push(central);

		offset += local.length;
	}

	const cdOffset = offset;
	const cdBuf = Buffer.concat(centralHeaders);
	const cdSize = cdBuf.length;

	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cdSize, 12);
	eocd.writeUInt32LE(cdOffset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

function sampleDocxBuffer(): Buffer {
	const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Project Specification</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading 2"/></w:pPr>
      <w:r><w:t>Section 1 &amp; Overview</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>This is introductory text with an image.</w:t></w:r>
      <w:drawing>
        <a:blip r:embed="rIdDiagram"/>
      </w:drawing>
    </w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>First bullet item</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>Nested bullet item</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Lead | Architect</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;

	const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDiagram" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/diagram.png"/>
</Relationships>`;

	return createZip([
		{ name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
		{ name: "word/_rels/document.xml.rels", data: Buffer.from(relsXml, "utf8") },
	]);
}

describe("MarkItDown & DOCX integration", () => {
	it("tryConvertWithMarkitdown returns null gracefully when MarkItDown CLI is absent or fails", async () => {
		const dummyBytes = new Uint8Array([1, 2, 3, 4]);
		const result = await tryConvertWithMarkitdown(dummyBytes, "test.docx");
		// MarkItDown CLI is either not installed or cannot convert 4 dummy bytes
		assert.equal(result, null);
	});

	it("convertPdfWithMarkitdown returns null gracefully when MarkItDown CLI is absent or fails", async () => {
		const dummyBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
		const result = await convertPdfWithMarkitdown(dummyBytes, "test.pdf");
		assert.equal(result, null);
	});

	it("parseDocx extracts headings, text, images, lists, and tables correctly", () => {
		const zip = sampleDocxBuffer();
		const markdown = parseDocx(zip);

		assert.match(markdown, /^# Project Specification/m);
		assert.match(markdown, /^## Section 1 & Overview/m);
		assert.match(markdown, /introductory text with an image/);
		assert.match(markdown, /!\[Image\]\(word\/media\/diagram\.png\)/);
		assert.match(markdown, /^- First bullet item/m);
		assert.match(markdown, /^  - Nested bullet item/m);
		assert.match(markdown, /\| Name \| Role \|/);
		assert.match(markdown, /\| --- \| --- \|/);
		assert.match(markdown, /\| Alice \| Lead \\\| Architect \|/);
	});

	it("convertDocx falls back to built-in reader when MarkItDown CLI is absent", async () => {
		const zip = sampleDocxBuffer();
		const result = await convertDocx(zip, "sample.docx");

		assert.ok(result.markdown.includes("# Project Specification"));
		assert.ok(result.markdown.includes("![Image](word/media/diagram.png)"));
		assert.ok(result.markdown.includes("| Name | Role |"));
		assert.deepEqual(result.notices, [
			"Converted with built-in DOCX reader. Install Microsoft markitdown for full AI image analysis.",
		]);
	});

	it("convertDocx throws an error on invalid or corrupt zip buffer", async () => {
		const invalid = new Uint8Array([1, 2, 3, 4]);
		await assert.rejects(() => convertDocx(invalid, "broken.docx"), /Invalid archive/);
	});

	it("readTool reads and slices .docx files seamlessly", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-docx-test-"));
		const docxFile = path.join(tmpDir, "report.docx");
		fs.writeFileSync(docxFile, sampleDocxBuffer());

		try {
			const res = await readTool.execute!("test", { path: docxFile });
			assert.ok(res.content.length >= 1);
			const first = res.content[0];
			assert.ok(first && typeof first === "object" && "type" in first && first.type === "text" && "text" in first && typeof first.text === "string");
			const text = first.text;
			assert.match(text, /# Project Specification/);
			assert.match(text, /!\[Image\]\(word\/media\/diagram\.png\)/);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("createPluginDocumentConverter converts uploaded .docx files", async () => {
		const converter = createPluginDocumentConverter();
		const form = new FormData();
		form.append("file", new File([new Uint8Array(sampleDocxBuffer())], "contract.docx", {
			type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		}));
		const request = new Request("http://localhost/documents", { method: "POST", body: form });
		const result = await converter.convert(request, new AbortController().signal);

		assert.equal(result.name, "contract.docx");
		assert.match(result.markdown, /# Project Specification/);
		assert.match(result.markdown, /!\[Image\]\(word\/media\/diagram\.png\)/);
		assert.deepEqual(result.notices, [
			"Converted with built-in DOCX reader. Install Microsoft markitdown for full AI image analysis.",
		]);
	});
});
