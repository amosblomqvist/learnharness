/**
 * THE canonical prompt-segment discovery + override resolution (P2
 * reconciliation, 2026-09-19). The agent layer owns it because composition
 * lives here: composeInstructions (teacher-agent.ts) composes through
 * effectivePromptSegments, and the discovery reads THIS layer's own tree
 * (src/agent/prompts — base, shared/, per-agent fragments) — the exact
 * rules the pre-P2 loader used, now in one place.
 *
 * The architecture law pins the layout: the agent layer never imports the
 * store adapters, so the override-file READ lives here too (config-anchored
 * static file, same discipline as reading the source fragments); the
 * override-file CRUD (write/delete/list — the mutating store behind the
 * core port) stays in src/store/prompt-overrides.ts. Both sides share the
 * pure path grammar (src/core/prompt-segments.ts).
 *
 * SEGMENTS: the SHARED base (src/agent/system-prompt.md), then every
 * numeric-prefix *.md fragment in the agent's own directory (sorted by
 * filename), then the shared/ fragments directory (composed by BOTH
 * agents as a trailing appendix — the 2026-09-27 reorder). The segment
 * list adapts to the code: an override keyed to a segment the source no
 * longer ships stops composing automatically.
 *
 * OVERRIDES: override files mirror the source layout under
 * config.PROMPTS_OVERRIDE_DIR — "system-prompt.md" at the root,
 * "shared/<file>", "teacher/<file>" / "prober/<file>". File presence is NOT
 * the override: the settings SWITCH is (owner decision) — the user keeps
 * their file and flips back to the source default to compare.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS, PROMPTS_OVERRIDE_DIR } from "../../config.ts";
import { FRAGMENT_RE, isValidSegmentPath, type PromptAgent, type PromptSegmentInfo } from "../core/prompt-segments.ts";
import type { SessionReference } from "../core/contracts.ts";

const PROMPTS_DIR = path.join(PATHS.root, "src", "agent", "prompts");

/** Shared fragments the PRACTICE agent composes: the VOICE, ACCURACY,
 *  and MENTAL-MODEL chunks joined the formatting guide (owner rounds 13
 *  and the prompt-refinement round of 2026-10-07) — personality, the
 *  truth contract, and the thinking-fields doctrine are ONE law across
 *  every agent. The question/confidence/file mechanics stay out
 *  (practice has no such tools). */
const PRACTICE_SHARED_FRAGMENTS = ["10-voice.md", "15-accuracy.md", "16-mental-model.md", "40-formatting.md"];

/** Absolute path for an override file (unchecked — validate first). */
function overrideFileFor(segmentPath: string): string {
	return path.join(PROMPTS_OVERRIDE_DIR, ...segmentPath.split("/"));
}

/** Read one override file, or null when absent/invalid — the composition
 *  side's reader (the store's readOverride is the same mirror layout,
 *  kept separate because the layers may not import each other). */
export function readPromptOverride(segmentPath: string): string | null {
	if (!isValidSegmentPath(segmentPath)) return null;
	try {
		return fs.readFileSync(overrideFileFor(segmentPath), "utf-8");
	} catch {
		return null;
	}
}

/** List the SOURCE segments for one agent, in composition order — the
 *  shared base, then the agent's own fragments sorted by filename, then
 *  the shared/ fragments (the 2026-09-27 reorder: the agent's job and
 *  method lead; the shared tool/file/format mechanics are an appendix).
 *  The exact order composeInstructions composes them in. */
