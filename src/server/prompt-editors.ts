import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PROMPTS_OVERRIDE_DIR, SETTINGS_FILE } from "../../config.ts";
import { DEFAULT_PROMPT_EDITORS } from "../agent/prompt-defaults.ts";
import legacyPrompts from "../agent/prompts/legacy-v1.json" with { type: "json" };
import { PROMPT_EDITOR_IDS, type PromptEditorId, type PromptEditorVersion } from "../core/prompt-editor.ts";
import { readPromptEditorRecord, writePromptEditorRecord, type PromptEditorRecord } from "../store/prompt-editor.ts";

const SEPARATOR = "\n\n---\n\n";
const LEGACY_GROUPS: Record<PromptEditorId, string[]> = {
	prober: ["prober/10-probe-doctrine.md"],
	teacher: [
		"teacher/05-method.md",
		"teacher/10-planning.md",
		"teacher/20-teaching.md",
		"teacher/28-predictions.md",
		"teacher/30-question-principles.md",
		"teacher/40-jobs.md",
		"teacher/50-demos.md",
		"teacher/55-images.md",
	],
	practice: ["practice/00-base.md", "practice/10-doctrine.md"],
	proberTeacherShared: ["system-prompt.md", "shared/20-question-tools.md", "shared/25-confidence.md", "shared/30-learner-files.md"],
	common: ["shared/10-voice.md", "shared/15-accuracy.md", "shared/16-mental-model.md", "shared/40-formatting.md"],
};

function legacySource(pathname: string): string {
	const key = pathname === "system-prompt.md" ? pathname : `prompts/${pathname}`;
	const value = (legacyPrompts as Record<string, unknown>)[key];
	if (typeof value !== "string") throw new Error(`Legacy prompt archive is missing ${key}`);
	return value.trim();
}

function readLegacyOverride(pathname: string): string | null {
	try {
		const file = path.join(PROMPTS_OVERRIDE_DIR, ...pathname.split("/"));
		if (!fs.statSync(file).isFile()) return null;
		return fs.readFileSync(file, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function readLegacySwitches(): Record<string, boolean> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const agent = (parsed as Record<string, unknown>).agent;
	if (!agent || typeof agent !== "object" || Array.isArray(agent)) return {};
	const prompts = (agent as Record<string, unknown>).prompts;
	if (!prompts || typeof prompts !== "object" || Array.isArray(prompts)) return {};
	return prompts as Record<string, boolean>;
}

function joinLegacyGroup(editor: PromptEditorId, overrides: Map<string, string>, activeOnly?: Set<string>): string {
	return LEGACY_GROUPS[editor]
		.map((pathname) => activeOnly && !activeOnly.has(pathname) ? legacySource(pathname) : overrides.get(pathname) ?? legacySource(pathname))
		.map((text) => text.trim())
		.filter(Boolean)
		.join(SEPARATOR);
}

function makeVersion(editor: PromptEditorId, text: string, savedAt = new Date().toISOString()): PromptEditorVersion {
	return { id: randomUUID(), editor, text, savedAt };
}

function migrateLegacyPromptEdits(): PromptEditorRecord {
	const switches = readLegacySwitches();
	const overrides = new Map<string, string>();
	for (const pathname of new Set(Object.values(LEGACY_GROUPS).flat())) {
		const text = readLegacyOverride(pathname);
		if (text !== null && text.trim() !== legacySource(pathname)) overrides.set(pathname, text);
	}

	const texts: PromptEditorRecord["texts"] = {};
	const history: PromptEditorVersion[] = [];
	for (const editor of PROMPT_EDITOR_IDS) {
		const paths = LEGACY_GROUPS[editor];
		const active = new Set(paths.filter((pathname) => switches[pathname] === true && overrides.has(pathname)));
		if (active.size) texts[editor] = joinLegacyGroup(editor, overrides, active);
		if (paths.some((pathname) => overrides.has(pathname))) {
			const savedText = joinLegacyGroup(editor, overrides);
			const versions = [texts[editor], savedText].filter((text): text is string => typeof text === "string");
			for (const text of new Set(versions)) {
				if (!history.some((version) => version.editor === editor && version.text === text)) history.push(makeVersion(editor, text));
			}
		}
	}

	const record: PromptEditorRecord = {
		schemaVersion: 1,
		initialized: true,
		migrationNotice: overrides.size > 0,
		texts,
		history,
	};
	writePromptEditorRecord(record);
	return record;
}

function currentRecord(): PromptEditorRecord {
	return readPromptEditorRecord() ?? migrateLegacyPromptEdits();
}

function hasLegacyPromptEdits(): boolean {
	for (const pathname of new Set(Object.values(LEGACY_GROUPS).flat())) {
		const text = readLegacyOverride(pathname);
		if (text !== null && text.trim() !== legacySource(pathname)) return true;
	}
	return false;
}

export function initializePromptEditors(): void {
	if (!readPromptEditorRecord() && hasLegacyPromptEdits()) migrateLegacyPromptEdits();
}

function currentText(record: PromptEditorRecord, editor: PromptEditorId): string {
	return record.texts[editor] ?? DEFAULT_PROMPT_EDITORS[editor];
}

export function getPromptEditors() {
	const record = currentRecord();
	return {
		editors: Object.fromEntries(PROMPT_EDITOR_IDS.map((editor) => [editor, {
			text: currentText(record, editor),
			defaultText: DEFAULT_PROMPT_EDITORS[editor],
		}])) as Record<PromptEditorId, { text: string; defaultText: string }>,
		history: record.history,
		migrationNotice: record.migrationNotice,
	};
}

export function getCurrentPromptTexts(): Record<PromptEditorId, string> {
	const record = currentRecord();
	return Object.fromEntries(PROMPT_EDITOR_IDS.map((editor) => [editor, currentText(record, editor)])) as Record<PromptEditorId, string>;
}

export function savePromptEditor(editor: PromptEditorId, text: string) {
	const record = currentRecord();
	const previous = currentText(record, editor);
	const next = { ...record, texts: { ...record.texts } };
	let versionId: string | null = null;
	const savedAt = new Date().toISOString();
	if (text === DEFAULT_PROMPT_EDITORS[editor]) delete next.texts[editor];
	else {
		next.texts[editor] = text;
		if (text !== previous && !next.history.some((version) => version.editor === editor && version.text === text)) {
			const version = makeVersion(editor, text, savedAt);
			next.history = [version, ...next.history];
			versionId = version.id;
		}
	}
	writePromptEditorRecord(next);
	return { editor, text: text === DEFAULT_PROMPT_EDITORS[editor] ? DEFAULT_PROMPT_EDITORS[editor] : text, versionId, savedAt };
}

export function restorePromptEditor(editor: PromptEditorId, versionId: string) {
	const record = currentRecord();
	const version = record.history.find((item) => item.id === versionId && item.editor === editor);
	if (!version) return null;
	const texts = { ...record.texts };
	if (version.text === DEFAULT_PROMPT_EDITORS[editor]) delete texts[editor];
	else texts[editor] = version.text;
	writePromptEditorRecord({ ...record, texts });
	return { editor, text: version.text };
}

export function deletePromptEditorHistory(versionIds?: string[]) {
	const record = currentRecord();
	const history = versionIds === undefined
		? []
		: record.history.filter((version) => !versionIds.includes(version.id));
	writePromptEditorRecord({ ...record, history });
}
