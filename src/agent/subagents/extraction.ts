import * as crypto from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { toToolResult } from "../tool-execute.ts";
import type { ModelRole } from "../../../config.ts";
import {
	FACTORY_SETTINGS,
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	ROLE_SLOT,
	type ModelSlotName,
	type ProviderKeyMissing,
} from "../../core/settings.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";
import type {
	AuditVerdicts,
	CallUsage,
	ChatRecord,
	ExtractionRunUsage,
	ExtractionStageUsage,
	SessionFindings,
} from "../../core/contracts.ts";
import { getGraph, mergeFindings, type DerivedGraph, type EmissionStats, type GraphDeps } from "../../core/graph.ts";
import type { GraphStore } from "../../core/ports.ts";
import { emit } from "../../core/events.ts";
import { settleGraphLayout } from "../../core/layout-settle.ts";
import { batchRuns, coverageOf, messageViewLines } from "../../core/coverage.ts";
import { failedOutputCallIds, type LhMessage } from "../../core/native-messages.ts";
import { auditorGraphTools } from "../tools/graph.ts";
import { runSubmitAgent, healStringifiedArrays } from "./submit-agent.ts";

/**
 * The extraction pipeline (vision §1 construction, 2026-09-02 redesign;
 * relinked 2026-09-27) — the sole graph writer. Three stages, one
 * orchestrator (the spine stage came and went, 2026-09-30: serialized
 * digest-aware extraction replaced it — the owner's live test showed
 * the post-hoc assembly pass added complexity without perceptible
 * gain; the extractor itself is the assembler now):
 *
 *   extractor (LLM)  the ONE stage that sees the raw source (a session
 *                    rendered as the teacher's prose — each passage
 *                    labeled with its ACTUAL message id, "TEACHER [id]",
 *                    owner 2026-10-13 — or a notes file verbatim, walked
 *                    in stretches) → submits NEW core ideas + reasoning
 *                    chains (owner redesign, 2026-09-30); a session
 *                    submit additionally carries each proposition's
 *                    messageId — the anchor the merger stamps into the
 *                    node's message-granular provenance (2026-10-13).
 *                    DIGEST-AWARE (2026-09-30 evening):
 *                    when the source already yielded material, the
 *                    prompt carries THE GRAPH SO FAR (that source's
 *                    propositions + chains, ids verbatim) and the
 *                    extractor builds on it — referencing existing ids
 *                    instead of restating, leaning on established
 *                    conclusions as premises. Stretches of one source
 *                    run SERIALLY (each extract reads every earlier
 *                    merge); tree-blind, FULLY TRUSTED — nothing
 *                    downstream re-checks it.
 *   auditor (LLM)    never sees the source. Its job is IDENTITY: for each
 *                    NEW proposition, linkTo an existing graph node or
 *                    create — decided by EXPLORING the graph through
 *                    tools (find / list_sessions / list_propositions),
 *                    not by an injected graph dump (context bloat,
 *                    owner 2026-09-27). Links are its ONLY deliverable
 *                    — it never mints edges (owner 2026-09-28: the
 *                    graph connects across sources solely through
 *                    identified equivalences). Input is PROPOSITIONS
 *                    only — never chains (owner 2026-09-30).
 *   merger (core)    mergeFindings() → deterministic ledger appends +
 *                    chain simplification (2026-09-30 evening: the
 *                    ancestry-cover / prefer-fewest-premises pass that
 *                    strips redundant derivations — core/graph.ts)
 *
 * The events ledger is GONE (2026-09-27): quiz outcomes and understanding
 * observations are no longer formalized in the graph — the graph is purely
 * extracted reasoning chains (nodes + edges).
 *
 * The extractor is a single-tool-call worker (one TypeBox-validated submit
 * call — a pi agent purely so the model can retry a schema-invalid call).
 * The auditor is a small AGENTIC loop: exploration tools plus one submit.
 *
 * Created via createExtractionPipeline(deps) — the composition root
 * (chat-handler) injects the storage ports + models; this module never
 * imports an adapter. runExtraction is single-flight per chat: a second
 * trigger while one run is in flight is a no-op (the next trigger picks up
 * whatever the in-flight run missed). On failure nothing is checkpointed —
 * the next trigger re-runs the whole thing.
 *
 * The FORMAT-AGNOSTIC FRONT DOOR (2026-09-13): importNotes() runs the SAME
 * three stages over raw personal notes (arbitrary format — no chat, no
 * session, no message ids). A notes-mode extractor prompt replaces the
 * session one; the auditor and merger are shared (identity + deterministic
 * appends don't care where text came from). Provenance is the file itself:
 * source ids ("src_" + path hash) play the chatId role in mappings and
 * checkpoints, and the source record (graphStore sources seam) carries
 * the file path + the run's usage.
 *
 * Observability (§5 baseline): every stage logs one line per step, its
 * start, and its duration; the pipeline logs a failure line before
 * rethrowing, so the server log reads start → stage timings → merged
 * stats (or failed) for every run.
 */

// ─── the source view (what the extractor sees) ──────────────────────────────

/**
 * The extraction view: the session as TEACHER PROSE ONLY (owner ruling,
 * 2026-09-28 — supersedes the 2026-09-27 whole-session markdown view),
 * each passage labeled with its actual message id (2026-10-13). The
 * shared markdown engine (core/session-markdown.ts) keeps the full session
 * format for the future user-facing export; the extractor no longer uses
 * it.
 */

/** The whole-record view (used by callers that render a full session;
 *  the pipeline itself batches). TEACHER PROSE ONLY (owner, 2026-09-28),
 *  passages labeled with their message ids (2026-10-13).
 */
export function transcriptView(record: ChatRecord): string {
	return proseView(record.messages, record.title);
}

/** The extraction view under the teacher-prose ruling (owner, 2026-09-28):
 *  ONLY learner-facing teacher prose (text or send_to_user) — no learner
 *  messages, thinking, other tool calls/results, or quiz blocks — labeled with
 *  its ACTUAL message id (owner, 2026-10-13): the view lines ARE
 *  core/coverage.ts messageViewLines ("TEACHER [id] text"), the exact
 *  lines the coverage fingerprints hash, so the extractor can anchor
 *  every proposition to the passage it came from (the session submit's
 *  required messageId). The shared markdown engine stays reserved for the
 *  future user-facing export. */
function proseView(
	messages: ReadonlyArray<LhMessage>,
	title?: string,
	failedOutputCalls: ReadonlySet<string> = failedOutputCallIds(messages),
): string {
	const lines = messages.flatMap((message) => messageViewLines(message, message.id, failedOutputCalls));
	const head = title && title.length > 0 ? `# ${title}\n\n` : "";
	return head + lines.join("\n\n");
}

// ─── the extractor ──────────────────────────────────────────────────────────

const propositionProps = {
	id: Type.String({ description: 'Local id: "p1", "p2", … — referenced by chains in this call.' }),
	name: Type.String({
		description:
			"A very short label — established terminology, the term the discipline itself uses, a glossary " +
			"headword a textbook would print ('Will to power', 'Divine command theory'). Not a sentence, " +
			"needn't be unique or self-contained: this becomes the node's global label in the graph.",
	}),
	statement: Type.String({
		description:
			"One true, self-contained, world-facing core idea at full precision. Never about the " +
			'learner, the teacher, or the reading: not "the learner understands X" but "X". A misconception ' +
			"enters as its TRUE correction.",
	}),
	aliases: Type.Optional(
		Type.Array(Type.String(), {
			description: "Verbatim phrasings the source used for the same proposition, if any.",
		}),
	),
};

// The extractor redesign (owner, 2026-09-30): the extractor submits
// REASONING CHAINS — premises + conclusion — stored AS-IS (chains-primary,
// same evening: chains.jsonl is the truth; edges are a derived view, and
// supports edges are retired entirely).
const endpoint = (role: string) =>
	Type.String({
		description:
			`The id this ${role} — EITHER an existing graph idea id from THE GRAPH SO FAR in the prompt, ` +
			'verbatim ("n_…"), OR the local id of a proposition in this submission ("p1", …).',
	});

const chainSchema = Type.Object({
	premises: Type.Array(endpoint("premise uses"), {
		minItems: 1,
		description:
			"Premise ids used TOGETHER: they jointly entail the conclusion; independent reasons are separate chains.",
	}),
	conclusion: endpoint("conclusion is"),
});

