import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { expandBraces, globToRegex, matchGlob, resolveSourcePath, walkFiles } from "../src/agent/tools/fs-shared.ts";
import { findTool } from "../src/agent/tools/find.ts";
import { grepTool } from "../src/agent/tools/grep.ts";
import { lsTool } from "../src/agent/tools/ls.ts";
import { readTool } from "../src/agent/tools/read.ts";

/**
 * The learner-filesystem tools (sources v1, 2026-09-19): ls/find/grep as
 * pure-Node pi ports, read re-anchored to the home directory. All calls go
 * through absolute paths, except the tilde integration case which temporarily
 * points home resolution at a throwaway fixture. Never touch the real home.
 *
 * Fixture tree (tmpdir):
 *   notes/calculus.md         "The derivative measures force…"
 *   notes/linear.txt          eigenvector content
 *   notes/sub/hidden.md
 *   code/main.ts
 *   node_modules/skipme.txt   (excluded from walks)
 *   Library/alsoskip.txt      (excluded from walks)
 *   binary.bin                NUL byte — grep skips
 */

let FIXTURE: string;

/** Drive one tool's native execute and return the model-facing text
 *  (pi signature: execute(toolCallId, params, signal) → AgentToolResult). */
async function runText(tool: AgentTool<any>, params: unknown, signal?: AbortSignal): Promise<string> {
	const result = await tool.execute!("c", params, signal);
	const first = result.content[0];
	assert.ok(first !== undefined && first.type === "text", "first content part is text");
	return (first as { type: "text"; text: string }).text;
}

async function setup(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-fs-"));
	await fs.mkdir(path.join(root, "notes", "sub"), { recursive: true });
	await fs.mkdir(path.join(root, "code"), { recursive: true });
	await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
	await fs.mkdir(path.join(root, "Library"), { recursive: true });
	await fs.writeFile(path.join(root, "notes", "calculus.md"), "Calculus notes\nThe derivative measures force.\nChapter 1\n");
	await fs.writeFile(path.join(root, "notes", "linear.txt"), "Eigenvectors keep their direction\nonly scaling remains\n");
	await fs.writeFile(path.join(root, "notes", "sub", "hidden.md"), "deep file about MU\n");
	await fs.writeFile(path.join(root, "code", "main.ts"), "const x = 1;\nconst eigenvector = 'here';\n");
	await fs.writeFile(path.join(root, "node_modules", "skipme.txt"), "eigenvector in node_modules\n");
	await fs.writeFile(path.join(root, "Library", "alsoskip.txt"), "eigenvector in Library\n");
	await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x65, 0x69, 0x67, 0x03]));
	return root;
}

describe("glob helpers (fs-shared)", () => {
	it("basename mode: a pattern without a slash matches at any depth", () => {
		assert.equal(matchGlob("notes/sub/calculus.md", "*.md"), true);
		assert.equal(matchGlob("calculus.md", "*.md"), true);
		assert.equal(matchGlob("notes/calculus.md", "*.ts"), false);
	});

	it("star does not cross slashes; double-star does", () => {
		assert.equal(matchGlob("a/b/c.txt", "*.txt"), true); // basename mode
		assert.equal(matchGlob("src/x/a.spec.ts", "src/**/*.spec.ts"), true);
		assert.equal(matchGlob("other/x/a.spec.ts", "src/**/*.spec.ts"), false);
		assert.equal(matchGlob("src/a.spec.ts", "src/**/*.spec.ts"), true, "** covers zero dirs");
	});

	it("slash patterns get an implied deep prefix unless anchored", () => {
		assert.equal(matchGlob("deep/nested/x/main.ts", "**/nested/**/main.ts"), true);
		assert.equal(matchGlob("x/main.ts", "nested/main.ts"), false, "no implied prefix for anchored-looking patterns");
	});

	it("brace alternatives expand", () => {
		assert.deepEqual(expandBraces("*.{ts,tsx}"), ["*.ts", "*.tsx"]);
		assert.equal(matchGlob("code/main.ts", "*.{ts,tsx,js}"), true);
		assert.equal(matchGlob("code/main.ts", "*.{js,jsx}"), false);
	});

	it("question mark is one char, literals are escaped", () => {
		assert.equal(globToRegex("a?c").test("abc"), true);
		assert.equal(globToRegex("a?c").test("ac"), false);
		assert.equal(matchGlob("a.b.txt", "a.b*"), true, "the dot is literal, not any-char");
	});
});

