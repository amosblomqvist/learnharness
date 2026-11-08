import fs from "node:fs";
import path from "node:path";
import { PROMPT_EDITOR_FILE } from "../../config.ts";
import { PROMPT_EDITOR_IDS, type PromptEditorId, type PromptEditorVersion } from "../core/prompt-editor.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export interface PromptEditorRecord {
	schemaVersion: 1;
	initialized: true;
	migrationNotice: boolean;
	texts: Partial<Record<PromptEditorId, string>>;
	history: PromptEditorVersion[];
}

const EDITOR_IDS = new Set<string>(PROMPT_EDITOR_IDS);

function isPromptEditorVersion(value: unknown): value is PromptEditorVersion {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const version = value as Record<string, unknown>;
	return typeof version.id === "string" && EDITOR_IDS.has(String(version.editor)) &&
		typeof version.text === "string" && typeof version.savedAt === "string" &&
		Number.isFinite(Date.parse(version.savedAt));
}

function isPromptEditorRecord(value: unknown): value is PromptEditorRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || record.initialized !== true || typeof record.migrationNotice !== "boolean" || !record.texts ||
		typeof record.texts !== "object" || Array.isArray(record.texts) || !Array.isArray(record.history)) return false;
	for (const [editor, text] of Object.entries(record.texts)) {
		if (!EDITOR_IDS.has(editor) || typeof text !== "string") return false;
	}
	return record.history.every(isPromptEditorVersion);
}

export function readPromptEditorRecord(): PromptEditorRecord | null {
	let text: string;
	try {
		text = fs.readFileSync(PROMPT_EDITOR_FILE, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Prompt editor data is invalid JSON");
	}
	if (!isPromptEditorRecord(parsed)) throw new Error("Prompt editor data has an unsupported format");
	return parsed;
}

export function writePromptEditorRecord(record: PromptEditorRecord): void {
	fs.mkdirSync(path.dirname(PROMPT_EDITOR_FILE), { recursive: true });
	writeFileAtomicSync(PROMPT_EDITOR_FILE, JSON.stringify(record, null, "\t"), { allowInPlaceFallback: true });
}
