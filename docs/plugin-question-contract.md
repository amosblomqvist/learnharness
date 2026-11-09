# Plugin question tools — API v1 contract

Custom teaching questions share the native question lifecycle. This contract describes
the matching source/build. Match the target app using the downloaded skill's `bundle.json`;
API v1 alone does not identify every available capability. Exact types live in
`src/core/plugin-questions.ts` and the matching type-only SDK. For practice, use the
separate [problem contract](plugin-problem-contract.md), not teaching enrollment.

## 1. Scope and ownership

The host owns canonical identity, saved contracts, validation/persistence/continuation,
question cards/dock, fold/reveal, submission/dismissal, session stats, microphone/model
controls, optional thinking and check reading-thinking, and probe/teach positioning.
The plugin owns payload/answer schemas, optional presentation, the answer editor,
instructions for using its format, and optional generic grading/result presentation.

This is not a generic pending-input/forms framework, host code-editor catalogue,
persistent editor-draft format, core chat migration hook or replacement for builtin
question grading. The ordinary teacher reviews the saved answer and any observations.

## 2. Backend registration

`ctx.registerQuestionType(definition)` returns an unregister function:

```ts
{
  id: string;
  label: string;
  contractVersion: number;
  incompatibleContractVersions?: number[];
  showThinking: boolean;
  questionSchema: TSchema;
  answerSchema: TSchema;
  probe?: { toolName: string; description: string };
  teach?: { toolName: string; description: string };
  validateQuestion?: synchronousRefinement;
  validateAnswer?: synchronousRefinement;
  gradeAnswer?: (context: PluginQuestionGradingContext<Q, A>) => JsonValue | Promise<JsonValue>;
}
```

`Q`/`A` denote schema-inferred payload/answer values. Type IDs use `[A-Za-z0-9_-]`,
1–128 characters; labels/descriptions must contain non-whitespace text. Contract versions
are positive safe integers, independent of package version. `showThinking` is required
plugin policy, not model-authored. At least one variant is required: probe contributes
only to prober, teach only to teacher; no practice enrollment is implied.

The host builds native posing tools, not plugin `execute` handlers. Names follow native
tool admission rules. Ordinary tools, questions, problems and instructions from a package
are admitted atomically from one per-turn contribution snapshot. Never invoke a factory
again to reconstruct authority.

Native parameters are `{question: string, payload: Q}` for probe and
`{type: "predict" | "check", nodeId: string, question: string, payload: Q}` for teach.
Common fields cannot collide with payload fields. `question` is non-whitespace
learner-visible Markdown preserved as authored, providing a safe teaser/fallback.
Teach node IDs must be applicable live plan nodes; existing predict/check pacing applies.

Optional side-effect-free synchronous refinements receive immutable context:
`validateQuestion({chatId,variant,contractVersion,input})` and
`validateAnswer({chatId,questionId,variant,contractVersion,input,answer})`.
Return `undefined`/`[]` or readable error strings. Async/thenable validation is refused.
Authoring errors do not pose a question; answer errors preserve pending input/drafts.
A schema-valid but incorrect answer is not a validation failure.

## 3. Schema and JSON boundary

Use self-contained persistable schemas supported by the installed TypeBox compiler.
Compile the plain persisted representation, preserving local JSON Pointer reference
meaning when embedding payloads. Reject external references, `$id`/anchor/dynamic
resolution, runtime-dependent functions/RegExp/validation objects, non-JSON extensions
and unsupported formats. Descriptive TypeBox branding is not persisted validation.
This is bounded schema hygiene, not full JSON Schema meta-validation.

Values are finite JSON: strings, finite numbers, booleans, null, arrays and plain objects.
Do not convert, clean, trim, truthiness-filter or silently omit values. Preserve raw code
whitespace and valid `false`, `0`, `null`, empty strings/arrays exactly.

## 4. Durable authority and stream presentation

A frozen accepted per-turn registry plus host pose ledger attest successful execution.
Only a successful host pose creates pending authority: raw arguments, tool-name
coincidence or arbitrary result tokens do not. Immutable snapshots bind host-minted
question ID, exact call occurrence, owner/type/label/version/variant, validated input,
schemas, `showThinking`, refinement and grading requirements, and teach role/node.

App-only `lhQuestions` metadata is indexed by assistant content position. Attempt
annotations carry visibility facts but no pending authority. Ungraded snapshots use
local protocol v1; graded ones use v2 with `requiresGrading: true` (section 6).

A successful pose ends the native run using a temporary engine acknowledgement, not a
learner answer. Suppress only ledger-attested temporary acks across stream/settlement
carriers; retain errors/ordinary sibling results. Correlate original events before wire
filtering. A successful pose stops mixed batches even when another question attempt fails.