// Weak-model tolerance (owner, 2026-09-25): the old zod `.default([])` /
// `.default({ quiz: {} })` on required-but-empty fields becomes Type.Optional
// here + a ??-fill at the submit seam (fillFindings/fillAudit below) — same
// contract on the wire (omission tolerated, empty never means "invalid"),
// no zod left in the agent band.
const propositionsDescription =
	"Only the NEW core ideas this stretch contributes — ideas the prompt's THE GRAPH SO FAR already " +
	"holds are referenced by id in chains, never restated here.";
const chainsDescription =
	"Every argument this stretch makes — including arguments that join new ideas to established " +
	"ones; conclusions reusable by id as premises of later chains; bare ideas (no argument) ride " +
	"the propositions list alone; pass [] when none — never omit the field.";

const findingsSchema = Type.Object({
	propositions: Type.Array(Type.Object(propositionProps), {
		description: propositionsDescription,
	}),
	chains: Type.Array(chainSchema, {
		description: chainsDescription,
	}),
});

// THE SESSION EXTENSION (owner, 2026-10-13): every session proposition
// carries a REQUIRED messageId — the anchor of the passage it came from,
// copied from the view's "TEACHER [id]" label (validated at the submit
// seam against the CURRENT batch). The NOTES door has no messages: its
// schema stays the base shape above, prompt and wire unchanged.
const sessionPropositionProps = {
	...propositionProps,
	messageId: Type.String({
		description:
			"The message id of the ONE passage in this stretch that most directly states or explains this " +
			'proposition — copy it EXACTLY from that passage\'s "TEACHER [id]" label.',
	}),
};

const sessionFindingsSchema = Type.Object({
	propositions: Type.Array(Type.Object(sessionPropositionProps), {
		description: propositionsDescription,
	}),
	chains: Type.Array(chainSchema, {
		description: chainsDescription,
	}),
});

/** What the extractor SUBMITS (the redesign's wire shape) — propositions
 *  + chains. fillFindings normalizes it; validateFindingsChains checks
 *  the chain laws; asSessionFindings lifts it straight into
 *  SessionFindings — chains are stored AS-IS (chains-primary, owner
 *  2026-09-30: no edge translation at any seam). */
type FindingsSubmit = Static<typeof findingsSchema>;

/** The SESSION wire — the notes shape plus the REQUIRED messageId anchor
 *  on every proposition (owner, 2026-10-13). */
type SessionFindingsSubmit = Static<typeof sessionFindingsSchema>;

// VERDICTS-ONLY (owner, 2026-09-28): the auditor never alters the
// extractor's findings, so it does not restate them — links are its
// ENTIRE deliverable (owner, 2026-09-28 evening: the edges argument is
// GONE; the auditor never mints edges. The graph connects across sources
// solely through identified equivalences — a link, never an inference).
const auditSchema = Type.Object({
	links: Type.Array(
		Type.Object({
			id: Type.String({ description: 'The proposition id from the findings ("p1", …).' }),
			linkTo: Type.String({
				description:
					"The id of the EXISTING graph node this proposition IS — your identity verdict. EQUIVALENCE BIAS (2026-09-27): paraphrases, rewordings, and compressions of the same claim MERGE; only genuinely distinct propositions stay apart.",
			}),
		}),
		{ description: "Identity verdicts — which findings propositions ARE existing graph nodes. A proposition absent from here = create a new node. Pass [] when none — never omit the field." },
	),
});

// The notes front door's wire shape is the session shape MINUS the
// messageId anchor (owner, 2026-10-13: only the SESSION door demands
// passage anchors — notes have no messages, so their prompt and schema
// stay exactly as they were): one base findings type for both doors,
// the anchor riding as an optional field.
type NotesFindings = SessionFindings;
type NotesAuditResult = AuditVerdicts;

// ── the submit seam (owner, 2026-09-28; redesigned 2026-09-30) ──
//
// Every top-level field on each submit tool is REQUIRED — a payload
// missing `chains` (findings) or `links` (review) fails validation
// instead of silently merging structure-less (the degraded-retry hole:
// the model's first truncated attempt failed validation, then the retry
// passed with propositions only — optional fields ??-filled [] — merging
// a pile of nodes with no structure). Only the per-item aliases stay
// optional with a ??-fill.

function fillFindings<T extends { propositions: Array<{ aliases?: string[] }>; chains: unknown }>(
	raw: T,
): T {
	return {
		...raw,
		propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
	};
}

/** The notes fill: the shared alias ??-fill PLUS the door's boundary — a
 *  stray messageId (the notes schema has none; extra properties pass
 *  schema validation) is stripped so notes provenance stays chat-level
 *  (the file is the anchor, owner 2026-09-13). */
function fillNotesFindings(raw: FindingsSubmit): FindingsSubmit {
	return fillFindings({
		...raw,
		propositions: raw.propositions.map((p) => {
			const stripped = { ...p } as typeof p & { messageId?: unknown };
			delete stripped.messageId;
			return stripped;
		}),
	});
}

/** The chain laws (extractor redesign, 2026-09-30; digest-aware
 *  2026-09-30 evening) — the LOUD channel: runSubmitAgent turns a
 *  problem string into an error tool result and the model re-submits
 *  within its turns. The MIXED NAMESPACE: an
 *  endpoint resolves when it is a submitted proposition id OR an
 *  existing graph node id (the extractor continues a partly-extracted
 *  source and references digest ids verbatim). Identical (premise-set,
 *  conclusion) chains are NOT errors — they dedupe silently at the
 *  merge (chainKey): restating an argument is a no-op. */
function validateFindingsChains(value: FindingsSubmit, existingIds: ReadonlySet<string>): string | null {
	const ids = new Set(value.propositions.map((p) => p.id));
	for (const chain of value.chains) {
		if (chain.premises.length === 0) {
			return "chains: premises must name at least one proposition — a proposition with no argument stays in the propositions list alone.";
		}
		const unknown = [...chain.premises, chain.conclusion].find((id) => !ids.has(id) && !existingIds.has(id));
		if (unknown !== undefined) {
			return `chains: "${unknown}" is neither a submitted proposition id nor an existing idea id from THE GRAPH SO FAR — every premise and conclusion must resolve.`;
		}
		if (chain.premises.includes(chain.conclusion)) {
			return "chains: a conclusion cannot be its own premise.";
		}
	}
	return null;
}

/** The SESSION anchor law (owner, 2026-10-13): every proposition names a
 *  passage of the CURRENT batch — nonempty, and a teacher-prose message
 *  id present in the stretch this extractor is reading (the same ids the
 *  view's TEACHER [id] labels carry). Refused anchors ride the existing
 *  error-back channel: no merge, no coverage checkpoint, until a valid
 *  submit lands. The boundary is strict on purpose — an id from a LATER
 *  or already-covered batch, another chat, or a learner/tool message is
 *  refused even when it is a real message id of this chat. */
function validateSessionAnchors(value: SessionFindingsSubmit, batchIds: ReadonlySet<string>): string | null {
	for (const p of value.propositions) {
		if (p.messageId.trim().length === 0) {
			return `propositions: "${p.id}" is missing its messageId — copy the message id from the brackets of the passage (TEACHER [id]) that most directly states or explains it.`;
		}
		if (!batchIds.has(p.messageId)) {
			return `propositions: "${p.id}" names messageId "${p.messageId}", which is not a passage of THIS stretch — copy the id from the brackets of one of this stretch's own TEACHER [id] passages.`;
		}
	}
	return null;
}

/** (chains-primary, owner 2026-09-30) the wire IS the pipeline shape
 *  now: propositions + chains, no translation — the stores keep the
 *  chains and the derived edge view is recomputed on read. The fill
 *  already ran inside runSubmitAgent; this only re-asserts the
 *  aliases-filled type (and preserves the session submit's messageId
 *  anchor, 2026-10-13 — both doors lift through here). */
const asSessionFindings = (
	raw: {
		propositions: Array<{ id: string; name: string; statement: string; aliases?: string[]; messageId?: string }>;
		chains: Array<{ premises: string[]; conclusion: string }>;
	},
): SessionFindings => ({
	propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
	chains: raw.chains,
});

