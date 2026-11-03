# Plugin question tools — bounded v1 contract

> **Commit closeout — 2026-11-04:** The verified UI-polish, question-card, native-default/reconnection and opening-animation changes are included in this feature-branch commit, together with Coding Questions and UI Showcase. “Uncommitted” notices below retain their original verification-time status; this note supersedes them for the current Git state. No push or release is implied.

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

Canonical synchronization is connection-scoped: effect cleanup/detachment invalidates that connection's task; reconnecting the same pending question must start or join a task for the new connection, never an obsolete null-owner task. Detached completions cannot publish readiness/failure over replacement state. Keep epoch/ticket stale-read fences and genuine current-read failure/Retry behavior. A stable question-identity effect must run again on effect reconnection instead of treating a retained identity ref as proof that synchronization already succeeded.

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

Existing app commands retain precedence: Shift+Tab cycles model thinking; configured model/dictation/navigation commands remain host-owned. Cmd/Ctrl+Enter is host question-submit, subject to readiness/IME gates. The human-approved native-default amendment makes **Enter submit and Shift+Enter insert a newline in both the answer editor and host Thinking**, without requiring a plugin to implement submission keys. The footer uses the native `↵ submits · ⇧↵ newline` hint and `Submit answer` label.

Inside the active eligible answer editor, offer plain Tab, plain/Shift+Enter and Escape to the optional editor callback before normal app interpretation. A handled key performs an explicit plugin editing override and is claimed exactly once. Omission or `pass` uses host defaults: plain Enter is claimed for host submission, Shift+Enter retains the editor's native newline editing without triggering a host submit, and plain Tab reaches the private host field chain rather than browser focus navigation. Keep the editor outside the submit footer's native form; submission is host routing, not accidental HTML form behavior. Plugins may deliberately override editing keys, but the coding plugin inherits plain-Enter submission and only augments Tab/Shift+Enter indentation.

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

Opening geometry is host-owned. If editor admission or another content-size change alters the natural shell height during an active opening morph, retarget from the current visible height over the remaining original animation time. Do not retain a stale destination that clips the already-mounted Thinking footer and snaps to natural height at completion. Preserve the existing editor lifecycle, animation timings, height constraints and reserve policy; do not add a delay, restart a full-duration opening, animate ordinary typing growth, or remount the editor to repair sizing.

The optional pending thinking field uses the native question dock's rounded, bordered background container, including its label and submit footer, with the human-selected **compact 40px minimum for every variant** and natural growth with content. A healthy working question has no `Dismiss question` action; that action is recovery-only when the backend is unavailable, a renderer is missing, or rendering fails.

Unknown canonical availability during synchronization or a failed read is not confirmed question unavailability. While syncing, use the existing `Preparing question…` status; on real sync failure keep the saved readable content and reconciliation-only Retry banner without adding a false unavailable/recovery-Dismiss state. Only a completed canonical check can authorize the unavailable fallback. An already admitted same-question/same-registration editor survives temporary unknown canonical authority read-only; no new editor admission or submission occurs until canonical readiness returns, and confirmed unavailability or identity/registration replacement still tears down obsolete authority. Draft publication authority is separate from submission readiness: a current async editor's initial publication or outstanding transcript delivery must still settle under the existing occurrence/registration/availability guards while interaction is temporarily inactive. Do not silently discard a valid captured transcript merely because synchronization or compaction changed readiness; the dictation engine treats a resolved append as delivered.

In submitted history, host reading thinking appears **above** the question card with the native `YOUR THINKING` label and initially expanded behavior. Answer thinking appears **inside** the card using `ThinkingBlock`'s native `inCard` styling and existing expansion behavior. Both remain outside the plugin-owned answered slot. Each channel combines its own text and images in one host block; answer images retain their existing host baseline. Preserve the existing defined-channel presence rules, including empty and whitespace-only text; this presentation correction does not introduce blank filtering, merge phases, or alter saved data.

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

## 13. Question-card native-parity checkpoint — 2026-11-03

The human approved a bounded presentation correction after reviewing coding questions: native pending thinking-field framing; recovery-only dismissal; reading thinking above the submitted card and answer thinking inside. The human explicitly rejected adding blank/whitespace omission rules. These changes are **implemented and verified, uncommitted on `feature/plugin-architecture`, not released**. Shared `ctx.ui` primitives, plugin APIs, saved envelopes, grading, editor key handlers and dictation routing are unchanged.