export function listSourceSegments(agent: PromptAgent): Array<{ path: string; shared: boolean; file: string }> {
	// PRACTICE (owner, 2026-10-04): its own directory plus a CURATED
	// shared appendix — the teaching base and the question/confidence/
	// file mechanics stay out (the doctrine contradicts them; 00-base.md
	// plays the base role), but the FORMATTING guide composes for every
	// agent (owner, 2026-10-04 late): LaTeX delimiters and markdown apply
	// in all settings — practice shares the $...$/$$...$$ authoring contract.
	const segments: Array<{ path: string; shared: boolean; file: string }> = agent === "practice" ? [] : [
		{ path: "system-prompt.md", shared: true, file: PATHS.teacherPrompt },
	];
	const dir = path.join(PROMPTS_DIR, agent);
	if (fs.existsSync(dir)) {
		const fragments = fs.readdirSync(dir).filter((f) => FRAGMENT_RE.test(f)).sort();
		for (const f of fragments) {
			segments.push({ path: `${agent}/${f}`, shared: false, file: path.join(dir, f) });
		}
	}
	const sharedDir = path.join(PROMPTS_DIR, "shared");
	if (fs.existsSync(sharedDir)) {
		// The practice allowlist (owner, 2026-10-04 late): formatting only.
		const allow = agent === "practice" ? PRACTICE_SHARED_FRAGMENTS : null;
		const sharedFragments = fs
			.readdirSync(sharedDir)
			.filter((f) => FRAGMENT_RE.test(f) && (allow === null || allow.includes(f)))
			.sort();
		for (const f of sharedFragments) {
			segments.push({ path: `shared/${f}`, shared: true, file: path.join(sharedDir, f) });
		}
	}
	return segments;
}

/**
 * The effective segment view for one agent — every segment with its source
 * text, override text, and effective switch state. `switches` is the
 * settings record's agent.prompts map (absent key = off); enabled =
 * switch on AND the override file exists.
 */
export function effectivePromptSegments(
	agent: PromptAgent,
	switches: Record<string, boolean>,
): PromptSegmentInfo[] {
	return listSourceSegments(agent).map((segment) => {
		let sourceText: string;
		try {
			sourceText = fs.readFileSync(segment.file, "utf-8");
		} catch {
			sourceText = ""; // source unreadable — the agent loader would crash anyway
		}
		const overrideText = readPromptOverride(segment.path);
		return {
			path: segment.path,
			sourceText,
			overrideText,
			enabled: switches[segment.path] === true && overrideText !== null,
			shared: segment.shared,
		};
	});
}

/** Every known segment path across both agents (route validation). */
export function allSegmentPaths(): string[] {
	const paths = new Set<string>();
	for (const agent of ["prober", "teacher", "practice"] as const) {
		for (const segment of listSourceSegments(agent)) paths.add(segment.path);
	}
	return [...paths].sort();
}

// ─── Session references (issue #63) ──────────────────────────────────────────

/** The per-session grounding shelf's prompt segment (issue #63) — a DYNAMIC
 *  segment, unlike the static-file segments above: composed per turn from
 *  ChatRecord.references and appended to every agent's instructions (see
 *  teacher-agent.ts baseAgentOptions) exactly when the shelf is non-empty.
 *
 *  Honest about the toolset (the investigation record, 2026-11-09): the
 *  conversation agents have NO direct web_fetch — web_fetch belongs to the
 *  researcher sub-agent (src/agent/tools/web.ts), reachable only through
 *  the async research dispatch, whose input is a question the URL rides
 *  in. The wording says so instead of pretending a fetch tool exists.
 *  File values point IN PLACE (the path-attachment doctrine: no upload,
 *  no copy) — the read tool for text/images, the pdf dispatch for PDFs,
 *  all under the ordinary file-access guards. */
export function sessionReferencesSegment(references: readonly SessionReference[]): string | null {
	if (references.length === 0) return null;
	const lines = references.map((reference) => {
		const label = reference.name ? `${reference.name} — ${reference.value}` : reference.value;
		return reference.kind === "file"
			? `- ${label} (use the read tool for text and image files; use the pdf tool for PDFs)`
			: `- ${label} (you have no direct fetch tool: dispatch the research tool with a question about this page — the researcher can fetch it, and fetching needs no search key)`;
	});
	return [
		"Reference materials for this session (consult them when precision matters; cite the source when you use them):",
		...lines,
		"These ground your explanations and problems in the learner's chosen sources; the learner's goal still sets the direction. Ordinary file-access guards apply to file reads.",
	].join("\n");
}
