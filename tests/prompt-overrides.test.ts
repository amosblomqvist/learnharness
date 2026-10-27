/**
 * Tests for the prompt-override store (settings-storage wave, 2026-09-19):
 * src/store/prompt-overrides.ts — override file CRUD, the mirror-layout
 * path discipline (traversal guard), and the SOURCE-DERIVED segment list
 * (the loader mirrors teacher-agent.ts's composeInstructions discovery;
 * these tests pin that the mirror tracks the real src/agent/prompts tree).
 *
 * TEST-DIR ISOLATION (contract fix, interlude 2026-09-26): data/prompts
 * holds REAL user override files — this suite must never touch it (the
 * old after() wiped it as "disposable scratch", killing real overrides
 * and orphaning their ON switches). LH_DATA_DIR is the established
 * data-location seam (Electron contract, 2026-09-17; see
 * data-dir-seam.test.ts), evaluated at config.ts's MODULE LOAD — so it
 * must be set before the first import that (transitively) loads config.
 * Every app-module import below is dynamic for exactly that reason;
 * only node builtins and config-independent libs stay static. The seam
 * pins at the bottom assert the redirection, and after() snapshots that
 * the REAL repo data/prompts survived the suite untouched.
 *
 * This file OWNS the temp dir (parallel-test discipline: one fs owner
 * per file) — every override-writing test lives here, including the
 * route-level contract pins for the same interlude (delete-clears-switch,
 * orphaned-ON-heals-to-OFF).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-prompt-overrides-"));
process.env.LH_DATA_DIR = TMP_DATA;

const PROMPTS_OVERRIDE_DIR = (await import("../config.ts")).promptsOverrideDir();
const teacherAgent = await import("../src/agent/teacher-agent.ts");
const { allSegmentPaths, effectivePromptSegments } = await import("../src/agent/prompt-segments.ts");
const { isValidSegmentPath } = await import("../src/core/prompt-segments.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");
// Route-level pins drive the actual app/api handlers (framework-free
// Request/Response), isolated under the same temp LH_DATA_DIR.
const { PUT: putSettingsSection } = await import("../app/api/settings/[section]/route.ts");
const { DELETE: deletePromptText } = await import("../app/api/settings/prompts/[...segment]/route.ts");
const { readSettingsRecord } = await import("../src/server/index.ts");

/** The REAL repo prompts dir this suite must never touch (read-only). */
const REPO_PROMPTS = path.resolve(import.meta.dirname, "../data/prompts");

/** Read-only recursive snapshot of a dir (sorted "rel|size" lines) — the
 *  survival pin compares before/after the whole suite. */
function snapshotDir(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (rel: string) => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(child);
			else out.push(`${child}|${fs.statSync(path.join(dir, child)).size}`);
		}
	};
	walk("");
	return out;
}
const REAL_PROMPTS_BEFORE = snapshotDir(REPO_PROMPTS);