function fillAudit(raw: Static<typeof auditSchema>): AuditVerdicts {
	return {
		links: raw.links,
	};
}

// ── the extractor's system prompt (owner redesign, 2026-09-30) ──
//
// GOAL-FIRST, NO RULE ARMOR: the old doctrine's defensive lists (DROP
// lists, merge-your-own-output, name walls, when-in-doubt-omit, the
// faithfulness paragraph) are ALL CUT — the prompt states the goal and
// the submission mechanics; the tool's field descriptions carry the
// details. One shared core + two contextualizations, assembled here —
// session and notes share the core by construction. (The old opening
// describing Quiz/Recall-check/Question blocks was stale since the
// 2026-09-28 teacher-prose ruling and is simply omitted.)

/** The session-only anchor instruction (owner, 2026-10-13, verbatim):
 *  passages arrive labeled "TEACHER [id]" and every proposition must
 *  name the ONE passage it came from — the anchor the merger stamps
 *  into message-granular provenance. Notes have no passages: their
 *  contextualization stays untouched. */
export const SESSION_MESSAGE_ID_RULE =
	"For each new proposition, copy the message ID of the passage that most directly states or explains it into messageId.";

export const SESSION_PREAMBLE =
	"You are the extraction stage of a learning application. You read one stretch of a source — a teaching " +
	"session, rendered as the teacher's prose in reading order — and report what it teaches as findings " +
	"for the learner's global knowledge graph, building on everything already extracted from this source.";

export const NOTES_PREAMBLE =
	"You are the extraction stage of a learning application. You read one stretch of a source — the " +
	"author's personal notes, rendered in reading order — and report what it teaches as findings for the " +
	"learner's global knowledge graph, building on everything already extracted from this source.";

export const EXTRACTION_CORE = `THE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations. The
source teaches by arguing — ideas worked out from other ideas, down to a foundation the rest stands on.
Your deliverable is twofold: the core ideas themselves, and the chains of reasoning that derive them.
Each chain is premises that JOINTLY entail a conclusion. Entailment is the only link that earns a
chain — where the real connection is historical or narrative (who argued what, how a debate or
exposition unfolds), there is no chain; keep the pieces as bare ideas or drop them. The direction of
the graph is upward: foundational ideas at the bottom, derived ideas above them, each chain showing
how its conclusion follows from what is more established — do not submit connections that carry no
derivation.

The graph holds TRUE ideas about the world, nothing else — never anything about the learner, the
teacher, or this reading: not "the learner understands X" but X. A misconception enters as its TRUE
correction. Each statement is one self-contained idea at full precision.

Extract the load-bearing ideas of the subject — what a reference on it would teach — not the full run
of the discourse. An idea earns its place only when the source's arguments run through it — examples,
notation glosses, and restatements that no argument needs are not core ideas. Every idea must stand
alone for a reader who never saw this source: names and statements may not lean on the source's own
scaffolding (claim numbering, axiom tags, arc labels); a claim that only matters as part of how this
document is organized is not knowledge — drop it.

When the prompt carries THE GRAPH SO FAR, you are continuing a source already partly extracted: build
on it. Reference an existing idea by its id ("n_…") instead of restating it, and prefer chains that
lean on established conclusions as premises — derive new material from what is already derived. Do
not re-derive a conclusion the graph already holds unless the route is genuinely different.

SUBMIT with one submit_findings call: every NEW core idea with a short name and a precise statement,
and every chain as premises + conclusion. A chain's premises and conclusion may be ids from this
submission OR existing ids from THE GRAPH SO FAR, verbatim. Premises within one chain are used
TOGETHER — independent arguments for the same conclusion are separate chains. A conclusion may
reappear, by id, as a premise of later chains. A bare idea that no argument uses rides the
propositions list alone. Include every field even when empty — "chains": [] when the source makes no
arguments. The tool's field descriptions carry the details.`;

export const EXTRACTOR_INSTRUCTIONS = `${SESSION_PREAMBLE}\n\n${EXTRACTION_CORE}\n\n${SESSION_MESSAGE_ID_RULE}`;
export const NOTES_EXTRACTOR_INSTRUCTIONS = `${NOTES_PREAMBLE}\n\n${EXTRACTION_CORE}`;

// ── the same-source digest (owner, 2026-09-30 evening) ──
//
// Serialized digest-aware extraction REPLACED the spine stage (owner
// ruling after the live test: the post-hoc assembly pass added
// complexity without perceptible gain — the extractor itself is the
// assembler when it can see what its source has already yielded). Pure
// string fold over the derived graph; "" when the source owns nothing
// yet (the first stretch runs bare). Ids ride VERBATIM — that is what
// the extractor references in its chains (the merger's mixed-namespace
// resolution passes them through).
export function sourceDigest(graph: DerivedGraph, sourceId: string): string {
	const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
	const ours = graph.nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId));
	const ourChains = graph.chains.filter((c) => c.provenance.some((pt) => pt.chatId === sourceId));
	if (ours.length === 0 && ourChains.length === 0) return "";
	const lines: string[] = [];
	lines.push("THE GRAPH SO FAR — everything already extracted from this source (reference these ids verbatim):");
	for (const n of ours) lines.push(`  ${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`);
	if (ourChains.length > 0) {
		lines.push("DERIVATIONS ALREADY RECORDED (build on these; do not re-derive them):");
		for (const c of ourChains) {
			const names = c.premises.map((p) => nameOf.get(p) ?? p).join(" ∧ ");
			lines.push(`  [${c.premises.join(" + ")} ⇒ ${c.conclusion}]  ${names} ⇒ ${nameOf.get(c.conclusion) ?? c.conclusion}`);
		}
	}
	return lines.join("\n");
}

/** The extractor over ONE session transcript (the chat front door).
 *  `batchIds` — the CURRENT batch's teacher-prose message ids — is the
 *  anchor boundary: every submitted proposition's messageId must name
 *  one of them (validateSessionAnchors at the submit seam). */