describe("resolveSourcePath (fs-shared)", () => {
	it("a leading ~ is the learner's home, as a shell expands it", () => {
		const home = os.homedir();
		assert.equal(resolveSourcePath("~"), home);
		assert.equal(resolveSourcePath("~/notes/calculus.md"), path.join(home, "notes", "calculus.md"));
		assert.equal(resolveSourcePath(`~${path.sep}notes${path.sep}calculus.md`), path.join(home, "notes", "calculus.md"));
	});

	it("preserves default, ordinary relative, and absolute paths", () => {
		const home = os.homedir();
		const absolute = path.join(os.tmpdir(), "course", "notes.md");
		assert.equal(resolveSourcePath(), home);
		assert.equal(resolveSourcePath(""), home);
		assert.equal(resolveSourcePath("notes/calculus.md"), path.join(home, "notes", "calculus.md"));
		assert.equal(resolveSourcePath(absolute), absolute);
	});

	it("backslash is a home separator only on Windows", () => {
		const input = "~\\notes\\calculus.md";
		const expected = process.platform === "win32"
			? path.join(os.homedir(), "notes", "calculus.md")
			: path.join(os.homedir(), input);
		assert.equal(resolveSourcePath(input), expected);
	});

	it("~user and non-leading tildes stay literal", () => {
		const home = os.homedir();
		assert.equal(resolveSourcePath("~other/notes.md"), path.join(home, "~other", "notes.md"));
		assert.equal(resolveSourcePath("notes/~draft.md"), path.join(home, "notes", "~draft.md"));
		assert.equal(resolveSourcePath("/tmp/~/x.md"), "/tmp/~/x.md");
	});
});

describe("learner tools share leading-tilde resolution", () => {
	it("read, ls, find, and grep reach the same synthetic home", async () => {
		const home = await setup();
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		try {
			process.env.HOME = home;
			process.env.USERPROFILE = home;
			assert.equal(os.homedir(), home);
			const read = await runText(readTool, { path: "~/notes/calculus.md" });
			assert.match(read, /The derivative measures force/);
			const listed = await runText(lsTool, { path: "~/notes" });
			assert.match(listed, /calculus\.md/);
			const found = await runText(findTool, { path: "~/notes", pattern: "*.md" });
			assert.match(found, /calculus\.md/);
			const matched = await runText(grepTool, { path: "~/notes", pattern: "derivative" });
			assert.match(matched, /calculus\.md:2: The derivative measures force/);
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			await fs.rm(home, { recursive: true, force: true });
		}
	});
});

describe("ls (pi port)", () => {
	it("lists sorted, dirs suffixed, dotfiles included", async () => {
		FIXTURE = await setup();
		const out = await runText(lsTool, { path: FIXTURE });
		assert.ok(out.includes("code/"));
		assert.ok(out.includes("notes/"));
		assert.ok(out.includes("binary.bin"));
		// sorted alphabetically, case-insensitive
		const lines = out.split("\n").filter((l) => !l.startsWith("["));
		const sorted = [...lines].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
		assert.deepEqual(lines, sorted);
	});

	it("honors the entry limit with pi's truncation notice", async () => {
		const out = await runText(lsTool, { path: FIXTURE, limit: 2 });
		assert.match(out, /\[Truncated: 2 entries limit\]/);
	});

	it("missing path and non-directory throw (the model sees the error)", async () => {
		await assert.rejects(async () => lsTool.execute!("c", { path: "/nonexistent/xyz" }), /Path not found/);
		await assert.rejects(
			async () => lsTool.execute!("c", { path: path.join(FIXTURE, "binary.bin") }),
			/Not a directory/,
		);
	});
});

describe("find (pi port)", () => {
	it("finds by glob, relativized to the search root", async () => {
		const out = await runText(findTool, { pattern: "*.md", path: FIXTURE });
		assert.ok(out.includes("notes/calculus.md"));
		assert.ok(out.includes("notes/sub/hidden.md"));
		assert.ok(!out.includes(FIXTURE), "paths are relative, not absolute");
	});

	it("never enters node_modules or Library", async () => {
		const out = await runText(findTool, { pattern: "*.txt", path: FIXTURE });
		assert.ok(!out.includes("node_modules"));
		assert.ok(!out.includes("Library"));
		assert.ok(out.includes("notes/linear.txt"));
	});

	it("result limit carries pi's notice", async () => {
		const out = await runText(findTool, { pattern: "*", path: FIXTURE, limit: 2 });
		assert.match(out, /\[2 results limit reached\]/);
	});

	it("no-match message matches pi", async () => {
		const out = await runText(findTool, { pattern: "*.nomatch", path: FIXTURE });
		assert.equal(out, "No files found matching pattern");
	});

	it("slash patterns match paths, not basenames", async () => {
		const out = await runText(findTool, { pattern: "notes/**/*.md", path: FIXTURE });
		assert.ok(out.includes("notes/sub/hidden.md"));
		assert.ok(!out.includes("code/"));
	});
});

