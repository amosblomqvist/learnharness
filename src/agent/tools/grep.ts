import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import {
	capOutput,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	isBinaryFile,
	matchGlob,
	MAX_OUTPUT_BYTES,
	resolveSourcePath,
	truncateGrepLine,
	walkFiles,
	WALK_TIMEOUT_MS,
} from "./fs-shared.ts";
import { guardSourcePath } from "./file-access.ts";

/**
 * The grep tool — sources v1 (2026-09-19): pi's dist/core/tools/grep.js
 * ported to a pure-Node scan (pi shells out to rg). Schemas and output
 * formats are pi-verbatim — `relative/path:LINE: text` matches,
 * `relative/path-LINE- text` context lines, the 500-char line cap, the
 * "use read to see full lines" notice. Deltas: home-anchored default,
 * .gitignore replaced by hard noise exclusions, binary detection via NUL
 * sniff, a 2MB file cap, and a wall-clock timeout with partial results.
 * Read-only by construction.
 */

const DEFAULT_LIMIT = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const grepInput = Type.Object({
	pattern: Type.String({ minLength: 1, description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(
		Type.String({ description: "Directory or file to search (default: the learner's home directory)" }),
	),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Integer({ minimum: 0, description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of matches to return (default: 100)" })),
});

export const grepTool: AgentTool<typeof grepInput> = {
	name: "grep",
	label: "grep",
	description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Ignores node_modules, .git, and Library directories. Output is truncated to ${DEFAULT_LIMIT} matches or ${formatSize(MAX_OUTPUT_BYTES)} (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
	parameters: grepInput,
	execute: serverExecute("grep", grepInput, async (input, ctx) => {
		if (ctx?.signal?.aborted) return "Operation aborted";
		const searchPath = await guardSourcePath(resolveSourcePath(input.path));

		let stat;
		try {
			stat = await fs.stat(searchPath);
		} catch {
			throw new Error(`Path not found: ${searchPath}`);
		}
		const isDirectory = stat.isDirectory();

		const regex = new RegExp(
			input.literal ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern,
			input.ignoreCase ? "i" : undefined,
		);
		const contextValue = input.context && input.context > 0 ? input.context : 0;
		const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_LIMIT);

		// Files to scan: one explicit file, or the walked tree (glob-filtered).
		const files: string[] = [];
		let timedOut = false;
		let aborted = false;
		if (!isDirectory) {
			files.push(searchPath);
		} else {
			const result = await walkFiles(
				searchPath,
				(filePath) => {
					if (input.glob) {
						const rel = path.relative(searchPath, filePath).split(path.sep).join("/");
						if (!matchGlob(rel, input.glob)) return false;
					}
					files.push(filePath);
					return false;
				},
				ctx?.signal,
			);
			timedOut = result.timedOut;
			aborted = result.aborted;
		}

		const outLines: string[] = [];
		let matchCount = 0;
		let limitReached = false;
		let linesTruncated = false;
		// The scan phase is bounded too (2026-09-19): the walk's 10s deadline
		// bounds COLLECTION, but reading every collected file was unbounded —
		// the grep that outlived its turn by minutes. Same budget, checked per
		// file; abort lands mid-scan with partial results.
		const scanDeadline = Date.now() + WALK_TIMEOUT_MS;
		let scanTimedOut = false;

		for (const filePath of files) {
			if (ctx?.signal?.aborted) {
				aborted = true;
				break;
			}
			if (Date.now() > scanDeadline) {
				scanTimedOut = true;
				break;
			}
			if (matchCount >= effectiveLimit) {
				limitReached = true;
				break;
			}
			let fileStat;
			try {
				fileStat = await fs.stat(filePath);
			} catch {
				continue;
			}
			if (fileStat.size > MAX_FILE_BYTES) continue; // rg-style silent skip of huge files
			if (await isBinaryFile(filePath).catch(() => true)) continue;

			let content: string;
			try {
				content = await fs.readFile(filePath, "utf-8");
			} catch {
				continue;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const rel = isDirectory
				? path.relative(searchPath, filePath).split(path.sep).join("/")
				: path.basename(filePath);

			for (let i = 0; i < lines.length; i++) {
				if (regex.test(lines[i]!)) {
					if (matchCount >= effectiveLimit) {
						limitReached = true;
						break;
					}
					matchCount++;
					const start = contextValue > 0 ? Math.max(1, i + 1 - contextValue) : i + 1;
					const end = contextValue > 0 ? Math.min(lines.length, i + 1 + contextValue) : i + 1;
					for (let current = start; current <= end; current++) {
						const { text, wasTruncated } = truncateGrepLine(lines[current - 1] ?? "");
						if (wasTruncated) linesTruncated = true;
						// pi's format: ':' for match lines, '-' for context lines.
						outLines.push(current === i + 1 ? `${rel}:${current}: ${text}` : `${rel}-${current}- ${text}`);
					}
				}
			}
			if (limitReached) break;
		}

		if (aborted) {
			return outLines.length > 0
				? `${capOutput(outLines).content}\n\n[search aborted — partial results]`
				: "Search aborted before any results.";
		}
		if (outLines.length === 0) {
			return timedOut || scanTimedOut
				? `Search timed out after 10s with no matches yet. Narrow the search to a subdirectory.`
				: "No matches found";
		}
		const { content, truncated } = capOutput(outLines);
		const notices: string[] = [];
		if (limitReached || matchCount >= effectiveLimit) notices.push(`${effectiveLimit} matches limit reached`);
		if (linesTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		if (truncated) notices.push(`${formatSize(MAX_OUTPUT_BYTES)} limit reached`);
		if (timedOut || scanTimedOut) notices.push("search timed out after 10s — partial results, narrow the directory");
		return notices.length > 0 ? `${content}\n\n[${notices.join(". ")}]` : content;
	}),
};
