import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filePathLabel, parseFilePaths, quoteFilePath } from "../src/core/file-paths.ts";

function paths(text: string) {
	return parseFilePaths(text).flatMap((part) => part.kind === "path" ? [part.path] : []);
}

function assertLossless(text: string) {
	const parts = parseFilePaths(text);
	assert.equal(parts.map((part) => part.text).join(""), text);
	let offset = 0;
	for (const part of parts) {
		assert.equal(part.start, offset);
		assert.equal(text.slice(part.start, part.end), part.text);
		offset = part.end;
	}
	assert.equal(offset, text.length);
}

describe("plain-text file path tokens", () => {
	it("returns typed tokens with exact original text and UTF-16 offsets", () => {
		const text = "📚 Read `/tmp/my notes.pdf` now.";
		assert.deepEqual(parseFilePaths(text), [
			{ kind: "text", text: "📚 Read ", start: 0, end: 8 },
			{ kind: "path", text: "`/tmp/my notes.pdf`", path: "/tmp/my notes.pdf", start: 8, end: 27 },
			{ kind: "text", text: " now.", start: 27, end: 32 },
		]);
		assert.deepEqual(parseFilePaths(""), []);
	});

	it("accepts rooted POSIX, drive, UNC and home paths without filesystem access", () => {
		for (const path of [
			"/tmp/notes.pdf", "/", "/does not exist/α ∂ 🧠.pdf", "//volume/file",
			"C:\\Users\\Learner\\My notes.pdf", "d:/notes/測度.md", "C:\\",
			"\\\\server\\share\\nested folder\\notes.pdf", "\\\\server\\share", "\\\\server/share/file.txt",
			"~/Documents/notes.pdf", "~/", "/tmp/a\\b.txt", "/tmp/<>&\"'[]()#?!;:$*=|.txt",
		]) {
			const quoted = quoteFilePath(path);
			assert.deepEqual(paths(quoted), [path]);
			assertLossless(quoted);
		}
	});

	it("recognizes manual and pasted quoted paths anywhere, including adjacent prose", () => {
		const text = "word`/a`word (`~/b`) [`C:/c`](x) <`/d`> /not/quoted";
		assert.deepEqual(paths(text), ["/a", "~/b", "C:/c", "/d"]);
		assertLossless(text);
	});

	it("does not reinterpret ordinary prose, relative paths, URLs or code", () => {
		for (const text of [
			"Read /tmp/file.pdf and ~/notes", "`hello world`", "`a + b`", "`notes.pdf`", "`./notes.pdf`",
			"`../notes.pdf`", "`C:notes.pdf`", "`~someone/notes.pdf`", "`file:///tmp/notes.pdf`",
			"`https://example.test/a.pdf`", "`\\notes.pdf`", "`\\\\server`", "`const p = '/a';`",
			"` /leading space`", "``code `/a` here``", "```\n/a\n```", "```\n`/a`\n```",
		]) {
			assert.deepEqual(paths(text), [], text);
			assertLossless(text);
		}
	});

	it("matches complete equal delimiter runs, never their partial boundaries", () => {
		for (const text of ["`/a", "``/a`", "`/a``", "```/a``"]) {
			assert.deepEqual(paths(text), []);
			assertLossless(text);
		}
		// Other-width runs are legal filename characters, not partial closers.
		assert.deepEqual(paths("``/a```/b``"), ["/a```/b"]);
		assert.deepEqual(paths("`/a``/b`"), ["/a``/b"]);
		assert.deepEqual(paths("``not code closed? `/a`"), ["/a"]);
		assert.deepEqual(paths("```/a```"), ["/a"]);
	});

	it("preserves backticks with variable delimiters and one-space padding", () => {
		assert.equal(quoteFilePath("/tmp/a`b.txt"), "``/tmp/a`b.txt``");
		assert.equal(quoteFilePath("/tmp/a`"), "`` /tmp/a` ``");
		assert.equal(quoteFilePath("/tmp/a```"), "```` /tmp/a``` ````");
		for (const path of ["/tmp/a`", "/tmp/a``b`", "/tmp/`/```/``", "/tmp/a `", "/tmp/a  ", "/tmp/ "]) {
			const text = `before ${quoteFilePath(path)} after`;
			assert.deepEqual(paths(text), [path]);
			assertLossless(text);
		}
		assert.deepEqual(paths("`` /tmp/a` ``"), ["/tmp/a`"]);
		assert.deepEqual(paths("` /tmp/a  `"), ["/tmp/a "]);
		assert.deepEqual(paths("`  /tmp/a  `"), [], "strip one padding space only");
	});

	it("rejects all C0/C1 controls, multiline paths and Unicode line separators", () => {
		const controls = [
			...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)),
			...Array.from({ length: 33 }, (_, i) => String.fromCharCode(127 + i)),
			"\u2028", "\u2029",
		];
		for (const control of controls) {
			const path = `/tmp/a${control}b.pdf`;
			assert.deepEqual(paths(`\`${path}\``), []);
			assert.throws(() => quoteFilePath(path), TypeError);
		}
		for (const path of ["", "relative", "file:///tmp/a", "C:a", "\\\\server"]) {
			assert.throws(() => quoteFilePath(path), TypeError);
		}
	});

	it("round-trips many combinations of legal filename punctuation and whitespace", () => {
		for (const piece of ["`", "``", " ``` ", " ", "  ", "<script>", "[link](x)", "a\\b", "Ω📚"]) {
			for (const suffix of ["", "`", "``", " ", ".pdf"]) {
				const path = `/tmp/${piece}${suffix}`;
				const quoted = quoteFilePath(path);
				assert.deepEqual(paths(quoted), [path]);
				assertLossless(quoted);
			}
		}
	});
});

describe("filePathLabel", () => {
	it("extracts basenames for each platform without normalizing the path", () => {
		for (const [path, label] of [
			["/tmp/a.pdf", "a.pdf"], ["~/測度 theory.md", "測度 theory.md"],
			["C:\\Users\\a.pdf", "a.pdf"], ["C:/Users/a.pdf", "a.pdf"],
			["\\\\server\\share\\a.pdf", "a.pdf"], ["/tmp/a\\b.txt", "a\\b.txt"],
			["/tmp/folder/", "folder"], ["/", "/"], ["~/", "~/"], ["C:\\", "C:\\"],
			["/tmp/a`b", "a`b"],
		]) assert.equal(filePathLabel(path!), label);
	});
});
