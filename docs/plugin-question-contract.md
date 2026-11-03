# Plugin question tools — bounded v1 contract

Status: **implemented and verified on `feature/plugin-architecture`; not released**. On 2026-11-02 the human approved this concrete contract and authorized implementation, then separately authorized committing the feature-branch checkpoint. The narrowed v1 scope and teacher-review-only assessment remain binding. Verification evidence is recorded in section 12. No push, release or product resumption is implied.

## 1. Scope and ownership

V1 adds native plugin question types to teaching conversations. It is **not** a public generic pending-input API or a new forms framework.

Host owns:
- The question card/dock, fold/reveal behavior, submit/dismiss controls and submission lifecycle.
- Existing persistent session metadata/stats, microphone, model picker and model-thinking picker.
- The optional question-thinking field and existing check reading-thinking flow.
- Probe/teach enrollment, predict/check rules and teaching-plan node positioning.
- Canonical question identity, saved contracts, validation, result persistence and continuation.

Plugin owns:
- Its question payload schema and answer schema.
- Optional rich question presentation, its answer editor and optional answered presentation.
- Its instructions about when the agent should choose this question format.
- Any separate grading/execution tools exposed through the already-existing tool API.

**No dedicated assessment hook in v1.** A valid answer is saved and returned to the ordinary teacher for review. Existing builtin grading remains unchanged. Do not add an assessment mode/schema/result, async grading stage, execution service or worker lifecycle to this API.

Other exclusions: builtin question migration, changes to existing builtin form behavior, general form controls/field-scope SDK, public async-button redesign, dialog/layout/status catalogue, source metadata API, runtime installer improvements, host-owned code editor/library/language catalogue, durable editor-draft storage, global chat-format bump or chat migration. Both product implementations remain paused. Existing documentation may receive a short clarification that installations use built package contents, not source trees.

## 2. Backend registration

Add `PluginBackendContext.registerQuestionType(definition): () => void`, with these public fields:

```ts
{
  id: string;                         // plugin-local stable type ID
  label: string;                      // learner-facing type label
  contractVersion: number;            // positive safe integer, independent of package version
  incompatibleContractVersions?: number[];
  showThinking: boolean;              // required, not model-authored
  questionSchema: TSchema;            // schema of payload below
  answerSchema: TSchema;              // schema of the plugin's answer value
  probe?: { toolName: string; description: string };
  teach?: { toolName: string; description: string };
  validateQuestion?: synchronousRefinement;
  validateAnswer?: synchronousRefinement;
}
```

Type IDs use the existing worker-definition local identifier rule (`[A-Za-z0-9_-]`, 1–128 characters); labels/descriptions must be non-whitespace text. At least one variant is required. Probe is contributed only to the prober; teach only to the teacher. A teach-only type does not create an unused probe tool. Practice enrollment is not included in v1.

The host constructs native tools, rather than accepting a plugin `execute` function for questions. Explicit names follow existing native tool-name and collision rules. All ordinary tools, question definitions and instructions from one package are admitted together through the existing per-turn contribution snapshot; a rejected package contributes none of them. Never call a contribution factory a second time to reconstruct authority.

Host-generated native parameters:

```ts
// Probe
{ question: string, payload: Q }

// Teach
{ type: "predict" | "check", nodeId: string, question: string, payload: Q }
```

`Q` is the registered `questionSchema`. Leading common fields cannot collide with plugin payload fields. `question` is required learner-visible Markdown, preserved as authored; reject whitespace-only text. It supplies the durable teaser/fallback without guessing which payload property is public. Teach node IDs must identify an applicable live plan node at pose time. Existing predict/check positioning and reveal semantics apply.

Refinements are optional **synchronous, non-grading** validation callbacks. `validateQuestion({ chatId, variant, contractVersion, input })` receives accepted normalized common fields/payload. `validateAnswer({ chatId, questionId, variant, contractVersion, input, answer })` receives the historical input and submitted answer. Arguments are immutable; return `undefined`/an empty list for acceptance or a list of readable problem strings. Authoring problems follow the existing native error/retry path without posing a pending question. Answer problems preserve the pending question/draft and surface an inline rejection. A schema-valid but incorrect answer is not a validation failure. Hooks must be side-effect-free; reject unsupported async/thenable implementations rather than silently awaiting them.

## 3. Schema and JSON boundary

