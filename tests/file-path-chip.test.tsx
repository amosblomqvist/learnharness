import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { FilePathChip, PathText } from "../components/file-path-chip.tsx";
import { quoteFilePath } from "../src/core/file-paths.ts";

function documentFor(node: React.ReactNode) {
	return parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
}

describe("FilePathChip", () => {
	it("shows a filename and decorative type icon with an accessible full path", () => {
		const path = "/tmp/course notes/α.pdf";
		const document = documentFor(<FilePathChip path={path} />);
		const chip = document.body.firstElementChild!;
		assert.equal(chip.tagName, "SPAN");
		assert.equal(chip.textContent, "α.pdf");
		assert.equal(chip.getAttribute("title"), path);
		assert.equal(chip.getAttribute("role"), "img");
		assert.equal(chip.getAttribute("aria-label"), path);
		assert.equal(chip.querySelector("svg")!.getAttribute("aria-hidden"), "true");
		assert.ok(chip.querySelector(".lucide-file-text"));
		assert.equal(document.querySelector("a, button, input, [tabindex]"), null);
		assert.equal(chip.getAttributeNames().some((name) => name.toLowerCase() === "contenteditable"), false);
		assert.ok(chip.classList.contains("inline-flex"));
		assert.ok(chip.querySelector(".truncate"));
	});

	it("supports atomic editor rendering without requiring an editor in transcripts", () => {
		const document = documentFor(<FilePathChip path="C:\\notes\\chapter.txt" contentEditable={false} className="editor-chip" />);
		const chip = document.body.firstElementChild!;
		// React SSR emits contentEditable; linkedom preserves attribute case.
		const editableAttribute = chip.getAttributeNames().find((name) => name.toLowerCase() === "contenteditable")!;
		assert.equal(chip.getAttribute(editableAttribute), "false");
		assert.ok(chip.classList.contains("editor-chip"));
		assert.equal(chip.textContent, "chapter.txt");
	});

	it("chooses type icons without accessing files or changing their names", () => {
		for (const [filename, icon] of [
			["figure.PNG", "file-image"], ["lecture.mp3", "file-headphone"], ["clip.mp4", "file-play"],
			["course.zip", "file-archive"], ["data.csv", "file-spreadsheet"], ["example.ts", "file-code"],
			["notes.md", "file-text"], ["unknown.xyz", "file"],
		]) {
			const document = documentFor(<FilePathChip path={`/not/real/${filename}`} />);
			assert.equal(document.body.textContent, filename);
			assert.ok(document.querySelector(`.lucide-${icon}`));
		}
	});

	it("keeps dangerous filename HTML inert in both label and title", () => {
		const path = '/tmp/<img src=x onerror="alert(1)">.pdf';
		const document = documentFor(<FilePathChip path={path} />);
		assert.equal(document.body.textContent, '<img src=x onerror="alert(1)">.pdf');
		assert.equal(document.body.firstElementChild!.getAttribute("title"), path);
		assert.equal(document.querySelector("img, script, [onerror], a"), null);
	});
});

describe("PathText", () => {
	it("keeps ordinary text, markup-looking text and inline code completely unchanged", () => {
		const text = 'Ordinary <b>prose</b>\n`code` ./relative `file:///tmp/a` & words';
		const document = documentFor(<PathText text={text} />);
		assert.equal(document.body.textContent, text);
		assert.equal(document.body.children.length, 0);
		assert.equal(renderToStaticMarkup(<PathText text="" />), "");
	});

	it("renders all quoted platforms, adjacent words and paths containing backticks", () => {
		const paths = ["/tmp/a.pdf", "C:\\notes\\b.md", "\\\\server\\share\\c.png", "~/d`e.txt"];
		const text = `before${paths.map(quoteFilePath).join(" then ")}after`;
		const document = documentFor(<PathText text={text} />);
		const chips = document.querySelectorAll('[role="img"]');
		assert.equal(chips.length, paths.length);
		assert.deepEqual(Array.from(chips, (chip) => chip.getAttribute("title")), paths);
		assert.equal(document.body.textContent, "beforea.pdf then b.md then c.png then d`e.txtafter");
		assert.equal(text, `before${paths.map(quoteFilePath).join(" then ")}after`, "presentation never rewrites saved text");
	});

	it("does not interpret HTML in ordinary text or path labels", () => {
		const path = '/tmp/<img src=x onerror="alert(1)">.png';
		const document = documentFor(<PathText text={`<script>alert(1)</script> ${quoteFilePath(path)}`} />);
		assert.equal(document.querySelector("script, img, [onerror], a"), null);
		assert.equal(document.querySelector('[role="img"]')!.getAttribute("title"), path);
		assert.equal(document.body.textContent, '<script>alert(1)</script> <img src=x onerror="alert(1)">.png');
	});
});
