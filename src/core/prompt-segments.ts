/**
 * The pure prompt-segment grammar (P2 reconciliation, 2026-09-19):
 * segment-path validation + the shared segment types, ZERO fs. Discovery
 * (reading the agent's prompt tree) lives in the agent layer
 * (src/agent/prompt-segments.ts — the canonical loader composeInstructions
 * composes through); the override-file CRUD lives in the store adapter
 * (src/store/prompt-overrides.ts). Both import THIS grammar so the
 * mirror-layout rules are defined exactly once.
 *
 * Path grammar: "system-prompt.md" (the shared base), "shared/<fragment>"
 * (sources v1: fragments composed by BOTH agents), "prober/<fragment>" /
 * "teacher/<fragment>" / "practice/<fragment>" — where <fragment> is
 * numeric-prefixed + .md (e.g. 20-teaching.md), plus user-created custom
 * segments ("personalization.md" and "skills/<slug>.md"). POSIX-relative,
 * no traversal.
 */

/** A prompt fragment: numeric order key + .md (e.g. 20-teaching.md). Nothing else loads. */
export const FRAGMENT_RE = /^\d+-[\w.-]+\.md$/;

/** Which agent's prompt directory to compose. */
/** Practice (2026-10-04): composes ONLY its own directory — no shared
 *  teaching base, no shared fragments (the doctrine contradicts the
 *  teaching philosophy; its 00-base.md plays the base role). */
export type PromptAgent = "prober" | "teacher" | "practice";

/** One segment of one agent's composed prompt. */
export interface PromptSegmentInfo {
	/** The override/store key — mirrors the source layout ("system-prompt.md",
	 *  "shared/05-learner-files.md", "teacher/20-teaching.md"). Stable across
	 *  agents: the base and shared/ fragments use the SAME path in both
	 *  agents' lists. */
	path: string;
	/** The source text (what the segment runs without an override). */
	sourceText: string;
	/** The user's override text, or null when no file exists on disk. */
	overrideText: string | null;
	/** Effective state: the settings switch AND the file both present. */
	enabled: boolean;
	/** True for segments BOTH agents compose — the base and shared/ fragments. */
	shared: boolean;
}

export const PERSONALIZATION_SEGMENT = "personalization.md";
export const SKILL_FILE_RE = /^[\w][\w.-]*\.md$/;

export const PERSONALIZATION_PRESETS = [
	{
		id: "id",
		label: "Bahasa Indonesia",
		snippet: "Use Bahasa Indonesia for explanations, questions, and feedback.",
	},
	{
		id: "analogy",
		label: "Practical analogies",
		snippet: "Ground abstract concepts in concrete, practical analogies and real-world examples first.",
	},
	{
		id: "socratic",
		label: "Socratic code tutor",
		snippet: "When teaching code or math, guide me to trace state and derive the fix myself before showing the full answer.",
	},
] as const;

/** Pure helper: append a preset snippet to the personalization draft if not already included. */
export function applyPersonalizationPreset(current: string, snippet: string): string {
	const trimmed = current.trim();
	if (trimmed.includes(snippet)) return trimmed;
	return trimmed ? `${trimmed}\n${snippet}` : snippet;
}

export function isCustomSkillPath(segmentPath: string): boolean {
	if (segmentPath === PERSONALIZATION_SEGMENT) return true;
	const m = /^skills\/([\w.-]+\.md)$/.exec(segmentPath);
	if (!m || m[1] === undefined) return false;
	return SKILL_FILE_RE.test(m[1]) && !m[1].includes("..");
}

function slugifySkillName(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function sanitizeSkillPath(fileName: string, content?: string): string {
	const rawBase = fileName.replace(/\.md$/i, "").trim();
	let candidate = slugifySkillName(rawBase);
	if ((!candidate || candidate === "skill") && content) {
		const fmMatch = /^---\r?\n[\s\S]*?^name:\s*["']?([^\r\n"']+)["']?/m.exec(content);
		const headingMatch = /^#\s+([^\r\n]+)/m.exec(content);
		const derived = slugifySkillName(fmMatch?.[1] ?? headingMatch?.[1] ?? "");
		if (derived) candidate = derived;
	}
	return `skills/${candidate || "skill"}.md`;
}

/** Validate a segment path against the mirror-layout rules (see module
 *  doc). Exported for the routes, which also check membership in the
 *  CURRENT source segment list. */
export function isValidSegmentPath(segmentPath: string): boolean {
	if (segmentPath === "system-prompt.md" || isCustomSkillPath(segmentPath)) return true;
	const m = /^(prober|teacher|practice|shared)\/([\w.-]+\.md)$/.exec(segmentPath);
	if (!m || m[2] === undefined) return false;
	return FRAGMENT_RE.test(m[2]);
}