after(() => {
	// The suite's own scratch dies; the REAL user dir must be untouched.
	assert.deepEqual(
		snapshotDir(REPO_PROMPTS),
		REAL_PROMPTS_BEFORE,
		"real data/prompts survives npm test byte-for-byte (the old suite wiped it)",
	);
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

/** A scripted pi engine (pi-ai's faux provider) — the agent build needs an
 *  injected engine since BYOK removed the factory pins (owner, 2026-09-22). */
function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** PUT /api/settings/<section> with a fabricated params context. */
function putSection(section: string, body: unknown): Promise<Response> {
	return putSettingsSection(
		new Request(`http://test/api/settings/${section}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ section }) },
	);
}

/** DELETE /api/settings/prompts/<segment...> with a fabricated params context. */
function deleteSegment(segment: string[]): Promise<Response> {
	return deletePromptText(new Request("http://test/api/settings/prompts", { method: "DELETE" }), {
		params: Promise.resolve({ segment }),
	});
}

describe("isValidSegmentPath (the mirror-layout discipline)", () => {
	it("accepts the shared base and numeric fragments, rejects everything else", () => {
		assert.equal(isValidSegmentPath("system-prompt.md"), true);
		assert.equal(isValidSegmentPath("teacher/20-teaching.md"), true);
		assert.equal(isValidSegmentPath("prober/10-probe-doctrine.md"), true);
		// the shared/ fragments dir (sources v1): composed by BOTH agents,
		// overridable like any other segment
		assert.equal(isValidSegmentPath("shared/10-personality.md"), true);
		for (const bad of [
			"", // empty
			"README.md", // no agent dir
			"teacher/README.md", // not numeric-prefixed
			"teacher/20-teaching.txt", // not .md
			"../system-prompt.md", // traversal
			"agent/../teacher/20-teaching.md", // traversal
			"/etc/passwd", // absolute
			"teacher", // bare dir
			"teacher/", // bare dir
			"teacher/sub/10-x.md", // nested (not the mirror layout)
			"prober\\10-x.md", // backslash
		]) {
			assert.equal(isValidSegmentPath(bad), false, bad);
		}
	});
});

describe("the override store", () => {
	it("listOverrides is empty with no dir, then lists written mirrors sorted", () => {
		fs.rmSync(PROMPTS_OVERRIDE_DIR, { recursive: true, force: true });
		assert.deepEqual(promptOverrides.listOverrides(), []);
		promptOverrides.writeOverride("teacher/20-teaching.md", "custom teaching");
		promptOverrides.writeOverride("system-prompt.md", "custom base");
		assert.deepEqual(promptOverrides.listOverrides(), ["system-prompt.md", "teacher/20-teaching.md"]);
	});

	it("readOverride round-trips; delete removes idempotently; invalid paths no-op", () => {
		promptOverrides.writeOverride("prober/30-probe-done.md", "custom probe-done");
		assert.equal(promptOverrides.readOverride("prober/30-probe-done.md"), "custom probe-done");
		promptOverrides.deleteOverride("prober/30-probe-done.md");
		assert.equal(promptOverrides.readOverride("prober/30-probe-done.md"), null);
		promptOverrides.deleteOverride("prober/30-probe-done.md"); // again: no throw
		// traversal junk never reaches disk
		promptOverrides.writeOverride("../evil.md", "nope");
		assert.equal(fs.existsSync(path.join(PROMPTS_OVERRIDE_DIR, "..", "evil.md")), false);
	});

	it("switches are NOT the store's concern — files alone never enable", () => {
		promptOverrides.writeOverride("system-prompt.md", "custom base");
		const off = effectivePromptSegments("teacher", {}) // no switches
			.find((s) => s.path === "system-prompt.md");
		assert.ok(off);
		assert.equal(off.overrideText, "custom base"); // file exists...
		assert.equal(off.enabled, false); // ...but no switch → source default
		promptOverrides.deleteOverride("system-prompt.md"); // leave clean for the sibling tests
	});
});

describe("the source-derived segment list", () => {
	it("mirrors composeInstructions' discovery: base first, numeric fragments sorted, per agent", () => {
		const prober = effectivePromptSegments("prober", {});
		const teacher = effectivePromptSegments("teacher", {});
		// The shared base composes both prompts, SAME path.
		assert.equal(prober[0]?.path, "system-prompt.md");
		assert.equal(teacher[0]?.path, "system-prompt.md");
		assert.equal(prober[0].shared, true);
		assert.equal(teacher[0].shared, true);
		assert.equal(prober[0].sourceText.length > 0, true, "base prompt text loads");
		// Fragments track the REAL source tree (numeric order, right agent dir),
		// the agent's OWN fragments between the base and the shared/ appendix —
		// the exact order composeInstructions loads them in (reorder, 2026-09-27:
		// job and method lead, mechanics trail).
		assert.deepEqual(
			prober.map((s) => s.path),
			[
				"system-prompt.md",
				"prober/10-probe-doctrine.md",
				"shared/10-voice.md",
				"shared/15-accuracy.md",
				"shared/16-mental-model.md",
				"shared/20-question-tools.md",
				"shared/25-confidence.md",
				"shared/30-learner-files.md",
				"shared/40-formatting.md",
			],
		);
		assert.equal(teacher.some((s) => s.path === "teacher/05-method.md"), true);
		assert.equal(teacher.some((s) => s.path === "teacher/10-planning.md"), true);
		assert.equal(teacher.some((s) => s.path === "teacher/60-probing-in-brief.md"), false);
		assert.equal(
			teacher.every(
				(s) => s.path === "system-prompt.md" || s.path.startsWith("teacher/") || s.path.startsWith("shared/"),
			),
			true,
		);
		// the shared fragments compose for BOTH agents, same path key.
		assert.equal(teacher.some((s) => s.path === "shared/30-learner-files.md" && s.shared), true);
		assert.equal(prober.some((s) => s.path === "shared/30-learner-files.md" && s.shared), true);
		// Voice + accuracy moved BACK to shared/ fragments (owner round 13,
		// 2026-10-05): one law across every agent — including practice, whose
		// near-copy had drifted stale ("You have no research tool here").
		assert.equal(prober.some((s) => s.path === "shared/10-voice.md" && s.shared), true);
		assert.equal(teacher.some((s) => s.path === "shared/10-voice.md" && s.shared), true);
		assert.equal(prober.some((s) => s.path === "shared/15-accuracy.md" && s.shared), true);
		// Tool MECHANICS are shared; question METHODOLOGY is phase-owned.
		assert.equal(prober.some((s) => s.path.startsWith("teacher/")), false);
		assert.equal(teacher.some((s) => s.path.startsWith("prober/")), false);
		// README and other non-numeric files never load.
		assert.equal(allSegmentPaths().some((p) => p.includes("README")), false);
	});

	it("effective segments: switch+file → override; either missing → source text", () => {
		promptOverrides.writeOverride("teacher/20-teaching.md", "MY WAY");
		const switches = { "teacher/20-teaching.md": true, "system-prompt.md": false };
		const teacher = effectivePromptSegments("teacher", switches);
		const teaching = teacher.find((s) => s.path === "teacher/20-teaching.md");
		assert.ok(teaching);
		assert.equal(teaching.overrideText, "MY WAY");
		assert.equal(teaching.enabled, true);
		// base: switch OFF with file ABSENT → source, disabled
		const base = teacher.find((s) => s.path === "system-prompt.md");
		assert.ok(base);
		assert.equal(base.overrideText, null);
		assert.equal(base.enabled, false);
		// a switch for a segment with NO override file never enables it
		const weird = effectivePromptSegments("teacher", { "teacher/10-planning.md": true });
		const planning = weird.find((s) => s.path === "teacher/10-planning.md");
		assert.ok(planning);
		assert.equal(planning.enabled, false);
		assert.equal(planning.overrideText, null);
	});

	it("adapts to source changes by construction: the list is computed, not stored", () => {
		// If a fragment vanishes upstream, its switch/override simply stop
		// composing — nothing here can go stale. Pinned by absence:
		const before = allSegmentPaths().length;
		assert.equal(before > 5, true, "base + prober fragments + teacher fragments");
	});
});

// ─── composeInstructions honors overrides (P2 reconciliation, 2026-09-19) ────
// This file OWNS the (isolated) PROMPTS_OVERRIDE_DIR (parallel-test
// discipline), so every override-writing composition test lives here.

describe("composeInstructions: override honoring + the byte-identical source path", () => {
	const { composeInstructions, createTeacherAgent } = teacherAgent;

	it("switches-less composition is byte-identical to the pre-refactor loader", () => {
		// The plain loader, rebuilt inline: base + the agent's own
		// fragments + the shared/ appendix (the 2026-09-27 reorder),
		// trimmed, empties dropped, joined with the separator.
		const oldLoader = (kind: "prober" | "teacher") => {
			const fragmentsOf = (dir: string) =>
				fs
					.readdirSync(dir)
					.filter((f) => /^\d+-[\w.-]+\.md$/.test(f))
					.sort()
					.map((f) => fs.readFileSync(path.join(dir, f), "utf-8").trim())
					.filter(Boolean);
			const base = fs.readFileSync("src/agent/system-prompt.md", "utf-8").trim();
			return [
				base,
				...fragmentsOf(`src/agent/prompts/${kind}`),
				...fragmentsOf("src/agent/prompts/shared"),
			].join("\n\n---\n\n");
		};
		assert.equal(composeInstructions("teacher"), oldLoader("teacher"));
		assert.equal(composeInstructions("prober"), oldLoader("prober"));
	});

	it("an enabled override swaps in; switch off or file absent composes source", () => {
		promptOverrides.writeOverride("teacher/20-teaching.md", "CUSTOM TEACHING LOOP");
		try {
			const on = composeInstructions("teacher", { "teacher/20-teaching.md": true });
			assert.ok(on.includes("CUSTOM TEACHING LOOP"), "override composes when switch on");
			assert.ok(!on.includes("# Teach — one step at a time"), "source text is replaced");
			// switch off → source default (the file stays on disk)
			const off = composeInstructions("teacher", {});
			assert.ok(off.includes("# Teach — one step at a time"), "source composes when switch off");
			// switch on for a segment with NO file → source (enabled needs both)
			const noFile = composeInstructions("teacher", { "teacher/10-planning.md": true });
			assert.ok(noFile.includes("# Planning"), "file absent → source default");
		} finally {
			promptOverrides.deleteOverride("teacher/20-teaching.md");
		}
	});

	it("shared/ fragments are overridable — one edit swaps the doctrine in BOTH agents", () => {
		promptOverrides.writeOverride("shared/30-learner-files.md", "MY SHARED FILES DOCTRINE");
		try {
			const switches = { "shared/30-learner-files.md": true };
			for (const kind of ["teacher", "prober"] as const) {
				const composed = composeInstructions(kind, switches);
				assert.ok(composed.includes("MY SHARED FILES DOCTRINE"), `${kind} composes the override`);
				assert.ok(!composed.includes("## Learner files"), `${kind} source fragment is replaced`);
			}
			// switches-less: both keep the source fragment (the cached path)
			assert.ok(composeInstructions("teacher").includes("## Learner files"));
		} finally {
			promptOverrides.deleteOverride("shared/30-learner-files.md");
		}
	});

	it("promptSwitches threads through agent construction into the system prompt", () => {
		promptOverrides.writeOverride("system-prompt.md", "TOTALLY CUSTOM BASE");
		try {
			// BYOK (owner, 2026-09-22): no factory pins — the agent build needs
			// an injected engine; a scripted faux one stands in (the prompt is
			// what's under test here, not the model).
			const engine = fauxEngine();
			const agent = createTeacherAgent(undefined, { engine, promptSwitches: { "system-prompt.md": true } });
			assert.ok(agent.state.systemPrompt.includes("TOTALLY CUSTOM BASE"));
			const source = createTeacherAgent(undefined, { engine });
			assert.ok(!source.state.systemPrompt.includes("TOTALLY CUSTOM BASE"), "no switches → cached source");
		} finally {
			promptOverrides.deleteOverride("system-prompt.md");
		}
	});
});

// ─── the orphan-heal contract (interlude, 2026-09-26) ────────────────────────
// The orphan-400 trap: an ON switch whose file dies orphaned the record;
// every agent-section write then 400'd while the disabled toggle couldn't
// reach the OFF escape hatch — a user stuck unable to write settings.
// Fix: the delete route clears the switch by construction, AND the write
// path heals any orphan that still arises (disk wipes outside the app).

describe("delete clears the switch — the record and file agree by construction", () => {
	const SEGMENT = "teacher/20-teaching.md";

	it("DELETE removes the file AND clears the on-switch in one operation", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		const on = await putSection("agent", { prompts: { [SEGMENT]: true } });
		assert.equal(on.status, 200, "ON with a real file is valid");
		assert.equal(readSettingsRecord()?.agent?.prompts?.[SEGMENT], true, "switch landed in the record");

		const res = await deleteSegment(["teacher", "20-teaching.md"]);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { deleted: boolean; switchCleared: boolean };
		assert.deepEqual(body, { path: SEGMENT, deleted: true, switchCleared: true }, "the response names what happened");

		assert.equal(readSettingsRecord()?.agent?.prompts?.[SEGMENT], undefined, "the switch is GONE from the record");
		assert.equal(promptOverrides.readOverride(SEGMENT), null, "the file is gone");
		// And the trap's step 4 — flipping any tool toggle afterwards —
		// just works (nothing orphaned to mirror):
		const followUp = await putSection("agent", { tools: { research: false } });
		assert.equal(followUp.status, 200, "a subsequent agent write succeeds");
		assert.equal(readSettingsRecord()?.agent?.tools?.research, false);
	});

	it("DELETE is idempotent for file and switch — nothing to clear, still 200", async () => {
		const res = await deleteSegment(["teacher", "20-teaching.md"]);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { switchCleared: boolean };
		assert.equal(body.switchCleared, false, "no switch was present — nothing cleared");
	});
});

describe("an orphaned ON heals to OFF on write — never a 400 (the invariant: a user can never get stuck)", () => {
	const SEGMENT = "teacher/20-teaching.md";

	it("the exact repro: file wiped at disk level → UI mirrors the orphan and flips a tool toggle → the write SUCCEEDS and heals", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		const on = await putSection("agent", { prompts: { [SEGMENT]: true } });
		assert.equal(on.status, 200);

		// The disk-level wipe — OUTSIDE the app (the delete route now clears
		// the switch, so this is the only way an orphan still arises).
		fs.rmSync(path.join(PROMPTS_OVERRIDE_DIR, "teacher", "20-teaching.md"));

		// The exact trap shape: the client mirrors the record's orphaned ON
		// while writing an unrelated tool toggle. Today (pre-fix) → 400 forever.
		const res = await putSection("agent", { tools: { research: false }, prompts: { [SEGMENT]: true } });
		assert.equal(res.status, 200, "the write heals instead of 400-ing — the user is never stuck");

		const record = readSettingsRecord();
		assert.equal(record?.agent?.prompts?.[SEGMENT], undefined, "the orphaned ON landed as OFF (key dropped)");
		assert.equal(record?.agent?.tools?.research, false, "the rest of the write landed — nothing was silently dropped");

		// And the SECOND write (the "400 forever" of the trap) succeeds too:
		const again = await putSection("agent", { tools: { research: false }, prompts: { [SEGMENT]: true } });
		assert.equal(again.status, 200, "repeated writes keep succeeding");
	});

	it("an ON for a segment that left the source tree heals the same way", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		// A vanished-fragment orphan: the switch keys a path that is no
		// longer a current source segment (simulate by keying junk that the
		// store never guarded — the record is the only place it exists).
		const on = await putSection("agent", { prompts: { "teacher/99-vanished.md": true, [SEGMENT]: true } });
		assert.equal(on.status, 200, "vanished-fragment ON heals too, not a 400");
		assert.equal(readSettingsRecord()?.agent?.prompts?.["teacher/99-vanished.md"], undefined, "the vanished key healed to OFF");
		promptOverrides.deleteOverride(SEGMENT);
	});

	it("a VALID ON (file present) stays valid — no heal, no 400", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		try {
			const res = await putSection("agent", { prompts: { [SEGMENT]: true } });
			assert.equal(res.status, 200);
			const record = (await res.json()) as { settings: { agent?: { prompts?: Record<string, boolean> } } };
			assert.equal(record.settings.agent?.prompts?.[SEGMENT], true, "a real ON+file write keeps the switch on");
		} finally {
			promptOverrides.deleteOverride(SEGMENT);
		}
	});
});

describe("test isolation (the suite must never touch real user data)", () => {
	it("every write this suite makes lands under the LH_DATA_DIR seam, not the repo data dir", () => {
		assert.ok(
			PROMPTS_OVERRIDE_DIR.startsWith(TMP_DATA),
			`PROMPTS_OVERRIDE_DIR (${PROMPTS_OVERRIDE_DIR}) must live under the temp seam (${TMP_DATA})`,
		);
		assert.notEqual(
			PROMPTS_OVERRIDE_DIR,
			REPO_PROMPTS,
			"the seam must NOT resolve to the repo's real data/prompts",
		);
		// The suite proves it writes here:
		promptOverrides.writeOverride("system-prompt.md", "isolation probe");
		assert.equal(
			fs.existsSync(path.join(TMP_DATA, "prompts", "system-prompt.md")),
			true,
			"the write landed under the temp dir",
		);
		promptOverrides.deleteOverride("system-prompt.md");
	});
});