Question/answer contracts must be self-contained, persistable JSON schemas supported by the installed TypeBox compiler. Compile the plain persisted representation; do not silently lose runtime-dependent semantics while saving it.

Supported data is finite JSON: strings, finite numbers, booleans, null, arrays and plain objects. Preserve strings exactly, including code whitespace. Do not use `Convert`, `Clean`, trimming, truthiness or JSON-stringify omission as answer validation.

For schemas, allow ordinary JSON types and self-contained local JSON Pointer references. Preserve/rebase those references when embedding `Q` under the native `payload` wrapper; compiling the wrapper must not change their meaning. Snapshots retain the standalone schema's original meaning. Reject external schema references, `$id`/anchor/dynamic-reference resolution, function/RegExp/runtime-dependent validation objects, non-JSON type extensions and unsupported custom formats. Known TypeBox descriptive branding is not a persisted validation contract. Reuse the existing schema-hygiene/compiler and small finite-JSON/freeze patterns; do not create a second schema language or claim full JSON Schema meta-validation.

## 4. Durable question authority

The host records a locally versioned immutable per-question snapshot containing:
- Host-minted stable question ID and exact native call occurrence binding.
- Plugin owner, type ID, label, contract version and native variant/tool identity.
- Normalized validated common fields/payload, saved schemas, `showThinking` and whether answer refinement is required.
- Teach role/node annotation where relevant and the readable common question.

Use an app-only assistant-message occurrence map (`lhQuestions`, indexed by content position) for question attempt annotations and successful snapshots. Its local `protocolVersion` starts at 1. An attempt annotation carries owner/type/label/variant visibility facts but no pending authority. A successful snapshot additionally carries the contract above.

The source of authority is a frozen accepted per-turn definition registry plus a host-owned pose ledger at the native validated-call seam. Only a successfully executed host question pose creates pending authority. Raw model arguments, tool-name coincidence or an arbitrary result token do not.

A pose ends the native run with the temporary host acknowledgment required by the engine. That acknowledgment is not the learner answer and is not persisted or exposed as a successful tool result. Filter only ledger-attested successful temporary pose acknowledgments from every relevant stream/settlement carrier. Preserve errors and ordinary sibling results. Call-ID correlation must observe original events before any wire filtering.

A successful new question pose ends a mixed batch even if another attempted question failed; retain sibling errors without allowing another assistant response to run over an unanswered question. Preserve the existing all-builtin stopping behavior.

Question attempts must never fall into the generic expandable raw-input trace. This applies to live attempts, failed/interrupted attempts, and missing/failing renderers: payloads can contain non-public reference material. After subscription admission and existing ID remapping, decorate outgoing copies of `message_start`, `message_update` and `message_end` assistant snapshots using the same accepted definition registry. Mark recognized question-call occurrences on every replacement snapshot; never mutate shared native objects or clone before ID remapping. Carry the occurrence marker into the view part before generic renderer selection. This is visibility-only annotation, not permission to mount a live form or a new manifest event. Persist equivalent unsuccessful attempt classification separately from successful pending authority. Failed/interrupted attempts show safe host status, not raw native error text that may quote authored arguments. Host fallback uses `question`, not a payload dump. This is a presentation boundary, not an OS/browser security boundary or a guarantee that authored prose never contains an answer.

Strip app-only question metadata when converting canonical history to model messages. Do not alter original historical calls or let plugin callbacks migrate chat records.

## 5. Canonical adoption and pending behavior

**Mount actionable question/editor slots only after canonical persistence and client adoption.** A live attempt can show a non-actionable host placeholder; it cannot accept an answer.

After a native stream terminates, perform an explicit canonical reconciliation before enabling new actions. Do not rely only on the independent global EventSource notification. A failed reconciliation stays gated and offers reconciliation-only retry; it must not start another teacher turn. Apply this shared terminal-readiness hardening without changing builtin schemas, grading or answer construction.

Pending classification, phase/position, dismissal, transcript rendering, wake/cause handling and answer guards must understand saved plugin-question identity without looking up current tool names. Bind submissions/results to stable question ID and exact occurrence, not just the native call ID. A legacy duplicate call ID cannot satisfy a newer question.

While a plugin question is pending, normal text/continue/retry and legacy builtin answer/dismiss/recovery requests cannot bypass its question protocol or saved-schema checks. Require the new validated answer path or explicit host dismissal first. This new-question gate does not change existing builtin input behavior or block session settings/model changes.

