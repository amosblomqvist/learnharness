import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../config.ts";
import type { PromptEditorTexts } from "../core/prompt-editor.ts";

const PROMPTS = path.join(ROOT, "src", "agent", "prompts");
const SEPARATOR = "\n\n---\n\n";

function read(name: string): string {
	return fs.readFileSync(path.join(PROMPTS, name), "utf-8").trim();
}

function join(parts: string[]): string {
	return parts.map((part) => part.trim()).filter(Boolean).join(SEPARATOR);
}

export function readDefaultPromptEditors(): PromptEditorTexts {
	return {
		prober: read("prober.md"),
		teacher: read("teacher.md"),
		practice: read("practice.md"),
		proberTeacherShared: join([read("shared/teaching-base.md"), read("shared/teaching-mechanics.md")]),
		common: read("common.md"),
	};
}

export const DEFAULT_PROMPT_EDITORS = readDefaultPromptEditors();

