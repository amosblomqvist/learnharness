import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import {
	capOutput,
	formatSize,
	MAX_OUTPUT_BYTES,
	matchGlob,
	resolveSourcePath,
	walkFiles,
} from "./fs-shared.ts";
import { guardSourcePath } from "./file-access.ts";

/**
 * The find tool — sources v1 (2026-09-19): pi's dist/core/tools/find.js
 * ported to a pure-Node walker (pi shells out to fd; no binaries here —
 * Electron/Windows-safe, fs-shared.ts). Schemas, fd's glob semantics
 * (basename-mode without a slash, implied deep prefix with one), relativized output,
 * and the notice formats are pi-verbatim; the deltas: home-anchored
 * default, .gitignore replaced by hard noise exclusions, and a wall-clock
 * timeout with partial results. Read-only by construction.
 */

const DEFAULT_LIMIT = 1000;

const findInput = Type.Object({
	pattern: Type.String({
		minLength: 1,
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: the learner's home directory)" })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of results (default: 1000)" })),
});

export const findTool: AgentTool<typeof findInput> = {
	name: "find",
	label: "find",
	description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Ignores node_modules, .git, and Library directories. Output is truncated to ${DEFAULT_LIMIT} results or ${formatSize(MAX_OUTPUT_BYTES)} (whichever is hit first).`,
	parameters: findInput,
	execute: serverExecute("find", findInput, async (input, ctx) => {
		if (ctx?.signal?.aborted) return "Operation aborted";
		const searchPath = await guardSourcePath(resolveSourcePath(input.path));
		let stat;
		try {
			stat = await fs.stat(searchPath);
		} catch {
			throw new Error(`Path not found: ${searchPath}`);
		}
		if (!stat.isDirectory()) throw new Error(`Not a directory: ${searchPath}`);

		const effectiveLimit = input.limit ?? DEFAULT_LIMIT;
		const matches: string[] = [];
		let limitReached = false;
		const { timedOut, aborted } = await walkFiles(
			searchPath,
			(filePath) => {
				const rel = path.relative(searchPath, filePath).split(path.sep).join("/");
				if (!matchGlob(rel, input.pattern)) return false;
				if (matches.length >= effectiveLimit) {
					limitReached = true;
					return true; // stop the walk
				}
				matches.push(rel);
				return false;
			},
			ctx?.signal,
		);

		if (aborted) {
			return matches.length > 0
				? `${matches.join("\n")}\n\n[search aborted — partial results]`
				: "Search aborted before any results.";
		}
		if (matches.length === 0 && !limitReached) {
			return timedOut
				? `Search timed out after 10s with no matches yet. Narrow the search to a subdirectory.`
				: "No files found matching pattern";
		}
		const { content, truncated } = capOutput(matches);
		const notices: string[] = [];
		if (limitReached || matches.length >= effectiveLimit) notices.push(`${effectiveLimit} results limit reached`);
		if (truncated) notices.push(`${formatSize(MAX_OUTPUT_BYTES)} limit reached`);
		if (timedOut) notices.push("search timed out after 10s — partial results, narrow the directory");
		return notices.length > 0 ? `${content}\n\n[${notices.join(". ")}]` : content;
	}),
};