Answer submission sequence:
1. Acquire a host single-submit latch and check interaction/readiness gates.
2. Finish host dictation and await final transcript deliveries.
3. Recheck the current occurrence/mount/readiness; read authoritative refs, not rendered props or plugin DOM.
4. On the server, resolve canonical pending authority and its saved schemas.
5. Validate finite JSON and the historical answer schema; run an available same-contract answer refinement only when required by the saved contract. A missing required implementation keeps the question unavailable/pending; a newly added refinement must not silently change old acceptance rules.
6. Construct and durably save the genuine native result before ordinary continuation.
7. Continue only according to existing sibling-question/owed-turn discipline. Duplicate/stale requests cannot save a second answer or launch an extra turn.

## 6. Host result envelope

New types use a separate host-owned envelope, not builtin `QuestionAnswerData`:

```ts
{
  kind: "plugin-question";
  questionId: string;
  pluginId: string;
  typeId: string;
  contractVersion: number;
  answer: JsonValue;
  thinking?: string;
  readingThinking?: string;
  answeredAt: string;
}
```

The server supplies identity and timestamp from canonical truth. The plugin publishes only its answer value, never this envelope. Common thinking channels remain host-owned and separate from `answer`. `showThinking` controls presence, not a nonempty-writing requirement; preserve applicable host field text from its authoritative ref, including an empty value. ReadingThinking is applicable only to teach checks. Reject submission channels that are inapplicable to the saved question rather than accepting injected host fields.

Persist full accepted data in the native result's `details`. Host model-facing serialization includes answer and applicable thinking channels as JSON. Do not add a plugin-controlled model-message replacement hook. The already-authored question remains in its native call. Teacher-review-only means no inferred correctness or fabricated grading fields.

Dismissal and incompatible cancellation are honest host-authored native cancellation results, not learner answer envelopes. They do not automatically run the teacher. The next deliberate user action follows existing wake behavior.

## 7. Compatibility without migrations

- Backend `contractVersion` supports exactly that contract version in v1. Compatible package updates retain it; saved schemas still govern historical input.
- A different package version/revision/hash or contract number alone never authorizes cancellation.
- Optional `incompatibleContractVersions` explicitly declares other saved contracts genuinely incompatible. Reject contradictory declarations. When resolving canonical pending state, record the chosen quiet cancellation for an explicitly incompatible contract (or a genuinely unreadable host protocol), without rewriting old history or auto-running the teacher. Cancellation requires enough readable identity to bind the exact native occurrence; never guess a cancellation target when protocol parsing fails.
- If the plugin is missing/disabled, backend implementation is unavailable, a version is undeclared rather than explicitly incompatible, renderer support is missing, or rendering fails: keep pending with readable host fallback and a host-owned dismiss action.
- Frontend failure cannot declare incompatibility. No compatible-version range system, automatic upgrade, global migration or plugin migration hook over chat records.

Use the same authority/compatibility resolver before display/action boundaries. Cancellation writes remain host-owned and must not race an active turn. Plugin data migrations, if any, remain restricted to that plugin's own data.

## 8. Frontend question format

Add `PluginFrontendContext.registerQuestionRenderer(format): () => void`, keyed by owning plugin plus backend type `id`:

```ts
{
  id: string;
  supportedContractVersions: number[];
  mountQuestion?: presentationMount;  // default: host Markdown question
  mountAnswerEditor: editorMount;
  mountAnswered?: answeredMount;      // default: host-readable learner answer
}
```

These are slots inside the host card, not generic tool renderers. Another plugin's renderer cannot claim this question. A custom answered slot receives immutable input and accepted plugin answer; host ThinkingBlocks remain outside it. Cancellation always has host fallback rendering. Ordinary tool-renderer behavior is unchanged.

All mounts receive immutable normalized input, `chatId`, stable `questionId`, historical `contractVersion`, variant and an abort signal. Answer editor props additionally include `active`, the controlled answer state and synchronous `onChange(state)` publication:

```ts
type AnswerState =
  | { status: "empty" }
  | { status: "unready" | "ready"; value: JsonValue };
```

No answer is ready until a current editor handle exists and publishes ready. `false`, `0`, `null`, empty strings and arrays may be ready when the schema allows them. Draft values need not yet pass the response schema; accepted answers must.

