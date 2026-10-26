/**
 * Every English prompt segment has a translation for every non-English
 * app language, and each translation keeps the machine-facing identifiers
 * (backticked tool names, input fields, markers) verbatim — they must
 * match the zod schemas whatever the prose language.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { APP_LANGUAGES, DEFAULT_LANGUAGE } from "../src/core/i18n.ts";
import { listSourceSegments } from "../src/agent/prompt-segments.ts";
import { PATHS } from "../config.ts";

const LOCALES_DIR = path.join(PATHS.root, "src", "agent", "prompts", "locales");

function englishSegments(): Map<string, string> {
	const out = new Map<string, string>();
	for (const agent of ["prober", "teacher", "practice"] as const) {
		for (const s of listSourceSegments(agent)) out.set(s.path, s.file);
	}
	return out;
}

/** Backticked code identifiers: snake_case / camelCase / dotted names. */
function identifiers(text: string): Set<string> {
	const ids = new Set<string>();
	for (const m of text.matchAll(/`([A-Za-z_][\w.]*)`/g)) {
		if (/[_A-Z.]/.test(m[1]!.slice(1)) || /^[a-z]+$/.test(m[1]!)) ids.add(m[1]!);
	}
	return ids;
}

for (const { id } of APP_LANGUAGES.filter((l) => l.id !== DEFAULT_LANGUAGE)) {
	describe(`prompt translations: ${id}`, () => {
		it("every English segment has a translated file", () => {
			const missing = [...englishSegments().keys()].filter((p) => !fs.existsSync(path.join(LOCALES_DIR, id, ...p.split("/"))));
			assert.deepEqual(missing, []);
		});

		it("translations keep every backticked identifier from the English source", () => {
			for (const [segmentPath, englishFile] of englishSegments()) {
				const translated = path.join(LOCALES_DIR, id, ...segmentPath.split("/"));
				if (!fs.existsSync(translated)) continue;
				const kept = identifiers(fs.readFileSync(translated, "utf-8"));
				const lost = [...identifiers(fs.readFileSync(englishFile, "utf-8"))].filter((x) => !kept.has(x));
				assert.deepEqual(lost, [], segmentPath);
			}
		});
	});
}