- **3,925 tests / 564 suites passed**, no failures, cancellations or skips. The focused dock/transcript run passed **27 tests**, covering all recovery paths, healthy/canonical-readiness states, native frame styling, preserved keyboard/ref behavior, defined empty/whitespace channels, native placement/expansion, image-only channels, combined text/images and renderer-slot isolation. Whole-project typecheck/lint/diff checks passed; lint has only the existing test-fixture `<head>` warning.
- A fresh isolated production/standalone build and strict consumer of the freshly curated SDK (`skipLibCheck: false`) passed. **96 tracing manifests / 277,413 entries / zero private-root hits**; **410 production files** were identical between working source, isolated source and payload. Independent read-only review found no confirmed P1/P2 in the three-file production delta.
- The extended public coding-plugin packaged proof passed using Electron's Node runtime and Chrome, disposable data, the unchanged built coding plugin and a loopback-only provider. It now genuinely **submits** a teach check, rather than stopping at reveal. Exact code, reading thinking and answer thinking were preserved in the POST, canonical result and next teacher request. Native DOM checks proved reading above/default-open and answer thinking inside/inCard/default-closed, with trusted clicks exposing the exact text. Defined blank/whitespace preservation and image layout have separate offline regressions.
- Pending fields matched canonical native classes and computed background/border styles; healthy questions exposed no Dismiss. A fresh second check used a unique occurrence, then backend disable retained both earlier answers and exposed only recovery dismissal. Dismissal canceled only that pending check without another answer, chat POST, turn or provider request. All **five expected loopback request/stream phases** completed; no page errors, off-origin requests or microphone attempts occurred. The verified payload remained byte-identical during the proof.

Evidence: `/tmp/lh-question-cards-tests-final.log`, `/tmp/lh-question-cards-build.log`, `/tmp/lh-question-cards-sdk-strict.log`, `/tmp/lh-question-cards-isolated-package-NUCzsG/`, and `/private/tmp/lh-coding-native-3tz94a/evidence.json` with pending/submitted/recovery screenshots. No real learner profile, paid provider, microphone recording, OS IME, code execution, staging or commit is claimed. The earlier wheel-over-prose follow-up remains outside this correction.

## 14. Native-default and reconnection checkpoint — 2026-11-03

The subsequent human-approved increment is **implemented and verified, uncommitted on `feature/plugin-architecture`, not released**. It supersedes the earlier Enter-editing/host-thinking-newline defaults and phase-sized plugin thinking minimum, not the preserved thinking-channel placement or defined-empty/whitespace rules.

- Host defaults now provide **Enter-submit / Shift+Enter-newline** in both plugin answer editors and host Thinking; Mod+Enter remains reserved host submission. Optional explicit plugin editing overrides remain possible. The coding plugin no longer overrides plain Enter; it retains Tab and Shift+Enter indentation. The native footer reads `↵ submits · ⇧↵ newline` and `Submit answer`. Thinking has a compact **40px minimum in every variant**, with natural growth.
- The reported navigation error was reproduced in a disposable **Next development** browser on all **10 pending-question returns/mounts**, despite **162 successful HTTP-200 session responses**. Actual React hook/model fixtures identified the cleanup-invalidated read, null-owner stale-task deduplication and retained one-shot identity gate. Ordinary pre-fix production navigation remained healthy; Activity reconnection is separately proven by React fixtures, not attributed to the current Next configuration.
- Reconciliation now fences task ownership by connection generation as well as consume owner. A stable identity effect starts fresh synchronization on reconnection. Canonical epoch/ticket fences and genuine failure/manual Retry remain intact; no replacement teacher turn is generated. Unknown authority is shown as preparing, not confirmed unavailability or a disabled recovery-Dismiss state.
- **3,965 tests / 564 suites passed**, with no failures, cancellations or skips. Focused card/frontend coverage passed **62 tests**; lifecycle/core regressions additionally prove StrictMode replay, hidden/revealed Activity, null-owner replacement, stale success/failure ordering, preserved drafts and real-error read-only Retry. Typecheck, lint, diff checks, fresh isolated production/standalone build and strict consumer of the freshly curated SDK (`skipLibCheck: false`) passed. The existing test-fixture `<head>` lint warning and two dynamic filesystem tracing build warnings remain.
- Read-only review caught and closed a transient implementation regression: readiness checks had discarded legitimate current-owner transcript completions and async editor initial publications. Original draft-delivery ownership safeguards are restored while user interaction stays inactive and submission remains canonically gated. Causal tests cover both transcript timing windows, host Thinking, async first publication, exact-once retention, no replay/reversion and continued stale/revoked-owner rejection. Independent closing review found no remaining confirmed P1/P2. This is not actual microphone verification.
- Final packaged proof passed actual **plain Enter from code** for prediction and **plain Enter from host Thinking** for teach-check submission, actual Shift+Enter newlines, synthetic composing/229 guard probes, exact answer/reading/multiline-thinking data in the canonical envelope and next loopback teacher request, native answered-card placement/defaults and fresh disabled recovery/silent dismissal.
- Final production **and** development browser navigation each passed **10 healthy returns/mounts**, including fresh-document mounts and held canonical reads: **no Retry clicks, false sync errors, false unavailable state, healthy Dismiss or navigation-induced model requests**. Held reads showed `Preparing question…`. Empty inputs measured **40px actual height** at factory 16px prose size; three-line thinking grew to **76px**, retaining a **192px maximum**; its frame grew from **109.39px to 145.39px**.
- Payload audit passed **96 tracing manifests / 277,497 entries / zero private-root hits**, with **410 byte-identical production files**. All three browser runs preserved the exact approved host digest; their byte comparisons retained **5,535 runtime files** and all **130 installed coding-plugin files**. No page errors, off-origin requests or recording attempts occurred.