function runExtractor(
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	existingIds: ReadonlySet<string>,
	batchIds: ReadonlySet<string>,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<SessionFindings> {
	// Chains in (the wire), chains out (the store) — no translation seam
	// since chains-primary. Validation runs at the submit seam (error-back)
	// over the MIXED namespace: local ids + existing graph ids, plus the
	// session anchor law (messageId ∈ the current batch, 2026-10-13).
	return runSubmitAgent<SessionFindingsSubmit>({
		role: "extractor",
		// Debug recorder key: the source id (the run's ledger key — the
		// chat's chatId for chat runs, the src id for notes).
		chatId: sourceId,
		toolName: "submit_findings",
		toolDescription: "Submit the session findings.",
		parameters: sessionFindingsSchema,
		fill: fillFindings,
		validate: (value) => validateSessionAnchors(value, batchIds) ?? validateFindingsChains(value, existingIds),
		systemPrompt: EXTRACTOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the extractor never submitted findings",
		prepareArguments: healStringifiedArrays,
	}).then(asSessionFindings);
}

/** The extractor over ONE source of raw personal notes (the format-agnostic
 *  front door): same single-submit shape, notes-mode prompt + schema —
 *  the BASE wire (no messageId: notes have no passages, and a stray one
 *  is stripped at the fill seam). */
function runNotesExtractor(
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	existingIds: ReadonlySet<string>,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<NotesFindings> {
	return runSubmitAgent<FindingsSubmit>({
		role: "extractor",
		// Debug recorder key: the notes' source id (the ledger key).
		chatId: sourceId,
		toolName: "submit_findings",
		toolDescription: "Submit the notes findings.",
		parameters: findingsSchema,
		fill: fillNotesFindings,
		validate: (value) => validateFindingsChains(value, existingIds),
		systemPrompt: NOTES_EXTRACTOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the extractor never submitted findings",
		prepareArguments: healStringifiedArrays,
	}).then(asSessionFindings);
}

// ─── the auditor ───────────────────────────────────────────────────────────


const AUDITOR_INSTRUCTIONS = `You are the linking stage of a learning application's extraction pipeline. An extractor
has read a source (a teaching session, or the author's personal notes) and reported findings: propositions and
their reasoning chains. You NEVER see the source itself — the extractor is fully trusted, and you do not re-check
its work. Your job is IDENTITY: connecting those findings to the CURRENT knowledge graph, preparing the merge.

You explore the graph through your tools: list_sessions, list_propositions, and find (glob over names +
statements + aliases; each hit also says which session it was born in). The graph is SMALL and FINITE — a handful of
sessions — and your job is done as soon as you have SEEN the plausible candidates. FOLLOW THIS PROCEDURE:

1. GROUND yourself first: call list_sessions ONCE. This one call shows the entire space — every session that ever
   contributed propositions, and how many. Now you know the extent of what you are searching; nothing is hidden.
2. READ the plausibly-related sessions: for each session whose topic could overlap these findings, call
   list_propositions — every proposition born there, with full statement text. A few calls and you have read
   every realistic identity candidate in the graph.
3. find is your targeted sweep: use it for phrasings, synonyms, and neighboring ideas the session reads made you
   wonder about — its hits point back at sessions you can read whole.
4. SUBMIT. Once every plausibly-related session has been read (and stray finds come back empty), you are DONE.
   Do not re-search ground you have already seen; more patterns over the same nodes are wasted work.

IDENTITY — links, per proposition:
- For each proposition: does an EXISTING node — one you have now SEEN — already state this same proposition?
- If yes: add { "id": <its proposition id>, "linkTo": <that node's id> } to "links". The session's phrasings join
  its aliases and its provenance; the node keeps its existing name.
- If no: add nothing — a new node is created with the extractor's name as its label.
- EQUIVALENCE BIAS (owner ruling): paraphrases, rewordings, and compressions of the same claim MERGE. When two
  statements are the same claim at different precision or from different angles, LINK them. Only genuinely distinct
  propositions — different claims about the world — stay apart. You are NOT guarding against wrong merges; you are
  hunting for right ones.

Your deliverable is ONLY the identity verdicts: "links". NEVER restate the propositions —
the merger already has them. You NEVER create relations between propositions — they come from the
extractor alone, and the batch connects to the existing graph ONLY through the equivalences you identify. Your
entire deliverable is ONE submit_review call.

Include the "links" field even when empty — "links": [] when nothing links. NEVER omit it because it is empty.`;

/** The auditor — one shape for both front doors now (the notes schema was
 *  identical once attribution died). An agentic loop: graph-exploration
 *  tools plus the one submit call. */
function runAuditor(
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
	tools: Record<string, AgentTool<any>>,
): Promise<AuditVerdicts> {
	return runSubmitAgent({
		role: "auditor",
		// Debug recorder key: same source id as the extractor run.
		chatId: sourceId,
		toolName: "submit_review",
		toolDescription: "Submit the identity verdicts ONLY (links) — never the propositions themselves.",
		parameters: auditSchema,
		fill: fillAudit,
		systemPrompt: AUDITOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the auditor never submitted a review",
		extraTools: tools,
		maxTurns: 16,
		prepareArguments: healStringifiedArrays,
	});
}

// ─── the pipeline status registry ─────────────────────────────────────────────

/** The pipeline phases, in order — what the home status endpoint shows.
 *  The post-batch embedding tail was its own phase (accuracy wave,
 *  2026-09-19) until wave 7 killed the embedder seam wholesale (this
 *  interlude) — birth-session clusters need no post-merge pass. The
 *  phases tell the truth about what the job is actually waiting on.
 *  "queued" (owner, 2026-09-28): the global extract semaphore — 3
 *  concurrent extractor calls process-wide; the job is waiting for an
 *  extract slot, not for the model.
 *  "waiting" (owner 2026-09-28): the serialized-audit gate — the job's
 *  audit+merge critical section is queued behind another job's; the
 *  extractor is done but the auditor may not start until the graph is
 *  stable. */
export type ExtractionPhase = "queued" | "extracting" | "waiting" | "auditing" | "merging";

/** One in-flight pipeline run. Module-level: one process, one registry.
 *  Exported for the status payload's consumer typing (the dock). */
export interface RunningExtraction {
	/** The SOURCE id (chat id / notes src id) — the payload's identity and
	 *  the abort key. The registry KEY adds "#i" for chunk jobs (a
	 *  multi-chunk source owns several entries); this field stays the
	 *  source id so the feed's reveal logic and abort stay source-scoped. */
	chatId: string;
	/** PER-CHUNK JOBS (owner, 2026-09-28): which chunk of how many this
	 *  job is — present only when the source fanned out (n > 1). Drives
	 *  the feed row's "· i/N" suffix. */
	part?: { i: number; n: number };
	/** Which front door the run came through — label + usage-persistence
	 *  depend on it (chats bill their chat record; notes bill the source
	 *  record). */
	kind: "chat" | "notes";
	/** Display label (the file path for notes imports); the status route
	 *  falls back to the chat store for chat runs. */
	label?: string;
	phase: ExtractionPhase;
	startedAt: number;
	/** Live per-stage usage, accumulated as steps bill (the dock's cost /
	 *  context-window blobs read this through /api/graph/status). */
	usage: {
		extractor?: ExtractionStageUsage;
		auditor?: ExtractionStageUsage;
	};
	/** True-cancellation handle (the dock's abort button): one controller per
	 *  run, shared across phases; abort() cancels the in-flight model call. */
	controller: AbortController;
}

interface LhExtractionGlobal {
	__lhExtractionRuns?: {
		/** In-flight pipeline runs, keyed chatId (chat) / src id (notes). */
		running: Map<string, RunningExtraction>;
		/** The single-flight guard, shared by every pipeline instance. */
		inFlight: Set<string>;
		/** Last minted startedAt — kept monotonic so two runs starting in the
		 *  same millisecond never collide on the usage idempotency key. */
		lastStartedAt: number;
	};
	/** The serialized-audit mutex (owner 2026-09-28): a FIFO promise
	 *  chain — the audit+merge critical section runs one job at a time,
	 *  process-wide. globalThis for the same module-instance reason as
	 *  the run registries. */
	__lhAuditLock?: { tail: Promise<void> };
	/** The EXTRACT SEMAPHORE (owner, 2026-09-28): 3 concurrent extractor
	 *  calls process-wide — the provider-facing rate stance (the import
	 *  route's old 3-wide pool doctrine, now global). Per-chunk jobs fan
	 *  out in parallel but queue here. */
}

/** THE RUN REGISTRIES live on globalThis, not module level — the
 *  turn-liveness lesson: Next dev compiles each route entry as its own
 *  module instance, so a module-level Map is a different object in the
 *  /api/activity route than in the pipeline's chat-handler instance —
 *  the status routes would read an always-empty registry. One process,
 *  one truth — the same idiom as the turn, wake, and abort registries
 *  (moved 2026-09-19, the observability-accuracy wave; also makes the
 *  single-flight guard cross route instances). */
function runs(): NonNullable<LhExtractionGlobal["__lhExtractionRuns"]> {
	const g = globalThis as typeof globalThis & LhExtractionGlobal;
	return (g.__lhExtractionRuns ??= { running: new Map(), inFlight: new Set(), lastStartedAt: 0 });
}

/** In-flight pipeline runs (oldest first) — the /api/graph/status payload. */
export function extractionStatuses(): RunningExtraction[] {
	return [...runs().running.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** True cancellation of the in-flight run for a chat (the dock's abort
 *  button): the pending model call receives the signal — the provider
 *  cancels the request, spend stops — and the run ends like a failure:
 *  nothing merged, nothing checkpointed, partial usage still persisted.
 *  Returns false when no run is in flight (idempotent no-op). */
export function abortExtraction(chatId: string): boolean {
	// PER-CHUNK JOBS (owner, 2026-09-28): a source may own several registry
	// entries (one per chunk/batch) — aborting the source aborts EVERY
	// job of its fan-out.
	let found = false;
	for (const run of runs().running.values()) {
		if (run.chatId !== chatId) continue;
		run.controller.abort();
		found = true;
	}
	return found;
}
// ─── the pipeline ───────────────────────────────────────────────────────────

export interface ExtractionModels {
	/** Test seam: a scripted engine per stage — checked FIRST, ahead of the
	 *  engineFor chain (production wires no direct values). */
	extractor?: PiEngine;
	auditor?: PiEngine;
	/** Settings-resolved engine per role — the same slot treatment the
	 *  job runner got, read FRESH per stage call (a settings PUT between
	 *  stages lands). BYOK (owner, 2026-09-22): the chain (role override →
	 *  slot → NOTHING) may end EMPTY → undefined; the front doors refuse
	 *  with ModelsNotConfiguredError before any stage runs. */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	/** Key-presence gate (provider-key interlude, 2026-09-25): given a
	 *  stage engine's provider + the role's slot tier, the injected check
	 *  returns the refusal envelope when the provider's key is missing
	 *  (null = run). Same injection discipline as the job runner's seam
	 *  (the agent layer may not read the key store); absent in tests that
	 *  inject engines directly (test engines never owe a key). A keyless
	 *  stage refuses with ProviderKeyMissingError BEFORE any batch runs. */
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
}

export interface ExtractionPipelineDeps extends GraphDeps, ExtractionModels {
	/** The chunk budget — the transcript-token share of the extractor's
	 *  context; batches fill to it (the trigger fires on the same number,
	 *  read fresh per turn by the composition root). OPTIONAL with the
	 *  factory default (4096) so test fixtures stay minimal; the server
	 *  callers wire the live effective settings (extraction-UX redesign,
	 *  2026-09-24). */
	getChunkTokens?: () => number;
}

export interface NotesImportInput {
	/** The source's file path — its identity (deterministic src id) AND its
	 *  provenance label in the detail card. */
	filePath: string;
	/** The file's raw content, VERBATIM — any format. */
	text: string;
}

/** A notes import did not finish. Earlier graph writes and billed usage are
 * retained; partialStats describe known merges, not an all-or-nothing result. */
export class NotesImportError extends Error {
	constructor(
		public readonly outcome: "failed" | "partial" | "aborted" | "busy",
		public readonly partialStats: EmissionStats,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "NotesImportError";
	}
}

export interface ExtractionPipeline {
	/** Extract + audit + merge ONE chat. Single-flight per chat; resolves to
	 *  the merger's append stats (or throws — no checkpoint on failure). */
	runExtraction(chatId: string): Promise<EmissionStats>;
	/** The format-agnostic front door (2026-09-13): run the same pipeline
	 *  over ONE raw notes file. The source id is deterministic per file
	 *  path, so re-importing the same file re-runs extraction against the
	 *  same source identity (mappings dedupe by it). */
	importNotes(input: NotesImportInput): Promise<EmissionStats>;
}

/** pi's per-step usage, flattened to the persisted CallUsage fields
 *  (the money channel's capture shape, contracts/chat.ts). Exported for
 *  the cluster namer — the same capture shape (2026-09 graph cost
 *  metrics wave). Module scope: no closure deps, pure projection. */
export function callUsage(usage: Usage): CallUsage {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		// Optional in pi's Usage (providers that never emit reasoning
		// tokens leave it unset) — persisted as 0, never dropped.
		reasoningTokens: usage.reasoning ?? 0,
	};
}

export function createExtractionPipeline(deps: ExtractionPipelineDeps): ExtractionPipeline {
	const { chatStore, graphStore } = deps;
	// Stage-engine resolution: a direct test value wins; otherwise the
	// engineFor chain (role override → slot → nothing, resolved FRESH per
	// stage call server-side) — the job runner's exact treatment. undefined
	// = the BYOK chain came up empty; the front-door guards turn that into
	// an honest refusal.
	const stageEngine = (role: ModelRole, override?: PiEngine): PiEngine | undefined =>
		override ?? deps.engineFor?.(role);
	/** The per-need refusal guard: which slot tiers the pipeline's stages
	 *  found unset (test values count as configured — they ARE engines),
	 *  and whether a configured stage's provider key is gone (provider-key
	 *  interlude, 2026-09-25) — both refuse BEFORE any batch runs. */
	function refuseIfStagesUnready(): void {
		const stages: readonly [ModelRole, PiEngine | undefined][] = [
			["extractor", stageEngine("extractor", deps.extractor)],
			["auditor", stageEngine("auditor", deps.auditor)],
		];
		const missing = new Set<ModelSlotName>();
		for (const [role, engine] of stages) if (!engine) missing.add(ROLE_SLOT[role]);
		if (missing.size > 0) {
			console.info(`[extraction] refused — no model configured for: ${[...missing].join(", ")}`);
			throw new ModelsNotConfiguredError([...missing]);
		}
		// Key-presence parity: first offender surfaces (extractor before
		// auditor); fixing that key re-gates and the next run surfaces the
		// next offender, if any.
		for (const [role, engine] of stages) {
			const refusal = deps.providerKeyMissing?.(engine!.model.provider, ROLE_SLOT[role]);
			if (refusal) {
				console.info(`[extraction] refused — ${JSON.stringify(refusal)}`);
				throw new ProviderKeyMissingError(refusal.provider, refusal.slots);
			}
		}
	}
	// THE SHARED REGISTRIES (runs() above — globalThis): every pipeline
	// instance (route entries in dev, tests) sees the same runs, the same
	// single-flight guard. No module-level state left in this factory.
	const runningExtractions = runs().running;
	const inFlight = runs().inFlight;

	function setPhase(
		jobKey: string,
		phase: ExtractionPhase,
		kind: "chat" | "notes",
		label?: string,
		part?: { i: number; n: number },
	): void {
		const R = runs();
		const prev = runningExtractions.get(jobKey);
		if (!prev) R.lastStartedAt = Math.max(Date.now(), R.lastStartedAt + 1);
		runningExtractions.set(jobKey, {
			chatId: prev?.chatId ?? jobKey.split("#")[0]!,
			part: prev?.part ?? part, // phase changes never lose the part
			kind,
			label: prev?.label ?? label, // phase changes never lose the label
			phase,
			startedAt: prev?.startedAt ?? R.lastStartedAt,
			usage: prev?.usage ?? {}, // phase changes never lose usage
			controller: prev?.controller ?? new AbortController(),
		});
		// Every phase transition announces the dock (push S5, 2026-10-02):
		// notify-after-write — the registry is the feed's truth.
		emit("activity-changed", {});
	}

	/** Run over (done, failed, aborted — every exit is a finally): the row
	 *  leaves the feed. ONE seam for all delete sites so no exit path can
	 *  miss the announce (push S5, 2026-10-02). */
	function finishExtraction(jobKey: string): void {
		runningExtractions.delete(jobKey);
		emit("activity-changed", {});
	}

	/** Accumulate one billed step into the run's registry entry (live). */
	function recordStep(jobKey: string, stage: "extractor" | "auditor", usage: CallUsage, model: string): void {
		const run = runningExtractions.get(jobKey);
		if (!run) return; // not running (tests driving stages directly)
		run.usage[stage] ??= { model, steps: [] };
		run.usage[stage]!.steps.push(usage);
	}

	/** SERIALIZED AUDIT (owner 2026-09-28): the auditor explores the LIVE
	 *  graph through its tools and stamps identity verdicts against what
	 *  it finds — so the audit+merge section is a process-wide critical
	 *  section. Two concurrent audits would each link into a graph the
	 *  other is about to change: the structural mint of duplicate nodes.
	 *  The extractor stays parallel (source-local, graph-blind). The
	 *  check runs BEFORE any LLM is invoked or the graph read; the lock
	 *  is FIFO, held through the merge, reacquired per batch, and
	 *  abort-aware on both sides of the queue (a waiter that aborts
	 *  leaves without auditing — its chain link still resolves, so
	 *  successors never hang). */
	async function withAuditLock<T>(jobKey: string, kind: "chat" | "notes", label: string | undefined, critical: () => Promise<T>): Promise<T> {
		setPhase(jobKey, "waiting", kind, label);
		const g = globalThis as typeof globalThis & LhExtractionGlobal;
		const lock = (g.__lhAuditLock ??= { tail: Promise.resolve() });
		const prev = lock.tail;
		let release!: () => void;
		lock.tail = new Promise<void>((resolve) => (release = resolve));
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			if (!signal) return;
			onAbort = () => {
				const err = new Error("extraction aborted while waiting for the audit gate");
				err.name = "AbortError";
				reject(err);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			await Promise.race([prev, aborted]);
			signal?.throwIfAborted(); // aborted exactly at handoff
			return await critical();
		} finally {
			if (onAbort && signal && !signal.aborted) signal.removeEventListener("abort", onAbort);
			release();
		}
	}

	async function extract(
		jobKey: string,
		sourceId: string,
		view: string,
		batchIds: ReadonlySet<string>,
	): Promise<SessionFindings> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		signal?.throwIfAborted(); // an abort during a sync gap ends the job here
		// THE DIGEST (owner, 2026-09-30 evening): the extractor continues a
		// partly-extracted source — it sees everything this source has
		// already yielded (propositions + chains, ids verbatim) and builds
		// on it. Serialized batches make this read the post-merge graph of
		// every earlier batch (cross-source runs stay parallel — the
		// digest is source-scoped, so only SAME-source order matters).
		const graph = getGraph(graphStore);
		const digest = sourceDigest(graph, sourceId);
		const prompt = digest === "" ? view : `${digest}\n\n${view}`;
		console.info(
			`[extraction ${jobKey}] extractor starting (${view.split("\n").length} markdown lines` +
				`${digest === "" ? "" : `, digest ${digest.split("\n").length} lines`})`,
		);
		const t0 = performance.now();

		const findings = await runExtractor(
			stageEngine("extractor", deps.extractor),
			sourceId,
			prompt,
			new Set(graph.nodes.map((n) => n.id)),
			batchIds,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(jobKey, "extractor", callUsage(usage), model);
				console.info(`[extraction] extractor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		console.info(`[extraction ${jobKey}] extractor done in ${Math.round(performance.now() - t0)}ms`);
		return findings;
	}

	async function audit(jobKey: string, sourceId: string, findings: SessionFindings): Promise<AuditVerdicts> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		signal?.throwIfAborted(); // an abort during the extract→audit gap ends here
		const graph = getGraph(graphStore);
		console.info(
			`[extraction ${jobKey}] auditor starting (${findings.propositions.length} propositions, ` +
				`${graph.nodes.length} graph nodes)`,
		);
		const t0 = performance.now();

		// The auditor NEVER sees the source (owner 2026-09-27): findings
		// JSON + identity instructions, and the graph reached through
		// exploration tools instead of an injected dump. The proposition
		// projection omits messageId (2026-10-13): the auditor is
		// IDENTITY-only and never sees the passages, so anchors are useless
		// to it — they add cognitive load, not signal.
		const auditResult = await runAuditor(
			stageEngine("auditor", deps.auditor),
			sourceId,
			`Proposed findings from the extractor (the source itself is not available to you — the extractor is fully trusted; the propositions only — the reasoning chains are the merger's business, owner 2026-09-30):\n\n` +
				`${JSON.stringify(
					{
						propositions: findings.propositions.map((p) => ({
							id: p.id,
							name: p.name,
							statement: p.statement,
							aliases: p.aliases,
						})),
					},
					null,
					2,
				)}\n\n` +
				`The current knowledge graph has ${graph.nodes.length} node(s). Explore it with your tools and link what links.`,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(jobKey, "auditor", callUsage(usage), model);
				console.info(`[extraction] auditor step ${step}: ${finishReason}, tools: ${tools}`);
			},
			auditorGraphTools({ chatStore, graphStore }),
		);
		console.info(
			`[extraction ${jobKey}] audit: ${findings.propositions.length} propositions through, ` +
				`${auditResult.links.length} linked to existing nodes`,
		);
		console.info(`[extraction ${jobKey}] auditor done in ${Math.round(performance.now() - t0)}ms`);
		return auditResult;
	}


	/** THE EXTRACT SLOT (unified 2026-09-29): extraction chunk jobs run
	 *  under the SHARED background-LLM semaphore — one process-wide pool
	 *  of 3 permits (see bg-llm-semaphore.ts). The
	 *  job's registry-row signal kills a queued ticket (dead-ticket
	 *  handoff). The audit side needs no slot: audits already serialize
	 *  behind their own global lock. */
	async function withExtractSlot<T>(jobKey: string, critical: () => Promise<T>): Promise<T> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		return withBgLlmSlot(signal, critical);
	}

		/** Append the run's usage record to the chat's extractions log — success
	 *  or failure: a failed run still spent money, and its partial usage is
	 *  exactly what the record should show (stats absent = never merged).
	 *  Idempotent per startedAt (the store dedupes). */
	function persistRunUsage(jobKey: string, durationMs: number, stats: EmissionStats | undefined): void {
		const run = runningExtractions.get(jobKey);
		if (!run) return; // not running (tests driving stages directly)
		// PER-CHUNK JOBS (owner, 2026-09-28): the registry KEY may carry a
		// "#i" suffix — the usage LEDGERS key by SOURCE (run.chatId): one
		// job's record per chunk, all appended to the source's log.
		// SESSION-DELETION GUARD (wave 6): a chat deleted mid-run has no
		// usage log to append to — the record's death is the user's choice
		// and its partial spend logs with it (appendSourceUsage below
		// already no-ops for a vanished source; the chat path guards here).
		if (run.kind === "chat" && !chatStore.getChat(run.chatId)) return;
		const entry: ExtractionRunUsage = {
			startedAt: run.startedAt,
			at: new Date().toISOString(),
			durationMs,
			stats,
			stages: {
				extractor: run.usage.extractor ?? { model: "unknown", steps: [] },
				auditor: run.usage.auditor ?? { model: "unknown", steps: [] },
			},
		};
		if (run.kind === "notes") graphStore.appendSourceUsage(run.chatId, entry);
		else chatStore.appendExtractionUsage(run.chatId, entry);
	}

	/** One chunk/batch JOB (per-chunk jobs, owner 2026-09-28): the registry
	 *  entry's lifecycle — minted with its part, usage persisted per job
	 *  (the ledger shows each chunk's cost), removed on any exit. The body
	 *  runs the full queued → extract → audit-locked merge lifecycle;
	 *  failure isolation lives at the fan-out site (one bad chunk never
	 *  kills its siblings). */
	async function runJob(
		source: { id: string; kind: "chat" | "notes"; label?: string; part?: { i: number; n: number } },
		body: (jobKey: string) => Promise<EmissionStats>,
	): Promise<EmissionStats> {
		const jobKey = source.part ? `${source.id}#${source.part.i}` : source.id;
		const t0 = performance.now();
		try {
			const stats = await body(jobKey);
			persistRunUsage(jobKey, Math.round(performance.now() - t0), stats);
			return stats;
		} catch (err) {
			persistRunUsage(jobKey, Math.round(performance.now() - t0), undefined);
			throw err;
		} finally {
			finishExtraction(jobKey);
		}
	}

	/** The fan-out aggregation (per-chunk jobs, owner 2026-09-28): successes
	 *  count (earlier chunks keep their merges — checkpoints make aborts
	 *  cheap), aborts log and pass as partial stats, isolated failures log
	 *  per job and never throw — the source's run returns what actually
	 *  merged. */
	function aggregateJobs(sourceId: string, settled: PromiseSettledResult<EmissionStats>[]): EmissionStats {
		const stats: EmissionStats = { nodes: 0, chains: 0 };
		let aborted = false;
		let failed = 0;
		for (const result of settled) {
			if (result.status === "fulfilled") {
				stats.nodes += result.value.nodes;
				stats.chains! += result.value.chains ?? 0;
				// Simplification maintenance, summed like appends — but ABSENT
				// when nothing dropped (deep-equal pins read cleaner).
				if (result.value.droppedChains)
					stats.droppedChains = (stats.droppedChains ?? 0) + result.value.droppedChains;
				continue;
			}
			const err = result.reason;
			if (err instanceof Error && err.name === "AbortError") aborted = true;
			else {
				failed++;
				console.error(`[extraction ${sourceId}] job failed (isolated):`, err);
			}
		}
		if (aborted)
			console.info(
				`[extraction ${sourceId}] aborted — merged chunks keep their coverage, the rest stay uncovered for the next run`,
			);
		if (failed > 0)
			console.error(`[extraction ${sourceId}] ${failed} job(s) failed; successful jobs still merged`);
		return stats;
	}

	async function runExtraction(chatId: string): Promise<EmissionStats> {
		if (inFlight.has(chatId)) return { nodes: 0, chains: 0 };
		inFlight.add(chatId);
		const t0 = performance.now();
		// COVERAGE (vision-extraction-coverage.md, 2026-09-15): extract ONLY
		// what the per-chat coverage ledger doesn't already hold — never the
		// whole session. Batches are token-budgeted runs of the oldest
		// uncovered messages; each merged batch checkpoints its messages'
		// coverage ATOMICALLY (inside the merger's step 4), so an abort or
		// error below loses at most the in-flight batch — every earlier
		// batch stays covered, the rest stays visibly uncovered.
		try {
			const record = chatStore.getChat(chatId);
			if (!record) throw new Error(`Chat not found: ${chatId}`);
			// BYOK per-need gate (owner, 2026-09-22) + key presence
			// (2026-09-25): the write channel needs extractor + auditor
			// engines AND their providers' keys; a refusal lands BEFORE any
			// stage runs (typed — the trigger skips, routes surface 503).
			refuseIfStagesUnready();
			const covered = coverageOf(record.messages, graphStore.readCoverage(), chatId);
			const failedOutputCalls = failedOutputCallIds(record.messages);
			if (covered.uncovered.length === 0) {
				console.info(`[extraction ${chatId}] nothing uncovered — no-op`);
				return { nodes: 0, chains: 0 };
			}
			const chunkTokens = deps.getChunkTokens?.() ?? FACTORY_SETTINGS.graph.extractionChunkTokens;
			// The batcher's one rule (owner, Wave D): a tool-call message and
			// its result message(s) are INSEPARABLE — one chunk, covered
			// together, read together (core/coverage.ts batchRuns).
			const batches = batchRuns(covered.slots, covered.uncovered, chunkTokens);
			console.info(
				`[extraction ${chatId}] pipeline start — ${covered.uncoveredTokens} uncovered tok, ` +
					`${covered.uncoveredCount} messages, ${batches.length} batch(es) of ≤${chunkTokens} tok`,
			);
			// PER-CHUNK JOBS (owner, 2026-09-28), SERIALIZED PER SOURCE (owner,
			// 2026-09-30 evening): every batch is its own job — registry row,
			// because each batch's extractor continues the source's digest
			// (everything the earlier batches merged). Cross-source runs stay
			// parallel; the 3-slot extract semaphore still caps concurrent
			// extracts process-wide ("queued"); audits serialize through the
			// process-wide gate ("waiting"). A batch that fails is ISOLATED
			// (its messages stay uncovered — honestly re-runnable); its
			// siblings keep merging.
			const settled: PromiseSettledResult<EmissionStats>[] = [];
			for (const [batchIndex, batch] of batches.entries()) {
				const part = batches.length > 1 ? { i: batchIndex + 1, n: batches.length } : undefined;
				try {
					settled.push({
						status: "fulfilled",
						value: await runJob({ id: chatId, kind: "chat", part }, async (jobKey) => {
							// The batch's source view: TEACHER PROSE ONLY (owner,
							// 2026-09-28), each passage labeled with its ACTUAL message
							// id (2026-10-13) — the view lines ARE the coverage
							// fingerprints' messageViewLines ("TEACHER [id] text"), one
							// shared seam.
							const messages = batch.map((slot) => slot.message);
							const view = proseView(messages, record.title, failedOutputCalls);
							// The batch's teacher-prose ids — the ONLY anchors this
							// job's submit may name (validateSessionAnchors at the
							// submit seam refuses anything else: ids from other
							// batches — even real ones of this chat — other chats,
							// and non-prose messages).
							const batchIds = new Set(
								messages.filter((m) => messageViewLines(m, m.id, failedOutputCalls).length > 0).map((m) => m.id),
							);
							setPhase(jobKey, "queued", "chat", undefined, part);
							const findings = await withExtractSlot(jobKey, async () => {
								setPhase(jobKey, "extracting", "chat", undefined, part);
								return extract(jobKey, chatId, view, batchIds);
							});
							// SERIALIZED AUDIT (owner, 2026-09-28): audit + merge are the
							// graph-mutating critical section — one job at a time,
							// process-wide, so the auditor explores the graph as it
							// stands AFTER every earlier job's merge.
							return withAuditLock(jobKey, "chat", undefined, async () => {
								setPhase(jobKey, "auditing", "chat", undefined, part);
								const auditResult = await audit(jobKey, chatId, findings);
								setPhase(jobKey, "merging", "chat", undefined, part);
								// SESSION-DELETION GUARD (wave 6): a chat deleted mid-run must never
								// merge. The deletion route aborts this run first and runs its purge
								// as one sync block; this closes the last window — a run that slipped
								// past the wind-down finds the chat gone HERE and rides the existing
								// abort path (info, not error): nothing merged, nothing checkpointed.
								if (!chatStore.getChat(chatId)) {
									const gone = new Error(`chat deleted mid-run: ${chatId}`);
									gone.name = "AbortError";
									throw gone;
								}
								// The batch's messages, snapshotted when the run computed
								// coverage — if a message mutates mid-run (a quiz answer
								// merges in), the stored fingerprint won't match its new
								// one and it re-opens: honest by construction.
								const foldedAt = new Date().toISOString();
								const batchStats = mergeFindings(chatId, findings, auditResult, { chatStore, graphStore }, {
									foldedAt,
									coverage: batch
										.filter((slot) => slot.tokens > 0)
										.map((slot) => ({ chatId, fp: slot.fp, tokens: slot.tokens, foldedAt })),
								});
								// The layout ledger evolves with the merge (sync — the
								// next snapshot fetch must already reflect the new nodes).
								settleGraphLayout(graphStore);
								console.info(
									`[extraction ${jobKey}] merged: ${batchStats.nodes} nodes, ${batchStats.chains ?? 0} chains`,
								);
								return batchStats;
							});
						}),
					});
				} catch (err) {
					settled.push({ status: "rejected", reason: err });
					// A source-wide abort (user abort / session deletion)
					// ends the WHOLE run: later batches would mint fresh,
					// un-aborted jobs and hang — stop here. Isolated
					// FAILURES keep going (siblings still merge).
					if (err instanceof Error && err.name === "AbortError") break;
				}
			}
			const stats = aggregateJobs(chatId, settled);
			console.info(
				`[extraction ${chatId}] merged: ${stats.nodes} nodes, ${stats.chains ?? 0} chains ` +
					`(${Math.round(performance.now() - t0)}ms total, ${batches.length} batch job(s))`,
			);
			return stats;
		} catch (err) {
			// Pre-fan-out failures only (stage gate, coverage read): aborts
			// and job-level failures are absorbed at the fan-out site, per
			// job — merged batches stay covered, partial usage persists per
			// job, the aggregate returns what actually merged.
			console.error(`[extraction ${chatId}] pipeline failed (${Math.round(performance.now() - t0)}ms):`, err);
			throw err;
		} finally {
			inFlight.delete(chatId);
			finishExtraction(chatId); // done or failed — no longer running
		}
	}

	// ── the notes front door (format-agnostic: raw text in, same graph out) ──

	/** The raw source view the notes stages see: the file path + the text
	 *  VERBATIM. No message ids — provenance is the file itself. */
	function notesView(input: { filePath: string; text: string; part?: { i: number; n: number } }): string {
		const part = input.part && input.part.n > 1 ? ` (part ${input.part.i}/${input.part.n})` : "";
		return `SOURCE (the author's personal notes): ${input.filePath}${part}\n\n${input.text}`;
	}

	/** Chunk the notes text under the same budget the chat path uses
	 * (owner, 2026-09-28: the whole-file-in-one-call design collapsed a
	 * weak model — 26 propositions, structure bleed mid-emission).
	 * Greedy by line, chars/4 like every other estimate in the app; a
	 * single over-budget line rides alone (never split a line). */
	function chunkNotes(text: string, budget: number): string[] {
		if (text.trim().length === 0) return [];
		const out: string[] = [];
		let current = "";
		for (const line of text.split("\n")) {
			const candidate = current.length === 0 ? line : current + "\n" + line;
			if (current.length > 0 && Math.ceil(candidate.length / 4) > budget) {
				out.push(current);
				current = line;
			} else {
				current = candidate;
			}
		}
		if (current.trim().length > 0) out.push(current);
		return out;
	}

	async function notesExtract(
		jobKey: string,
		input: { id: string; filePath: string; text: string; part?: { i: number; n: number } },
	): Promise<NotesFindings> {
		// jobKey (per-chunk jobs, owner 2026-09-28): the registry key —
		// "src#i" for chunk jobs — so the abort signal reaches the call.
		// input.id stays the SOURCE id for the view and store ledgers.
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		signal?.throwIfAborted(); // an abort during a sync gap ends the job here
		const view = notesView(input);
		// Same digest law as the chat door (owner, 2026-09-30 evening): the
		// chunk extractor continues its own source, ids verbatim.
		const graph = getGraph(graphStore);
		const digest = sourceDigest(graph, input.id);
		const prompt = digest === "" ? view : `${digest}\n\n${view}`;
		console.info(
			`[extraction ${jobKey}] notes extractor starting (${view.split("\n").length} source lines` +
				`${digest === "" ? "" : `, digest ${digest.split("\n").length} lines`})`,
		);
		const t0 = performance.now();
		const findings = await runNotesExtractor(
			stageEngine("extractor", deps.extractor),
			input.id,
			prompt,
			new Set(graph.nodes.map((n) => n.id)),
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(jobKey, "extractor", callUsage(usage), model);
				console.info(`[extraction] extractor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		console.info(`[extraction ${jobKey}] notes extractor done in ${Math.round(performance.now() - t0)}ms`);
		return findings;
	}

	// The notes auditor is the SAME identity-linker as the chat one (one
	// schema now that attribution is gone) — audit() above, verbatim.

	async function runNotesExtraction(input: { id: string; filePath: string; text: string; importedAt: string }): Promise<EmissionStats> {
		const { id } = input;
		// importNotes owns the source exclusion, including metadata and cleanup.
		const t0 = performance.now();
		const mergedStats: EmissionStats = { nodes: 0, chains: 0 };
		try {
			// BYOK per-need gate (owner, 2026-09-22) + key presence
			// (2026-09-25): same refusal as the chat front door — no
			// extractor/auditor engines, or a stage key gone, no run.
			refuseIfStagesUnready();
			// CHUNKED like the chat path (owner, 2026-09-28): each chunk is a
			// standalone extract → audit → merge, so no single call carries a
			// whole large file. Abort mid-run keeps earlier chunks merged
			// (same doctrine as chat batches).
			const chunkTokens = deps.getChunkTokens?.() ?? FACTORY_SETTINGS.graph.extractionChunkTokens;
			const chunks = chunkNotes(input.text, chunkTokens);
			console.info(
				`[extraction ${id}] notes pipeline start (${input.filePath}) — ${chunks.length} chunk(s) of ≤${chunkTokens} tok`,
			);
			// PER-CHUNK JOBS (owner, 2026-09-28), SERIALIZED PER SOURCE (owner,
			// 2026-09-30 evening): same law as the chat door — chunks run
			// STRICTLY IN ORDER, each chunk's extractor continuing the
			// source's digest (everything earlier chunks merged). Cross-source
			// runs stay parallel; the semaphore caps concurrent extracts
			// process-wide; audits serialize through the gate as before. The
			// part rides the registry entry (feed suffix "· i/N") only when
			// the file actually chunked.
			const settled: PromiseSettledResult<EmissionStats>[] = [];
			for (const [chunkIndex, chunk] of chunks.entries()) {
				const part = chunks.length > 1 ? { i: chunkIndex + 1, n: chunks.length } : undefined;
				// Keep the actual signal after runJob tears down its registry row:
				// usage persistence can throw and mask the body's AbortError.
				let chunkSignal: AbortSignal | undefined;
				try {
					settled.push({
						status: "fulfilled",
						value: await runJob({ id, kind: "notes", label: input.filePath, part }, async (jobKey) => {
							setPhase(jobKey, "queued", "notes", input.filePath, part);
							chunkSignal = runningExtractions.get(jobKey)?.controller.signal;
							const findings = await withExtractSlot(jobKey, async () => {
								setPhase(jobKey, "extracting", "notes", input.filePath, part);
								return notesExtract(jobKey, { ...input, text: chunk, part });
							});
							// SERIALIZED AUDIT (owner, 2026-09-28): audit + merge one
							// at a time, process-wide — the auditor explores the graph
							// as it stands AFTER every earlier job's merge. Reacquired
							// per chunk so cross-source runs interleave fairly.
							return withAuditLock(jobKey, "notes", input.filePath, async () => {
								setPhase(jobKey, "auditing", "notes", input.filePath, part);
								const auditResult = await audit(jobKey, input.id, findings);
								setPhase(jobKey, "merging", "notes", input.filePath, part);
								const merged = mergeFindings(
									id,
									findings,
									auditResult,
									{ chatStore, graphStore },
									{ foldedAt: input.importedAt },
								);
								// Capture the committed merge BEFORE layout/usage can fail.
								mergedStats.nodes += merged.nodes;
								mergedStats.chains! += merged.chains ?? 0;
								if (merged.droppedChains)
									mergedStats.droppedChains = (mergedStats.droppedChains ?? 0) + merged.droppedChains;
								// The layout ledger evolves with each merge — the next
								// snapshot fetch reflects every finished chunk.
								settleGraphLayout(graphStore);
								console.info(`[extraction ${jobKey}] merged: ${merged.nodes} nodes, ${merged.chains ?? 0} chains`);
								return merged;
							});
						}),
					});
				} catch (err) {
					let failure = err;
					if (chunkSignal?.aborted && !(err instanceof Error && err.name === "AbortError")) {
						// Notes-only: never start a fresh chunk after user cancellation,
						// even when usage cleanup replaced the original abort rejection.
						// Keep the secondary failure visible in the final import error.
						const aborted = new Error(`Notes import aborted; job cleanup failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
						aborted.name = "AbortError";
						failure = aborted;
					}
					settled.push({ status: "rejected", reason: failure });
					// Same source-wide-abort law as the chat door: stop the
					// run; isolated failures keep going.
					if (failure instanceof Error && failure.name === "AbortError") break;
				}
			}
			const stats = aggregateJobs(id, settled);
			// Completion is a chunk-status contract, never a node-count test.
			// Zero findings (and an empty file after the readiness gate) are valid.
			const rejected = settled.filter((r) => r.status === "rejected");
			if (rejected.length > 0 || settled.length !== chunks.length) {
				const aborted = rejected.some((r) => r.reason instanceof Error && r.reason.name === "AbortError");
				const outcome = aborted ? "aborted" : settled.some((r) => r.status === "fulfilled") ? "partial" : "failed";
				const details = rejected.map((r) => r.reason instanceof Error ? r.reason.message : String(r.reason)).join("; ");
				throw new NotesImportError(outcome, mergedStats, details || "Notes import did not complete");
			}
			console.info(
				`[extraction ${id}] merged: ${stats.nodes} nodes, ${stats.chains ?? 0} chains ` +
					`(${Math.round(performance.now() - t0)}ms total, ${chunks.length} chunk job(s))`,
			);
			return stats;
		} catch (err) {
			console.error(`[extraction ${id}] notes pipeline failed (${Math.round(performance.now() - t0)}ms):`, err);
			if (err instanceof NotesImportError || err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) throw err;
			throw new NotesImportError(err instanceof Error && err.name === "AbortError" ? "aborted" : "failed", mergedStats,
				err instanceof Error ? err.message : String(err), { cause: err });
		} finally {
			finishExtraction(id); // done or failed — no longer running
		}
	}

	/** Every explicit import processes the whole file. Identity, source digest,
	 * auditor and usage history remain source-scoped; this is not exactly-once. */
	async function importNotes(input: NotesImportInput): Promise<EmissionStats> {
		const id = `src_${crypto.createHash("sha256").update(input.filePath).digest("hex").slice(0, 12)}`;
		// Acquire BEFORE source upsert: overlapping contents must not alter metadata.
		if (inFlight.has(id)) throw new NotesImportError("busy", { nodes: 0, chains: 0 }, "This file is already being imported. Try again when it finishes.");
		inFlight.add(id);
		try {
			const importedAt = new Date().toISOString();
			graphStore.upsertSource({ id, filePath: input.filePath, importedAt });
			return await runNotesExtraction({ id, ...input, importedAt });
		} catch (err) {
			if (err instanceof NotesImportError || err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) throw err;
			throw new NotesImportError("failed", { nodes: 0, chains: 0 }, err instanceof Error ? err.message : String(err), { cause: err });
		} finally {
			inFlight.delete(id);
		}
	}

	return { runExtraction, importNotes };
}

