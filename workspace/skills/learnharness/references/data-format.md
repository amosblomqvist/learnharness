# LearnHarness data: a field reference

The files are the user's record, not an import format to rewrite. Work read-only.
The bundled readers make common views convenient; they are not required for custom
analysis. This reference describes native session/graph format **1**. An absent
version stamp means v1. Older fields within that format are described below;
pre-native `parts`/UIMessage transcripts are a different, unsupported dialect.

## File map

Paths below are relative to the selected **data** directory:

```text
chats/<session-id>.json    Full session: messages, optional plan, usage metadata
graph/nodes.jsonl          Proposition assertions; IDs can repeat
graph/chains.jsonl         Reasoning-chain assertions; logical chains can repeat
graph/sources.json        Imported-note source metadata, keyed by source ID
graph/format.json         Graph-family format stamp: {"version": 1}
graph/sessions.jsonl       Extraction checkpoints, NOT the session index
graph/coverage.jsonl       Extraction fingerprints, NOT learner assessment
graph/positions.json      Canvas layout, not semantic relationships
graph/render-settings.json  Presentation preferences, not learning evidence
jobs/<job-id>.json        Background work records; delivered artifacts also appear in sessions
```

`settings.json`, downloaded models, caches, and provider debug logs are not needed
to interpret learning history. `auth.json` is normally one directory above data;
do not read it. Imported-note paths, research URLs, and artifact references are not
automatically followed by the readers.

## A session record

Each `chats/*.json` file is an object with:

| Field | Meaning |
| --- | --- |
| `id`, `title` | Stable session identity and user-visible name |
| `createdAt`, `updatedAt` | ISO date strings for the session, not a date for every idea |
| `kind` | `teach` or `practice`; absent means `teach` |
| `version` | Format stamp; absent means v1 |
| `messages` | Complete stored chronological history, including custom app markers |
| `tree` | Optional session plan: nodes, prerequisite edges, revision number |
| `turns`, `extractions` | Parallel usage/cost-observation logs, not learner answers |
| `settings` | Per-session model/thinking overrides, not an understanding assessment |

The plan is session scaffolding, not the persistent knowledge graph. Its visited
or current positions are not proof of mastery. Context compaction changes what the
teaching model sees; it does **not** mean earlier messages were deleted from this
stored history.

### Messages and content blocks

Messages carry an application `id` and usually a millisecond Unix `timestamp`.
Native roles are:

- `user`: learner prose; `content` can be a string or text/image blocks.
- `assistant`: `content` is an array of `text`, `thinking`, and `toolCall` blocks.
  `thinking` here is **agent reasoning**, not learner thinking.
- `toolResult`: result of a call, identified by `toolCallId` and `toolName`.
  `content` is often only a compact model-facing summary; `details` can be richer.
- `custom`: an application event identified by `customType`. Some contain
  irreplaceable learner work or teaching artifacts, so do not discard this role.

An assistant tool call has roughly this shape:

```json
{
  "type": "toolCall",
  "id": "call_EXAMPLE",
  "name": "probe",
  "arguments": {
    "question": "Which claim follows?",
    "options": [{"label": "A claim", "value": "claim"}],
    "correctAnswer": "claim",
    "explanation": "The teacher's explanation."
  }
}
```

This is an illustrative fragment, not a valid complete question fixture. Tool
arguments are authored by the teacher; correct answers, explanations, and practice
solutions can already be stored before the learner answers. A call without a
learner-result message may be pending or interrupted; never invent an answer.
An `isError: true` result means the call failed, not that its contents were
successfully posed or taught.

Some historical fields contain JSON encoded inside a string where an array/object
was intended. If inspecting them, decode in memory only and keep the original
record unchanged. Do not evaluate text as code. Historical LaTeX escaping mistakes
can also be present in the source; a readable transcript is not a data-repair pass.

### Questions and answers: where the evidence actually lives

Question tools include `ask_user_question`, `probe`, `quiz`, `recall`, and `explain`.
Probe/quiz are multiple-choice checks; recall/explain use a teacher-committed answer
and the learner's own words. Ask questions clarify goals/preferences and are not
graded quizzes. Older records can use older tool names or lack newer type fields.

A question's learner response is a separate `toolResult` message. Prefer its
**`details`** payload: `content[*].text` deliberately omits material already in
the call, including some question/options/solution fields. The reader deduplicates
that compact content only after verifying it adds nothing to the full snapshot.
Extra or conflicting content is retained as a separately attributed source, not
silently reconciled; `--include-operations` also restores verified duplicates.

Important answer-detail fields:

| Field | Meaning |
| --- | --- |
| `kind` | `quiz`, `ask`, or `explain` |
| `tool`, `questionType` | Optional tool/role snapshots; a quiz can be `predict` or `check` |
| `questionText`, `options` | Question and displayed-option snapshots |
| `answers` | Selected `{label, value, index}` tuples; index is 1-based **display order** |
| `text`, `other` | Free-text response or ask's Other answer |
| `dontKnow`, `dismissed` | Explicit don't-know or skipped state |
| `thinking` | Learner reasoning about the question |
| `note` | Legacy name for that same channel; use `thinking ?? note` |
| `readingThinking` | Separate learner thinking while reading the teaching |
| `confidence` | Self-reported 0–100 probability that the selected quiz answer is correct |
| `correct`, `correctIndices` | Mechanical quiz grading in displayed-option order |
| `committed`, `explanation` | Teacher's committed answer / quiz explanation, not learner speech |
| `answeredAt` | ISO answer timestamp |