Evidence: full Native `/private/tmp/lh-coding-native-7HLV1v/`; production navigation `/private/tmp/lh-coding-native-oE0g2v/`; development navigation `/private/tmp/lh-coding-native-aHcEYr/`; final host gates `/tmp/lh-question-defaults-final-{tests,types,lint,build}.log`; isolated build `/tmp/lh-question-defaults-final-isolated-package-kxuVdF/`. These use disposable profiles and a loopback-only provider, not real learner data, paid providers, OS IME or learner-code execution. The coding package was rebuilt at `plugins/coding-questions/dist/coding-questions`; updating a real installed copy is a separate action and was not performed. No staging, commit, push or release is implied.

## 15. Continuous question opening — 2026-11-04

The human approved a bounded host-only animation correction after frame-level investigation reproduced a two-phase first opening. It is **implemented and verified, uncommitted on `feature/plugin-architecture`, not released**. No plugin API, editor lifecycle, saved data, keyboard or dictation changes are included.

Before the correction, production and development traces showed the host measuring a **211.78px** height destination before the coding editor existed. Thinking was already mounted. Editor insertion increased natural height to **357.56px**, but the stale fixed-height animation clipped the whole **109.39px** footer until completion, then jumped about **146px** in one sampled frame. Warm reopens retained the editor and were smooth; asynchronous highlighting was separately ruled out. Investigation evidence: `/private/tmp/lh-coding-native-FNDJPu/` and `/private/tmp/lh-coding-native-hZnPXi/`.

A private height-only controller now retargets the same live opening animation when post-constraint layout observations detect changed natural height. It starts from the current visible height and consumes only the remaining original **document-timeline** animation time, including pending starts; no wall-clock timeout, added delay or full-duration restart is used. Temporary natural-height measurement restores the exact prior inline height/priority and retains CSS clamps. Existing 120ms height morphs, 160ms content fades, initial instant appearance, ordinary unanimated typing growth, closing behavior, reserve policy and retained editors remain intact. Cleanup disposes only the owned height animation and rejects queued obsolete observers.

- **3,988 tests / 566 suites passed**. The focused dock run passed **42 tests**, including timing/geometry, repeated and late retargeting, pending starts, same-target no-ops, clamps/style restoration, unchanged typing/closing, unrelated animation ownership and Activity/observer cleanup. Whole-project typecheck, lint, diff checks and a fresh isolated production/standalone build passed; only the existing lint and tracing warnings remain.
- Strict curated-SDK consumption passed, including an async question renderer without keyboard/animation readiness callbacks and negative checks that private morph controls are not public plugin APIs. Independent read-only review found no confirmed P1/P2.
- Privacy/source audit passed **96 tracing manifests / 277,665 entries / zero private-root hits** and **411 byte-identical production files**.
- Production and development frame traces passed cold prediction, first check reveal and warm reopening. Cold opens retargeted the **same animation instance** to **357.56px**, preserving visible height across each complete synchronous retarget. Thinking became progressively visible **44–64ms** after animation creation, before completion. The former approximately **146px** terminal jump became a **0.016–0.031px** subpixel difference. A running development retarget consumed **33.314ms** and retained **86.686ms**, with exactly the same document-timeline deadline before and after; pending starts retained 120ms without inventing a wall-clock deadline.
- Warm reopens retained both editor and Thinking DOM identities and needed no retarget. Settled code/Thinking typing produced **zero height animations**. At a **540px** viewport, the existing shared cap remained **392px**, with correct whole-content scrolling.
- The unchanged full five-phase Native regression passed Enter/Shift+Enter, synthetic composition guards, exact answer/thinking channels, history and fresh disabled recovery. Production and development navigation each passed **10 healthy returns/mounts**, with no Retry, false unavailable or healthy Dismiss. All five runs preserved the approved digest and **5,537-file payload**, with all **130 coding-plugin files** byte-identical to the frozen product. No page errors, off-origin requests or recording attempts occurred.

Final browser evidence: production opening `/private/tmp/lh-coding-native-7xTVux/`; development opening `/private/tmp/lh-coding-native-buhm3z/`; full Native `/private/tmp/lh-coding-native-XlX2w6/`; production navigation `/private/tmp/lh-coding-native-GWerVN/`; development navigation `/private/tmp/lh-coding-native-sPEMjv/`. Opening directories include `opening-afterfix-summary.json`, per-frame/mutation/animation traces and screenshots; all five include `final-byte-comparison.json`. These are disposable-profile, loopback-provider proofs, not actual microphone, OS IME, paid-provider or learner-code execution checks.

Host gates: `/tmp/lh-question-opening-{tests,types,lint,build,sdk}.log`; isolated build: `/tmp/lh-question-opening-isolated-package-vDB0QD/`. This remains uncommitted on `feature/plugin-architecture`, not released. No real-profile installation, staging, commit or push is authorized by this correction.
