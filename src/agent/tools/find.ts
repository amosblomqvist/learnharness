import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { capOutput, formatSize, MAX_OUTPUT_BYTES, matchGlob, sourceSearchRoots, walkFiles, WALK_TIMEOUT_MS } from "./fs-shared.ts";
import { resolvePolicy } from "./file-access.ts";

/** Pure-Node pi/fd-style search: no shell, no symlink following, mandatory
 * source denials. Restricted default searches share ONE budget/limit across
 * all allowed roots; explicit paths keep their HOME-relative meaning. */
const DEFAULT_LIMIT = 1000;
const findInput = Type.Object({
	pattern: Type.String({ minLength: 1, description: "Glob pattern, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'; matched relative to each search root" }),
	path: Type.Optional(Type.String({ description: "Directory to search. Default: home when unrestricted, all allowed folders when restricted. Explicit relative paths are home-relative." })),
	limit: Type.Optional(Type.Integer({ description: "Maximum total results across all roots (default: 1000)" })),
});

export const findTool: AgentTool<typeof findInput> = {
	name: "find",
	label: "find",
	description: `Search for files by glob pattern. Returns paths relative to an explicit search directory, or absolute paths when searching the allowed folders by default. Use ls without a path to discover allowed roots. Ignores node_modules, .git, and Library directories, and skips known sensitive locations (including agent transcripts, credential stores and browser profiles), plus .env/.env.* files. Output is truncated to ${DEFAULT_LIMIT} total results or ${formatSize(MAX_OUTPUT_BYTES)} (whichever is hit first).`,
	parameters: findInput,
	execute: serverExecute("find", findInput, async (input, ctx) => {
		if (ctx?.signal?.aborted) return "Operation aborted";
		const policy = resolvePolicy();
		const { roots, notices, multiRoot } = sourceSearchRoots(input.path, policy);
		for (const root of roots) {
			let stat;
			try { stat = await fs.stat(root); }
			catch { throw new Error(`Path not found: ${root}`); }
			if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);
		}
		const effectiveLimit = input.limit ?? DEFAULT_LIMIT;
		const matches: string[] = [];
		const deadline = Date.now() + WALK_TIMEOUT_MS;
		let limitReached = false;
		let timedOut = false;
		let aborted = false;
		for (const root of roots) {
			const result = await walkFiles(root, (filePath) => {
				const rel = path.relative(root, filePath).split(path.sep).join("/");
				if (!matchGlob(rel, input.pattern)) return false;
				if (matches.length >= effectiveLimit) { limitReached = true; return true; }
				matches.push(multiRoot ? filePath : rel);
				return false;
			}, ctx?.signal, { policy, deadline });
			timedOut ||= result.timedOut;
			aborted ||= result.aborted;
			if (timedOut || aborted || limitReached) break;
		}
		const finish = (body: string): string => notices.length ? `${body}\n\n[${notices.join(". ")}]` : body;
		if (aborted) return finish(matches.length
			? `${capOutput(matches).content}\n\n[search aborted — partial results]`
			: "Search aborted before any results.");
		if (!matches.length && !limitReached) return finish(timedOut
			? "Search timed out after 10s with no matches yet. Narrow the search to a subdirectory."
			: "No files found matching pattern");
		const { content, truncated } = capOutput(matches);
		if (limitReached || matches.length >= effectiveLimit) notices.push(`${effectiveLimit} results limit reached`);
		if (truncated) notices.push(`${formatSize(MAX_OUTPUT_BYTES)} limit reached`);
		if (timedOut) notices.push("search timed out after 10s — partial results, narrow the directory");
		return finish(content);
	}),
};