The editor returns a handle with:
- `update({ answer, active })`: apply controlled updates without echoing `onChange`; identical updates preserve selection/composition.
- `focus()`: host field-chain entry without DOM inspection.
- Optional `handleKeyDown(key): "handled" | "pass"`: narrow question-editor editing-key integration below.
- Optional `appendTranscript(text): void | Promise<void>`: explicit answer-dictation support.
- `dispose()`.

Mounting may be asynchronous. Publications update the host's current ref before returning. Scope every callback/handle to exact question and mount generation. Dispose late handles after abort/replacement; stale callbacks cannot publish, focus, consume keys, receive speech or submit.

Keep mounts alive across folding; update active state rather than reset the editor. Repeated canonical adoption of the same saved question must not remount it. Save answer/thinking drafts in the existing in-memory session model, keyed by occurrence. They survive dock/editor remounts and canonical adoption while the same model lives. Navigation that destroys that model, full reload and app restart need not preserve drafts; no new persistent draft format in v1. `empty` retains no value; use `unready` with a value to preserve an incomplete or whitespace draft.

## 9. Required keyboard and dictation integration

Existing app commands retain precedence: Shift+Tab cycles model thinking; configured model/dictation/navigation commands remain host-owned. Cmd/Ctrl+Enter is host question-submit, subject to readiness/IME gates. This does not choose a code editor's product keymap.

Inside the active eligible answer editor, offer plain Tab, plain/Shift+Enter and Escape to the optional editor callback before normal app interpretation. A handled key performs an editing action and is claimed exactly once; passing plain Tab reaches the private host field chain, not native browser focus navigation. Unclaimed Enter inside the editor belongs to its normal editing surface, not accidental native form submission. Keep the editor outside the submit footer's native form. Plain Enter outside editing surfaces retains the existing question-submit affordance. Host Thinking Enter remains a newline; Cmd/Ctrl+Enter submits.

Use a private host-owned key claim/dispatch seam before the provider's Tab prevention, with original Escape owner snapshotted first. Only the current expanded eligible editor can claim; covered/hidden/stale instances cannot. A claimed key cannot also invoke host field cycling/submission. Composition/229 events must not trigger editing commands, host submit or cycling. Separate private composition suppression from default prevention so composing Enter keeps its native default while host keyboard routing, Enter-submit hooks, reserved Mod+Enter and provider Escape dispatch skip it. Existing native-Tab prevention remains unconditional. No general public shortcut/field-scope API and no fabricated keyboard dispatch.

For plugin questions only, privately cycle the editor focus handle and applicable host field refs. Do not query inside arbitrary plugin DOM or change builtin chains.

Dictation destination:
1. Unrevealed check: existing host ReadingThinking field, regardless of `showThinking`.
2. After reveal/open probe or predict, `showThinking: true`: host Thinking field.
3. Thinking off and current editor explicitly supplies `appendTranscript`: that answer destination.
4. Otherwise microphone stays visible but disabled; never hidden-composer fallback.

ReadingThinking remains the existing check reading/reveal channel, not added to probe/predict; its continued display after reveal remains as today. Folding does not erase the question or redirect speech to the composer. Finish before reveal and before submit. An answer transcript callback must finish publishing before its promise resolves. Settle/cancel a capture before releasing an obsolete destination on dismissal/replacement. Mere button disabling is not capture teardown.

## 10. UI construction and fallback

Use a plugin-question sibling path in the existing BottomDock. Reuse its outer shell, measurement/fold/reveal machinery, StatsBar, toolbar and shared host atoms. Do not extract/rewrite the builtin QuestionDockForm state machine. Use the same card/typography classes; no visual redesign.

The host fallback shows saved learner-visible Markdown and status, respects check reveal pacing, disables submission and supplies `Dismiss question`. It never asks a plugin to fabricate an answer. Optional host Thinking/ReadingThinking stays under the selected host rules. Accepted answers without a renderer use readable learner-answer presentation, never raw authored payload.

Generic state copy: `Preparing question…`, `Question unavailable`, `Dismiss question`, and `Could not sync the saved session.` with `Retry syncing`. Inline plugin validation messages remain plugin-authored. Reuse existing host reveal/role/submit/dictation labels otherwise.

## 11. Implementation sequence and verification

1. Add public contracts, registration validation, pure snapshot/answer readers and identity tests.
2. Build accepted per-turn question tools, pose ledger, stream suppression/classification and settled canonical authority.
3. Add canonical submission/dismissal/compatibility and terminal reconciliation; integrate pending/history/model/wake/phase/position helpers.
4. Add owner-scoped frontend registrations and sibling card/editor/answered mounts, private keyboard/focus integration and host dictation routing.
5. Document API and lifecycle, add strict SDK-consumer checks and disposable fixtures, and perform independent review.