**Options are shuffled.** Never apply a learner's display index to the raw call's
authored option order. Use the answer snapshot and its label/value tuples. Missing
confidence is not zero, and no confidence is sent for don't-know. The slider's 50%
resting value is a real recorded 50%, but the record cannot tell whether it was
left untouched or chosen deliberately.

Retain incorrect responses, failed attempts, skipped questions, and don't-know;
they are evidence, not noise to clean up. Do not invent a numeric grade for a
recall/explain response: the teacher's subsequent prose is its interpretation.

### Practice and custom markers

| `customType` | Interpretation |
| --- | --- |
| `practice-thinking` | **Learner-authored work**, including intermediate attempts and claimed answers; raw text is `details.text`, associated through `details.problemCallId` |
| `graph-context` | Picked propositions/chains supplied as session context; app-injected, not learner speech |
| `plan-block` | Historical plan presentation snapshot in `details.block` |
| `subagent-steer` | Delivered teaching artifact; `details.kind` and `details.result` identify the payload |
| `subagent-abort` | Background work was aborted; no result should be invented |
| `probe-handoff` | Probe-to-teach transition |
| `practice-next` | Learner moved on to another problem |
| `problem-dismissed` | Learner skipped a practice problem; points to its problem call |
| `compaction` | Context-management bookkeeping, not a learner statement or replacement for history |

The practice `problem` tool holds the statement, target proposition IDs, and
precommitted `modelSolution`. There may be many `practice-thinking` submissions for
one problem. `conclude` carries the teacher's outcome/verdict; a dismissal can be
recorded before its synthetic conclude pair appears. Preserve the sequence rather
than treating only the last submission as the learner's work.

Call IDs may repeat in older records. When joining, associate a result with the
nearest matching **preceding** call; a whole-session last-wins map can attach it
to a later call. Message IDs distinguish occurrences. Neither source order nor
learner attribution should be reconstructed from model-compacted context.

### Delivered artifacts

`subagent-steer.details.result` contains the stored artifact:

- Research: `brief`, plus `sources` containing titles/URLs.
- PDF reading: `path`, `question`, `brief`, `pagesRead`, `pagesConsulted`.
  These page lists are citations/audit information, not the original document.
- Demo: `title`, `notes`, and executable `html`.
- Visual: `notes` and `svg` markup.

Readable briefs and notes belong to the learning record. Demo HTML and SVG are
artifacts to describe, not commands to execute while reading. Binary/image blocks
can be large; their existence should be noted without dumping encoded bytes. No
reader needs to open the original PDF or notes file merely to read these records.

## The graph: assertions must be merged, not counted as unique lines

### Propositions (`nodes.jsonl`)

Each line contains `id`, `name`, `statement`, `aliases`, `createdAt`, and
`provenance`—an array of `{chatId, messageId}` points.

- A short `name` is a display label, **not** a unique identity or full claim.
- The **first line for an ID** defines its name, statement, and creation date.
- Later lines' nonempty statements and aliases join the aliases with exact-string
  deduplication. Later names do not replace the name or become aliases.
- Provenance unions by exact `(chatId, messageId)` pair, retaining encounter order.
- Do not deduplicate different node IDs just because their labels look alike.

### Reasoning chains (`chains.jsonl`)

Each line contains `id`, `premises` (node IDs), `conclusion` (node ID), `createdAt`,
and `provenance`. **All premises within a chain are used together.** Different
chains with the same conclusion are separate arguments, not one pooled premise
set. Merge repeated assertions by the sorted premise list plus conclusion, keeping
the first assertion's ID, premise order, and date; union provenance.

The graph canvas derives arrows and implication junctions from these records.
Those visual edges are not the stored truth and can lose the joint-premise
structure. Read chains directly. Missing endpoints are reported as missing, not
silently substituted or repaired.

### Sources, birth sessions, and provenance

A node's **birth source** is `provenance[0].chatId` after merging—the first surviving
point, not the earliest timestamp and not every session that mentioned it.
Graph session listings and `propositions --session` use this rule. A node with no
provenance remains readable/searchable but belongs to no birth session.

- `chat_…` IDs usually refer to session files. Use the matching `messageId` when
  present to find the exact source message. Empty message IDs in older data are
  chat-level attribution; they do not identify an exact message.
- Imported notes use `src_…` source IDs. `sources.json` supplies `id`, `filePath`,
  and `importedAt`; these source paths are references only.
- Missing/deleted source metadata can leave a valid graph. The session index then
  uses the source ID as its label and `file` as its fallback kind; this fallback
  alone does not prove the source was an imported file.
- Chat deletion and chain simplification can rewrite ledgers. They are normally
  appended during extraction, but do not assume the files are immutable logs.

Graph `sessions.jsonl` records extraction checkpoints, and `coverage.jsonl` records
fingerprints of extracted teacher text. Neither is a session catalog, quiz-event
ledger, mastery scale, or record of every idea the learner personally endorsed.
Practice does not itself write new propositions to the graph.

## Reader limits

The readers intentionally stop short of analysis: no inferred mastery, scoring,
semantic search, transitive traversal, or automatic report generation. Their JSON
output can be processed further, or you can read the native files directly.

Malformed/unsupported records must be identified, not silently counted as valid.
The app may be writing while a reader runs, so a directory-wide read is not an
atomic snapshot. Re-read or close the app for a stable comparison. Never introduce
locks, migrations, cleanup, or source-file edits to make a read succeed.
