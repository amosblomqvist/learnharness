import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { capOutput, formatSize, MAX_OUTPUT_BYTES, resolveSourcePath } from "./fs-shared.ts";
import { guardSourcePath, isRefused, resolvePolicy } from "./file-access.ts";

/**
 * The ls tool — sources v1 (2026-09-19): a Node port of pi's
 * dist/core/tools/ls.js, home-anchored (fs-shared.ts). Schemas and the
 * output format are pi-verbatim; the only semantic deltas: the default
 * directory is the learner's home, and the path description says so.
 * Read-only by construction — readdir/stat only, no mutation APIs.
 */

const DEFAULT_LIMIT = 500;

const lsInput = Type.Object({
	path: Type.Optional(
		Type.String({ description: "Directory to list (default: the learner's home directory)" }),
	),
	limit: Type.Optional(
		Type.Integer({ description: "Maximum number of entries to return (default: 500)" }),
	),
});

export const lsTool: AgentTool<typeof lsInput> = {
	name: "ls",
	label: "ls",
	description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${formatSize(MAX_OUTPUT_BYTES)} (whichever is hit first).`,
	parameters: lsInput,
	execute: serverExecute("ls", lsInput, async (input) => {
		const dirPath = await guardSourcePath(resolveSourcePath(input.path));
		const policy = await resolvePolicy();

		let stat;
		try {
			stat = await fs.stat(dirPath);
		} catch {
			throw new Error(`Path not found: ${dirPath}`);
		}
		if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

		let entries: string[];
		try {
			entries = await fs.readdir(dirPath);
		} catch (e) {
			throw new Error(`Cannot read directory: ${(e as Error).message}`);
		}

		// pi: alphabetical, case-insensitive.
		entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

		const effectiveLimit = input.limit ?? DEFAULT_LIMIT;
		const lines: string[] = [];
		let entryLimitReached = false;
		for (const entry of entries) {
			if (lines.length >= effectiveLimit) {
				entryLimitReached = true;
				break;
			}
			const fullPath = path.join(dirPath, entry);
			if (isRefused(fullPath, policy)) continue; // private app data stays invisible
			try {
				const entryStat = await fs.stat(fullPath);
				lines.push(entryStat.isDirectory() ? `${entry}/` : entry);
			} catch {
				// pi: skip entries it cannot stat
			}
		}

		const { content, truncated } = capOutput(lines);
		if (lines.length === 0) return "Directory is empty";
		const notices: string[] = [];
		if (entryLimitReached) notices.push(`${effectiveLimit} entries limit`);
		if (truncated) notices.push(`${formatSize(MAX_OUTPUT_BYTES)} limit`);
		return notices.length > 0 ? `${content}\n\n[Truncated: ${notices.join(", ")}]` : content;
	}),
};