Required proofs:
- Native validated pose versus failed authoring; mixed batches; all temporary-ack carriers; unchanged ordinary/builtin behavior; metadata stripped from model input.
- Exact occurrence identity, historical duplicate IDs, normalized args, frozen schema authority, local-reference meaning under native payload embedding, finite JSON/verbatim strings and false/zero/null/empty answers.
- Duplicate/stale submission and alternate legacy-route bypass rejection; write-before-continuation; unavailable/disabled/missing/failed renderers; explicit incompatibility; no automatic cancellation on revision/number changes; silent cancellation/dismissal with no turn; unreadable protocols with insufficient identity must not cause guessed cancellation.
- Missed global settlement event, awaited canonical adoption, reconciliation-only retry, reload/resume pending authority.
- Controlled editor stability, folding, async mount/dispose, stale callbacks, field focus, editing Tab/Enter/Escape, host shortcuts, IME and covered scopes.
- Final dictation chunks before reveal/submit, reading-versus-thinking separation, opt-in answer routing, visible disabled microphone and no hidden-composer writes.
- Real packaged-browser proof through a disposable plugin and loopback mock provider/native turns; no live accounts or product plugin implementation needed.
- Full test suite/examples, typecheck/lint/diff checks, strict packaged-SDK consumer, isolated production build, packaged Electron/Chromium, privacy/tracing and production-byte audit.

Preserve the verified Markdown increment and peer-owned product paths. Implementation approval alone did not authorize staging or committing; the human subsequently authorized committing the feature-branch checkpoint. No push, release or product resumption is implied.

## 12. Verified implementation checkpoint — 2026-11-02

- **3,778 tests / 560 suites passed**, with no failures or skips. Whole-project type checking and diff checks passed. ESLint reported no errors and one pre-existing `source-name-ui` `<head>` warning.
- Independent backend/core review found no confirmed P1/P2. Frontend review identified three ordering/recovery defects; all were fixed, their three unchanged causal reproducers passed, and the final 126-test focused frontend run passed with no additional confirmed P1/P2.
- A fresh, credential-scrubbed isolated Next.js build and standalone curation passed. A separate strict consumer compiled the actual curated SDK with `skipLibCheck: false`, including question registrations, typed payload/answer definitions and renderer slots, existing picker/Markdown APIs, and negative checks for excluded APIs.
- All **96 tracing manifests / 275,228 entries** had **zero private-root hits**. All **401 production files** under `app`, `components`, `src` and `lib` were byte-identical between the working source, isolated build source and payload, with no missing copies or mismatches.
- The packaged server ran under Electron's Node runtime outside the checkout and passed the live Chrome smoke with a public external plugin and loopback-only mock provider. Genuine native turns proved mixed failed/successful prediction posing, canonical editor admission, exact answer whitespace and separate host thinking, ordinary teacher review, natural fold/mount/selection retention, editing Tab/newlines and host Mod+Enter, check reading/reveal, a visible disabled microphone without answer-dictation opt-in, disabled-plugin fallback and silent occurrence-bound dismissal. Existing Markdown, overlays, native number-input and admission checks also passed.
- CDP captured all three question streams through `[DONE]`; only exact matching HTTP-200 terminal cancellations were classified as expected. There were no page errors or off-origin requests. Final STT delivery, IME/229 and missing/replaced-renderer behavior have focused causal coverage; this is not a claim of real microphone capture or OS IME verification.

Evidence: `/tmp/lh-question-final-gates-Q7Hu4L/`; isolated package and build/SDK/payload/browser logs under `/tmp/lh-question-isolated-package-MH6M2n/`; browser screenshots and `plugin-browser-evidence.json` under `/var/folders/3x/m0pk52v160jcprrhcb6qkd340000gn/T/lh-plugin-browser-evidence-20Ls0y/`.

Observed follow-up, left unchanged: trusted upward wheels over an ordinary transcript prose wrapper did not move the transcript, whereas wheels over its blank margin did and naturally folded the dock. No intentional wheel-owning surface was identified; the cause and whether this pre-existed or depends on the question state remain causally unresolved. The browser proof uses the working natural blank-margin interaction and does not establish that all transcript wheel targets behave correctly.
