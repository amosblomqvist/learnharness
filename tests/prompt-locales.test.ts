/**
 * Localized prompt segments: the agents compose their system prompt from
 * the app language's translated segments (src/agent/prompts/locales/<id>/,
 * mirroring the English layout), falling back to English per segment;
 * overrides stay keyed by segment path and win in every language.
 *
 * Owns its own LH_DATA_DIR (set before any config-loading import) so the
 * override write never touches real user overrides.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-prompt-locales-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { PROMPTS_OVERRIDE_DIR, PATHS } = await import("../config.ts");
const { composeInstructions, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { resolveSegmentFile } = await import("../src/agent/prompt-segments.ts");

const PROMPTS_DIR = path.join(PATHS.root, "src", "agent", "prompts");
const read = (file: string) => fs.readFileSync(file, "utf-8").trim();
const englishBase = read(PATHS.teacherPrompt);
const spanishBase = read(path.join(PROMPTS_DIR, "locales", "es", "system-prompt.md"));

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("localized prompt composition", () => {
	it("English stays the default composition", () => {
		const teacher = composeInstructions("teacher");
		assert.ok(teacher.startsWith(englishBase));
		assert.equal(composeInstructions("teacher", {}, "en"), teacher);
	});

	it("Spanish composes the translated base segment", () => {
		const teacher = composeInstructions("teacher", {}, "es");
		assert.ok(teacher.startsWith(spanishBase));
		assert.ok(!teacher.includes(englishBase));
	});

	it("a segment with no translation falls back to the English file", () => {
		const locales = fs.mkdtempSync(path.join(os.tmpdir(), "lh-locales-"));
		fs.mkdirSync(path.join(locales, "es", "teacher"), { recursive: true });
		fs.writeFileSync(path.join(locales, "es", "teacher", "10-planning.md"), "planificación");
		assert.equal(resolveSegmentFile("teacher/10-planning.md", "/en/10-planning.md", "es", locales), path.join(locales, "es", "teacher", "10-planning.md"));
		assert.equal(resolveSegmentFile("teacher/20-teaching.md", "/en/20-teaching.md", "es", locales), "/en/20-teaching.md");
		assert.equal(resolveSegmentFile("teacher/10-planning.md", "/en/10-planning.md", "en", locales), "/en/10-planning.md");
		fs.rmSync(locales, { recursive: true, force: true });
	});

	it("the language threads through agent construction into the system prompt", () => {
		const faux = createFauxCore({});
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
		assert.ok(createTeacherAgent(undefined, { engine, language: "es" }).state.systemPrompt.startsWith(spanishBase));
		assert.ok(createTeacherAgent(undefined, { engine, promptSwitches: {}, language: "es" }).state.systemPrompt.startsWith(spanishBase));
		assert.ok(createTeacherAgent(undefined, { engine }).state.systemPrompt.startsWith(englishBase));
	});

	it("an enabled override wins in every language", () => {
		fs.mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true });
		fs.writeFileSync(path.join(PROMPTS_OVERRIDE_DIR, "system-prompt.md"), "MY OWN BASE");
		const switches = { "system-prompt.md": true };
		for (const language of ["en", "es"] as const) {
			const teacher = composeInstructions("teacher", switches, language);
			assert.ok(teacher.startsWith("MY OWN BASE"), language);
			assert.ok(!teacher.includes(spanishBase), language);
		}
	});
});