Question attempts never fall into the generic raw-input trace, including failed/live/
interrupted attempts and missing renderers. Decorate outgoing assistant snapshot copies
at message start/update/end after subscription admission and ID remapping, before renderer
selection; never mutate shared native objects. Persist unsuccessful attempt classification
separately. Failed attempts show safe host status, not raw errors quoting private payloads.
Fallback uses common `question`, not a payload dump. This presentation boundary is not an
OS/browser sandbox or a promise that authored prose cannot contain an answer.

Strip app-only metadata from model messages. Never rewrite historical calls or allow
plugin callbacks to migrate core chat records.

## 5. Canonical adoption, submission and compatibility

Mount actionable editors only after canonical persistence/client adoption. Live attempts
may show non-actionable placeholders. After stream termination explicitly reconcile;
a failed read stays gated with reconciliation-only Retry, never another teacher turn.
Connection-generation/epoch/ticket fences reject detached completions. Reconnecting the
same occurrence must start/join a current task, not reuse obsolete readiness.

Submission binds stable question ID **and exact occurrence**, not only call ID. Pending
plugin questions cannot be bypassed by ordinary text/Continue/Retry or legacy builtin
answer/dismiss paths. Session settings/model changes remain possible.

The host latches one attempt, finishes dictation, awaits editor transcript publication,
rechecks occurrence/mount/readiness, resolves saved canonical schemas, validates/refines,
optionally grades, saves the genuine native result, then follows existing sibling/owed-turn
continuation rules. Duplicate/stale attempts cannot save another answer or launch extra work.
New hooks never retroactively change old saved acceptance requirements.

Compatibility is explicit:

- The current backend supports its exact `contractVersion`. Saved schemas still govern.
  Package revision/hash or a different version number alone never authorizes cancellation.
- `incompatibleContractVersions` declares genuine incompatibility; contradictory declarations
  reject. Explicit incompatibility or genuinely unreadable host protocol can produce quiet
  host cancellation only with enough readable identity to bind the exact occurrence.
  Never guess a cancellation target or race an active turn.
- Missing/disabled backend, undeclared version, missing renderer or rendering failure keeps
  pending input with readable fallback and recovery dismissal. Frontend failure cannot
  declare incompatibility. No automatic upgrade/range/migration over chat records exists.

## 6. Grading and saved results

Optional `gradeAnswer(context)` runs **after validation, before save**, receiving immutable
historical input/answer and a host signal. Return any finite JSON, not a host envelope.
There is no host result schema, correctness/status enum, scoring or automatic badge UI.

The host answer envelope contains `kind: "plugin-question"`, `questionId`, `pluginId`,
`typeId`, `contractVersion`, exact `answer`, applicable `thinking`/`readingThinking`,
`answeredAt`, optional image channels and optional `grading`:

```ts
type PluginQuestionGradingOutcome = { result: JsonValue } | { error: string };
```

The server supplies identity/time. Thinking is separate from answer; `showThinking`
controls applicability, not nonempty-writing requirements. Reading thinking applies only
to teach checks. Preserve applicable defined empty/whitespace values; reject injected
inapplicable channels. Full accepted details persist in the native result; model-facing
text includes answer/thinking/grading, with native image blocks alongside it. There is no
plugin-controlled replacement of the host answer message.

Throws/rejections/non-JSON grading returns save an **accepted answer with `grading.error`**,
not a validation failure. Successful falsy/null/empty results remain valid. Outcomes reach
`mountAnswered` and the model; projection, continuation/retry and remount never rerun grading.

Grading is pose-frozen: protocol v2 records `requiresGrading: true`; v1 remains ungraded
if a hook is later added, and unexpected v1 grading is ignored on projection without
rewriting history. Missing exact required grader keeps the question unavailable/pending.
An older host unable to read v2 may quietly cancel the bound unreadable occurrence.
Manifest API version remains 1.

Grading occupies the inline answer POST/existing turn-preparation owner: no jobs, queue
or extra LLM pass. Captured model/provider stays fixed through continuation. Disconnect/
navigation does not cancel admitted grading. Stop, disable or exact registration removal
aborts its signal and fences save: no learner answer saves for that attempt. The host
waits for actual callback settlement, not an abort-race wrapper. Cancellation is cooperative;
plugins own deadlines/cleanup, with no hard host timeout/process termination.

There is no automatic plugin-answer 409 retry. Explicit pre-save retry may rerun grading;
no across-crash exactly-once guarantee or rollback of external side effects is promised.
Lost acknowledgment requires canonical reconciliation, not a guessed new submission.

Dismissal/incompatibility produce honest host cancellation results, not learner answers,
and do not automatically run the teacher. Next deliberate input follows normal wake rules.

## 7. Frontend slots, drafts and lifetime

`registerQuestionRenderer({id,supportedContractVersions,mountQuestion?,mountAnswerEditor,
mountAnswered?})` returns an unregister function scoped to the owning plugin/type.
Default question presentation is host Markdown; default answered presentation is readable
saved learner data. These slots are not ordinary tool renderers or cross-plugin claims.

