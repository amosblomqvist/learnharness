/**
 * GOLDEN FIXTURES (owner ruling, 2026-10-10): real user data, verbatim,
 * read through the PRODUCTION read paths. tests/fixtures/golden-data/ is a
 * real data dir (see its README); this suite copies it to a temp dir, points
 * the stores at it via the LH_DATA_DIR seam (set BEFORE any config-loading
 * import — every app-module import is dynamic), and asserts:
 *
 *   1. every record parses and passes the contract folds the app itself
 *      runs (phases, pending questions/problems, plan tree, summaries);
 *   2. the LLM wire flattening (toLlmMessages) turns each full record into
 *      a legal provider message list — the strongest property a record has;
 *   3. the graph derivation builds from the real ledgers end-to-end;
 *   4. marker COVERAGE: every custom-marker kind of the current contract
 *      appears in real data here (a new marker without a fixture update
 *      fails this suite);
 *   5. reads are READ-ONLY: after everything above, the copy is
 *      byte-identical to the fixture source.
 *
 * THE FIXTURE LAW: an intentional format change updates the fixtures in the
 * same commit; an unintentional one fails here.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, "fixtures", "golden-data");

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-golden-"));
fs.cpSync(GOLDEN, TMP, { recursive: true });
process.env.LH_DATA_DIR = TMP;

const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { readRenderSettings } = await import("../src/store/render-settings.ts");
const { getGraph, deriveView } = await import("../src/core/graph.ts");
const { sanitizeRenderSettings } = await import("../src/core/render-settings.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
const { phaseAt3Lh } = await import("../src/core/phases.ts");
const { danglingQuestionOf, activeProblemOf } = await import("../src/core/native-messages.ts");

const TEACH = "chat_mv27rrra_feff23b6";
const PRACTICE = "chat_mv293wv5_10656952";

function snapshotTree(dir: string): Map<string, Buffer> {
	const out = new Map<string, Buffer>();
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		const st = fs.statSync(p);
		if (st.isDirectory()) for (const [k, v] of snapshotTree(p)) out.set(`${name}/${k}`, v);
		else out.set(name, fs.readFileSync(p));
	}
	return out;
}
const BEFORE = snapshotTree(TMP);

test.after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

// ── chats: records, folds, and the wire ─────────────────────────────────────

test("chats: both fixture records parse through the production read path", () => {
	const list = chatStore.listChats();
	const ids = new Set(list.map((c) => c.id));
	assert.ok(ids.has(TEACH), "the teach master record lists");
	assert.ok(ids.has(PRACTICE), "the practice lifecycle record lists");

	for (const id of [TEACH, PRACTICE]) {
		const r = chatStore.getChat(id);
		assert.ok(r, `${id} reads`);
		assert.ok(Array.isArray(r!.messages) && r!.messages.length > 0);
		// the folds the app itself runs per render/turn:
		assert.equal(typeof phaseAt3Lh(r!.messages), "string", "the phase fold runs clean");
		assert.equal(danglingQuestionOf(r!.messages), null, "no dangling question tool call");
		activeProblemOf(r!.messages); // must not throw
	}
});

test("chats: the LLM wire flattening turns each full record into a legal provider message list", () => {
	for (const id of [TEACH, PRACTICE]) {
		const r = chatStore.getChat(id)!;
		const wire = toLlmMessages(r.messages as never);
		assert.ok(wire.length > 0);
		for (const m of wire) {
			assert.ok(["system", "user", "assistant", "toolResult"].includes(m.role), `legal role ${m.role} in ${id}`);
			// every toolResult answers a call that appeared BEFORE it
			if (m.role === "toolResult") {
				const t = m as { toolCallId: string };
				assert.ok(
					wire.some((w) => w.role === "assistant" && JSON.stringify(w).includes(t.toolCallId)),
					`toolResult ${t.toolCallId} has its calling assistant message`,
				);
			}
		}
		// no assistant toolCall left unanswered (the dangling-call synthesis covers aborts)
		const answered = new Set(wire.filter((w) => w.role === "toolResult").map((w) => (w as { toolCallId: string }).toolCallId));
		for (const m of wire) {
			if (m.role !== "assistant") continue;
			for (const b of (m as { content: Array<{ type: string; id?: string }> }).content) {
				if (b.type === "toolCall" && b.id) assert.ok(answered.has(b.id), `call ${b.id} is answered on the wire`);
			}
		}
	}
});

test("markers: the fixture pair covers EVERY custom-marker kind of the current contract", () => {
	// The coverage law: a new customType added to the contract without real
	// fixture data fails here — extend the fixtures in the same commit.
	const EXPECTED = [
		"graph-context",
		"probe-handoff",
		"subagent-steer",
		"subagent-abort",
		"plan-block",
		"practice-thinking",
		"practice-next",
		"problem-dismissed",
		"compaction",
	] as const;
	const seen = new Set<string>();
	for (const id of [TEACH, PRACTICE]) {
		for (const m of chatStore.getChat(id)!.messages) {
			if ((m as { role?: string }).role === "custom") seen.add((m as { customType: string }).customType);
		}
	}
	for (const kind of EXPECTED) assert.ok(seen.has(kind), `marker ${kind} appears in real fixture data`);
});

test("tools: the core tool surface appears in real fixture data", () => {
	// A living inventory, not an exhaustive pin: teach tools in the teach
	// record, practice tools in the practice record. New TOOLS don't fail
	// this (they fail their own suites) — the pinned CORE set must simply
	// stay representable in real records.
	const teachTools = new Set<string>();
	const practiceTools = new Set<string>();
	for (const m of chatStore.getChat(TEACH)!.messages) {
		for (const b of (m as { content?: Array<{ type?: string; name?: string }> }).content ?? []) {
			if (b.type === "toolCall" && b.name) teachTools.add(b.name);
		}
	}
	for (const m of chatStore.getChat(PRACTICE)!.messages) {
		for (const b of (m as { content?: Array<{ type?: string; name?: string }> }).content ?? []) {
			if (b.type === "toolCall" && b.name) practiceTools.add(b.name);
		}
	}
	for (const t of ["quiz", "ask_user_question", "plan_init", "probe_done", "recall", "explain", "research", "demo", "visual", "pdf"]) {
		assert.ok(teachTools.has(t), `teach tool ${t} exercised in the fixture record`);
	}
	for (const t of ["problem", "conclude"]) {
		assert.ok(practiceTools.has(t), `practice tool ${t} exercised in the fixture record`);
	}
});

// ── the graph: ledgers through the full derivation ──────────────────────────

test("graph: the real ledgers parse through their shape guards", () => {
	assert.ok(graphStore.readNodes().length >= 250, "nodes parse");
	assert.ok(graphStore.readChains().length >= 150, "chains parse");
	assert.ok(graphStore.readCheckpoints().length >= 5, "session checkpoints parse");
	assert.ok(graphStore.readCoverage().length >= 90, "coverage entries parse");
	assert.ok(graphStore.readSources().length >= 1, "imported-notes sources parse");
});

test("graph: getGraph + deriveView build the snapshot end-to-end", () => {
	const derived = getGraph(graphStore);
	assert.ok(derived.nodes.length >= 250, "merged nodes");
assert.ok(derived.chains.length >= 150, "chains survive derivation");
	const view = deriveView(derived);
	assert.ok(view.nodes.length >= 250, "the view carries every proposition");
	// chains are the stored truth; the view renders each as an implication
	// node with premise→implication→conclusion arrows (the derived image),
	// and contracts each to direct premise→conclusion LOGICAL edges.
	assert.ok(view.impLinks.length >= 90, "every unique chain renders into the view (lines merged by premises+conclusion)");
	assert.ok(view.edges.length >= view.impLinks.length, "premise/conclusion arrows drawn");
	assert.ok(view.logicalEdges.length > 0, "logical edge contraction runs");
});

test("graph: render-settings sanitize and positions parse", () => {
	const raw = readRenderSettings();
	assert.ok(raw, "render-settings.json reads");
	const clean = sanitizeRenderSettings(raw);
	assert.ok(clean.nodeSize > 0 && typeof clean.labelZoom === "number", "sanitizes to concrete knobs");
	const positionsFile = JSON.parse(fs.readFileSync(path.join(TMP, "graph", "positions.json"), "utf8")) as {
		positions: Record<string, unknown>;
	};
	assert.ok(Object.keys(positionsFile.positions).length >= 300, "positions parse");
});

// ── jobs + settings ─────────────────────────────────────────────────────────

test("jobs: the kind × status matrix parses through the job store", () => {
	const kinds = new Set<string>();
	const statuses = new Set<string>();
	for (const f of fs.readdirSync(path.join(GOLDEN, "jobs"))) {
		const id = f.replace(/\.json$/, "");
		const j = jobStore.getJob(id);
		assert.ok(j, `${id} reads through the job store`);
		assert.ok(["research", "demo", "visual", "pdf"].includes(j!.kind), `${id}: known kind`);
		assert.ok(["done", "error"].includes(j!.status), `${id}: terminal status`);
		kinds.add(j!.kind);
		statuses.add(j!.status);
	}
	assert.deepEqual([...kinds].sort(), ["demo", "pdf", "research", "visual"], "every job kind is fixture-d");
	assert.deepEqual([...statuses].sort(), ["done", "error"], "both terminal statuses are fixture-d");
});

test("settings: the stamped record parses", () => {
	const s = settingsStore.readSettings();
	assert.ok(s, "settings record reads");
	assert.equal(s!.version, 1, "settings carry their version stamp");
	assert.ok(s!.models && typeof s!.models === "object", "model slots present");
});

// ── read-only: readers never write ──────────────────────────────────────────

test("read-only: after every read above, the data dir is byte-identical to the fixture source", () => {
	const after = snapshotTree(TMP);
	assert.deepEqual([...after.keys()].sort(), [...BEFORE.keys()].sort(), "no files added or removed");
	for (const [name, buf] of after) {
		assert.ok(BEFORE.has(name), `${name} existed before`);
		assert.deepEqual(buf, BEFORE.get(name), `${name} unchanged by reads`);
	}
});