describe("grep (pi port)", () => {
	it("formats matches pi-style: rel:line: text", async () => {
		// case-sensitive: the lowercase "eigenvector" hits main.ts but NOT
		// linear.txt's capital-E "Eigenvectors" (that case lives below).
		const out = await runText(grepTool, { pattern: "eigenvector", path: FIXTURE });
		assert.equal(out, "code/main.ts:2: const eigenvector = 'here';");
		assert.ok(!out.includes("node_modules"), "excluded dirs are not searched");
		assert.ok(!out.includes("Library"));
		assert.ok(!out.includes("binary.bin"), "binary files are skipped");
	});

	it("ignoreCase and literal flags", async () => {
		const icase = await runText(grepTool, { pattern: "EIGENVECTOR", path: FIXTURE, ignoreCase: true });
		assert.match(icase, /linear\.txt:1:/);
		const literal = await runText(grepTool, { pattern: "e.gen", literal: true, path: path.join(FIXTURE, "code") });
		assert.equal(literal, "No matches found", "dots are literal when literal=true");
	});

	it("context lines use the dash format", async () => {
		const out = await runText(grepTool, { pattern: "scaling", path: FIXTURE, context: 1 });
		assert.match(out, /notes\/linear\.txt:2: only scaling remains/, "the match line uses colons");
		assert.match(out, /notes\/linear\.txt-1- Eigenvectors keep their direction/, "context before uses dashes");
		assert.match(out, /notes\/linear\.txt-3- $/, "context after (empty line) uses dashes");
	});

	it("glob filter restricts files", async () => {
		const out = await runText(grepTool, { pattern: "eigenvector", path: FIXTURE, glob: "*.ts" });
		assert.match(out, /main\.ts:2:/);
		assert.ok(!out.includes("linear.txt"));
	});

	it("single-file search prints basename; match limit notices pi-style", async () => {
		const file = path.join(FIXTURE, "notes", "calculus.md");
		const out = await runText(grepTool, { pattern: "e", path: file });
		assert.match(out, /^calculus\.md:1: /, "basename for a single-file search");
		const limited = await runText(grepTool, { pattern: "e", path: file, limit: 1 });
		assert.match(limited, /\[1 matches limit reached\]/);
	});

	it("no-match message matches pi", async () => {
		const out = await runText(grepTool, { pattern: "zzzz", path: FIXTURE });
		assert.equal(out, "No matches found");
	});
});

describe("read (home-anchored re-port)", () => {
	it("reads a fixture file verbatim through the shared slice machinery", async () => {
		const out = await runText(readTool, { path: path.join(FIXTURE, "notes", "linear.txt") });
		assert.match(out, /Eigenvectors keep their direction/);
	});
});

describe("abort plumbing (the 2026-09-19 cascade fix)", () => {
	it("walkFiles stops promptly when the signal aborts mid-walk", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-fs-abort-"));
		for (let i = 0; i < 20; i++) await fs.writeFile(path.join(root, `f${i}.txt`), "needle\n");
		const ac = new AbortController();
		let visited = 0;
		const result = await walkFiles(
			root,
			() => {
				visited++;
				if (visited === 3) ac.abort(); // deterministic: abort from inside the walk
				return false;
			},
			ac.signal,
		);
		assert.equal(result.aborted, true);
		assert.equal(result.timedOut, false);
		assert.ok(visited < 20, "the walk stopped early");
	});

	it("find honors a pre-aborted signal without walking", async () => {
		FIXTURE = await setup();
		const ac = new AbortController();
		ac.abort();
		const out = await runText(findTool, { pattern: "*.md" }, ac.signal);
		assert.equal(out, "Operation aborted");
	});

	it("grep honors a pre-aborted signal without scanning", async () => {
		const ac = new AbortController();
		ac.abort();
		const out = await runText(grepTool, { pattern: "eigenvector" }, ac.signal);
		assert.equal(out, "Operation aborted");
	});

	it("grep aborts mid-run with partial results, not a hang", async () => {
		// The exact shape of the 2.7-minute lesson: a tree big enough that
		// the walk+scan outlast an abort mid-flight. Whichever phase the
		// abort lands in, the tool returns promptly with an abort notice —
		// never "No matches found", never a hang.
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-fs-midabort-"));
		await fs.mkdir(path.join(root, "deep"), { recursive: true });
		for (let i = 0; i < 200; i++) {
			await fs.writeFile(path.join(root, i % 2 ? `f${i}.txt` : `deep/f${i}.txt`), "needle line\n");
		}
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 1);
		const started = Date.now();
		const out = await runText(grepTool, { pattern: "needle", path: root }, ac.signal);
		assert.match(out, /aborted/);
		assert.ok(Date.now() - started < 5_000, "returned promptly");
	});
});