Mounts receive immutable normalized input, chat/question ID, historical contract version,
variant and signal. `mountAnswered` adds accepted answer, optional grading and optional
readonly `headerContainer` (inline after host label) / `footerContainer` (after host answer
thinking). These live DOM slots share the body's generation/signal/cleanup, confer no
ownership of host heading/thinking, and disappear on failure/replacement/unmount. If absent,
use body fallback; never query/move surrounding host DOM or retain slots across generations.
Question/editor mounts receive neither slot. Host thinking/images stay outside plugin bodies.

The editor receives `active`, controlled `answer` and synchronous `onChange(state)`:
`{status:"empty"}` or `{status:"unready"|"ready",value:JsonValue}`. Ready requires a current
handle/publication; schema-valid falsy/empty values may qualify. Drafts need not yet pass
the schema. `empty` keeps no value; use `unready` to retain incomplete text.

Required handle: `update({answer,active})`, `focus()`, `dispose()`; optional
`handleKeyDown(key): "handled" | "pass"`, `appendTranscript(text)` (sync/async).
Apply controlled updates without echoing publication or resetting identical selection/
composition. Async mounts/late callbacks are exact-occurrence/generation scoped: obsolete
handles cannot publish, focus, consume keys or receive speech.

Keep mounts alive across folding, updating active state. Same-question canonical adoption
must not remount. In-memory occurrence-keyed drafts survive remounts while the session model
lives, not necessarily model destruction/reload/restart. No persistent draft format is added.

## 8. Keyboard, dictation and native UI

Host Enter submits; Shift+Enter edits a newline; reserved Cmd/Ctrl+Enter submits subject
to readiness/IME. Offer plain Tab, Enter, Shift+Enter and Escape to the active eligible
editor first. `handled` claims once; omission/`pass` uses host defaults. Tab uses the
private host field chain, not browser traversal. Unhandled Escape moves to the next host
field (or blurs an editor-only chain), claiming that event without also discarding or
aborting. App shortcuts retain precedence, including Shift+Tab model-thinking cycling.
No public shortcut registry.

Outside the editor, after focused-field/dictation/layer handling, Escape uses native
question-dismissal confirmation. Cancel/dialog Escape preserves drafts. Confirmation binds
the exact occurrence/question; stale targets close without action, never retarget. Idle
confirmation saves cancellation without teacher wake. During grading the silent dismissal
route validates current state, parks dismissal and requests Stop together; actual grader
cleanup must settle before parked cancellation lands. Healthy questions still gain no
ordinary Dismiss button, and builtin question/problem behavior is unchanged.

Composition/229 must not submit/cycle/run editing commands; preserve composing Enter's
native default while suppressing host routing. Covered/hidden/stale editors cannot claim.
Keep the editor outside the submit footer's native form; no fabricated keyboard dispatch.

Dictation goes to unrevealed check ReadingThinking; after reveal/open probe/predict it
goes to host Thinking when enabled, otherwise explicit editor `appendTranscript` if
provided. Without either, microphone stays visible/disabled, never routes to a hidden
composer. Folding does not erase/redirect it. Finish before reveal/submit; transcript
callbacks must publish before resolving. Settle/cancel obsolete capture destinations.

Reuse native dock/card/stats/toolbar/reveal machinery, not a rewrite of builtin forms.
Thinking uses the native frame with compact 40px minimum and natural growth. Healthy
questions have no Dismiss; it is recovery-only. Unknown/sync-failed availability is not
confirmed unavailability: show Preparing or readable content with Retry syncing, gate
submission, and keep an admitted same-owner editor read-only until canonical readiness.
Legitimate initial publications/transcript completion still settle under draft-ownership
checks while interaction is inactive.

Opening height retargets from current geometry over remaining original animation time
when late editor admission changes size; do not delay/restart opening, animate ordinary
typing growth or remount the editor. In history, reading thinking is above the card with
native label/default-open; answer thinking is inside with native inCard/default-closed.
Defined empty/whitespace channels remain present; text/images combine per channel.

Fallback respects reveal pacing, shows safe saved Markdown/status, disables submission
and exposes recovery dismissal. Copy: `Preparing question…`, `Question unavailable`,
`Dismiss question`, `Could not sync the saved session.` / `Retry syncing`.

## 9. Verification

Tests should cover ledger-attested poses/mixed batches, stream suppression, canonical
reconnect/adoption, exact occurrences, schemas/local references, unavailable/incompatible
states, grading cancellation/save order, duplicate/legacy bypasses, editor generations,
drafts, keyboard/IME, speech delivery and host fallback. Portable SDK and isolated packaged
browser checks complement unit/component tests; fixtures do not establish real microphone,
OS IME, provider or installer behavior. Historical counts/evidence are in the
[implementation archive](archive/plugin-implementation-history.md#teaching-question-checkpoints).
