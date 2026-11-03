# Native session extensions: images, submission interception and surfaces

> **Commit closeout — 2026-11-04:** The verified UI-polish, question-card, native-default/reconnection and opening-animation changes are included in this feature-branch commit, together with Coding Questions and UI Showcase. “Uncommitted” notices below retain their original verification-time status; this note supersedes them for the current Git state. No push or release is implied.

**Status: human-approved contract, implemented and verified. The human approved this plan and authorized implementation in this session. Original verification evidence is recorded in section 10. The human subsequently authorized committing that checkpoint on `feature/plugin-architecture`; it is not released. Section 11 records the later approved UI-polish amendment, implemented and verified but uncommitted.**

This increment extends native teaching/practice sessions through three primitives. Existing verified Markdown/question work and peer plugin work must be preserved and are included in the separately authorized feature-branch checkpoint. No push or release is implied.

## 1. Human-settled decisions

- Use existing toolbar action placements. No new message/card/composer contribution points in this increment; broader UI integration needs its own design.
- Only explicit typed image data is an image. Attached paths retain existing behavior, even when their extensions are image-like. No automatic file reading or image inference from paths.
- Ordinary images have host baseline transcript rendering, including inside thinking/answer containers. Aim for the existing embedded, centered figure presentation.
- Reuse native inline image blocks: `{type:"image", data:<base64>, mimeType:<string>}`. No image asset store, upload/reference service or drawing-specific format.
- Interceptors register in the frontend first. They may await existing plugin backend operations.
- Interceptors may transform actual learner answers, including quiz selections and plugin JSON. Identity and derived grading remain host-owned.
- Interceptor failure stops submission, reports the failure and retains learner input.
- Support image-only messages and practice thinking. Pending plugin input may also enable builtin question preparation before the native answer is filled; validate the final transformed answer afterward. Question requirements still apply.
- Interceptors receive read-only native history and current session/question/problem context.
- Model retries reuse already-accepted transformed input. Fresh submission attempts run interception. Steer-to-send fallback reuses prepared input without a second interception.
- Surfaces initially cover the whole session body, including its input area, but not the session top bar or sidebar.
- Surfaces stack and preserve mounted covered surfaces. Transcript-only coverage is a desirable later extension of the same abstraction, not another interface and not implemented now.

The remaining sections are the approved concrete implementation plan.

## 2. Scope and preservation

Included: frontend public contracts/runtime; typed learner image transport; native persisted/UI/model projections; strictly required form/dictation/grading/admission integration; session-body surfaces; SDK/docs/tests/package proof.

Excluded:

- Generic native send/steer methods, mutable agents or a general agent-event/context-hook catalogue.
- Backend submission hook registration.
- New card/message/composer action slots or generic transcript renderer registration. Existing tool/question renderers remain available; broader rich transcript contributions belong to the deferred UI design.
- A native file picker, clipboard-image import or drag/drop image importer. Plugins supply explicit image data through interception.
- Image assets/references, editable drawing storage, image expansion/download/inversion controls or a new Markdown-export asset format. Existing text export is not redesigned.
- Additional surface coverage regions, graph/plugin-route surface boundaries, suspension across native navigation or a migration of existing diagram/plan/Chains views.
- A rewrite of existing builtin HTTP grading authority, worker admission, question protocol or provider adapters.

## 3. Public submission contracts

Add `src/core/plugin-submissions.ts`, re-exported through the existing core and type-only plugin SDK entrypoints.

### Content and learner input

`PluginSubmissionContent` has `text: string` and `images: readonly ImageContent[]`. `ImageContent` is Pi's native image type. Content means text followed by its images; this contract does not promise arbitrary text/image interleaving.

`PluginSubmission` is a readonly discriminated union:

- `{type:"text", content: PluginSubmissionContent}` — a normal learner message; send versus steer is host delivery, not something a hook may select.
- `{type:"thinking", content: PluginSubmissionContent}` — thinking on the captured active practice problem.
- `{type:"answer", answer: PluginBuiltinSubmissionAnswer, thinking: PluginSubmissionContent, readingThinking: PluginSubmissionContent}`.
- `{type:"plugin-question-answer", answer: JsonValue, answerImages: readonly ImageContent[], thinking: PluginSubmissionContent, readingThinking: PluginSubmissionContent}`.

`PluginBuiltinSubmissionAnswer` contains only learner fields: optional `dontKnow`, `values` (stable option values, not display indices), `other`, `text`, `confidence`, plus `images: readonly ImageContent[]`. Thinking lives in the separate content channels, not duplicated inside this object. No correctness, committed answer, question snapshot, timestamp, routing identity or tool result is mutable input.

### Targets and context

`PluginSubmissionTarget` is a host-produced readonly discriminated context containing:

- `sessionId`, `sessionKind: "teaching" | "practice"`, and the submission `type`.
- For builtin/plugin answers: the exact captured tool occurrence; plugin questions additionally have question ID, plugin ID, type ID and contract version.
- For practice thinking: the captured active problem occurrence.
- Applicable content channel names.
- Current learner-facing question/problem presentation; builtin options include stable values and displayed labels, not grading keys. Plugin presentation context includes label/type/variant/applicability, not an additional promise of a sanitized generic representation of arbitrary plugin input.
- A host-minted `surfaceTarget` for the owning native view instance.

Exact public naming: `PluginSubmissionOccurrence` aliases the existing four-field occurrence shape (`messageId`, `contentIndex`, `toolCallId`, `toolName`). `PluginSubmissionChannel` is `"content" | "answer" | "thinking" | "readingThinking"`. Every target has `sessionId`, `sessionKind`, `type`, `channels` and `surfaceTarget`. The variants add:

- `type:"text"`: no additional target fields; `channels:["content"]`.
- `type:"thinking"`: `problem: {occurrence: PluginSubmissionOccurrence, statement: string}`; `channels:["content"]`.
- `type:"answer"`: `question` is the existing learner-facing `ClientQuestion` shape plus `occurrence` and optional `questionType`, with the actual displayed options/stable values. `channels` lists applicable answer/thinking/reading channels.
- `type:"plugin-question-answer"`: `question: {questionId, occurrence, pluginId, typeId, contractVersion, label, variant, showThinking}` using the existing snapshot field types. `channels` lists applicable answer/thinking/reading channels.

Target/context and input share the same discriminant. All nested context/input/history values are typed recursively readonly as well as runtime-frozen; a private mapped readonly type may implement this without adding another public capability.

`PluginSubmissionContext` combines that target with:

- `messages`: a recursively readonly, detached native-message snapshot. This is the browser's current native history, potentially including streamed, not-yet-durable content while a turn runs. It is neither rendered transcript text nor a promise of canonical persisted history.
- `signal`: preparation cancellation; not authority to cancel an accepted POST.
- `onAccepted(callback)`: register a per-attempt notification on acknowledged API acceptance, useful for consuming only the captured pending plugin input. It is live/best-effort, not a durable event/replay or exactly-once guarantee. Lost acknowledgment does not fire it or authorize clearing plugin input. Callback failure reports a plugin error, never changes an accepted submission into a failed one.

All mutable learner input and history objects handed to hooks are detached and deeply frozen. Identity is outside the returned input. Opaque surface targets and signals are host references, not JSON to clone or persist. Hooks may read full history already readable through the trusted backend learning API; the learner-facing presentation is a convenience, not a new data-security sandbox.

### Registration and ordering

```ts
interface PluginSubmissionInterceptor {
  id: string;
  priority?: number;
  hasPendingInput?(target: PluginSubmissionTarget): boolean;
  intercept(input: PluginSubmission, context: PluginSubmissionContext):
    PluginSubmission | null | void |
    Promise<PluginSubmission | null | void>;
}

// New PluginFrontendContext methods:
registerSubmissionInterceptor(definition: PluginSubmissionInterceptor): () => void;
refreshSubmissions(): void;
```

- IDs use the existing lowercase-hyphen identifier convention and are unique per plugin activation.
- Priority is a finite integer, default `0`; higher runs first. Ties sort by plugin ID, then interceptor ID. No user-facing ordering settings.
- Capture the active ordered hook set once per attempt. Later hooks see earlier output.
- `undefined` means pass through; a replacement must have the same submission type; `null` intentionally cancels without sending and retains drafts. Thrown/rejected/invalid output fails closed.
- Clone, validate and freeze returned learner input before passing it onward. Late mutation cannot change an accepted payload.
- `hasPendingInput` is synchronous and side-effect-free. Plugins call `refreshSubmissions()` after their external input state changes. A true result advertises external input that can initiate preparation, not proof that a final answer is valid. For builtin questions this may enable preparation before an initial selection/text answer exists; final validation still applies. Context-only attachments need not advertise pending readiness for a question that still requires native learner input. This never bypasses question identity/schema/choice validity or missing-renderer fallback authority.
- A predicate exception is reported as a plugin error and contributes no readiness; never interpret a failed predicate as available input.
- Plugin unregister/unload invalidates its captured participation and cancels preparation rather than silently omitting its contribution. New registrations join the next attempt.

## 4. Preparation and acceptance lifecycle

One shared runner covers normal/contextual/opening messages, busy composer steers, builtin/plugin question answers and practice thinking.

1. Capture the originating native-view/target occurrence and reserve the session's submission attempt **before any await**, preventing duplicate clicks while dictation is finalizing. Snapshot the ordered hook set once.
2. Finish existing dictation/editor finalization against that original target. Recheck its identity, then capture final learner input, form draft and readonly history/context; never switch to a newly current question merely because finalization awaited.
3. Maintain a distinct preparation state, preserving the visible draft and preventing a duplicate submission from that native session. Cancellation must not discard final dictated text that belongs in the retained draft.
4. Run asynchronous interceptors serially and validate output.
5. Recheck session instance, pending occurrence/problem, readiness and plugin ownership after awaits. Never silently retarget.
6. Rebuild builtin derived answer data through existing host grading; preserve exact plugin JSON/string answers apart from deliberate hook transformations.
7. Make the optimistic entry from prepared input, then use existing POST/admission/steer delivery.
8. Acceptance notification fires once for the acknowledged attempt, independently of whether model execution later succeeds. It must not fire for a refused request or twice for the steer fallback. Snapshot callbacks before delivery; registrations after an invocation finishes or its preparation is canceled are ignored. Invoke eligible callbacks without waiting for their asynchronous completion before consuming the native stream; report individual failures and continue notifying other live owners.
9. Release the preparation/delivery lease on acknowledgment or refusal, not at the end of model streaming. Preserve ordinary busy composer steering: the next fresh learner steer may prepare while the earlier accepted turn is still running. Do not wrap the entire streaming send promise in a submission lock.

UI proposals:

- While preparing, show `Preparing submission…` with a `Cancel` action using existing button/error styling. Cancellation aborts only pre-POST preparation, retains draft and ignores late plugin results, even if a plugin ignores its signal.
- Interceptor failure uses the native input's error area: `Could not prepare submission ({plugin name}): {message}. Your input has been kept.` No silent skip.
- Cancel ceases to be a preparation action once POST delivery starts. Preserve existing non-abortable accepted-POST behavior and native turn abort/detach semantics.
- Draft clearing follows confirmed preparation/acceptance boundaries, never happens merely because an async hook started, and must not erase newer edits. Plugin-owned pending content is never host-cleared; acceptance callbacks let its owner consume the captured revision.

Delivery/retry rules:

- Model failure retry, Continue, malformed-question retry, control-only Next and silent dismissals do not run content interception.
- Retrying a restored, unaccepted form via Submit runs a fresh attempt.
- A normal send repeated internally after a busy refusal or a steer-to-send fallback reuses its prepared payload and acceptance observers.
- On acknowledgment loss, preserve existing canonical reconciliation and exact-question guards; do not fire acceptance callbacks or clear plugin pending material based on a guess. Do not automatically invent a new content submission from an uncertain result. An explicit later submission is a fresh attempt; this increment does not introduce global request deduplication or exactly-once transactions.
- In the between-problems composer, empty text with pending plugin material is a content submission, not the control-only Next action.

## 5. Answer transformation without a second grader

Builtin dock submission crosses preparation as raw learner input rather than pregraded `QuestionAnswerData`.

- Capture the actual rendered `QuestionData` privately, including deterministic shuffle and resolved grading; do not expose it as mutable hook data.
- Combine reading-thinking and final dictated fields before interception.
- Validate transformed learner fields against the captured kind/mode/options: correct types, finite confidence, known unique option values, selection cardinality, valid combinations, meaningful content and channel applicability. Do not silently drop unknown/duplicate selections. Preserve legitimate existing form payloads and current confidence rounding/clamping semantics.
- A private host callback calls existing `buildAnswer` with that same rendered question. Do not spread plugin-returned fields into the derived record.
- Recheck the original pending render key/exact occurrence after async preparation.
- Keep current builtin HTTP derived-answer contract; this is safe host recomputation around the frontend interceptor, not a general server-authoritative grading migration.

Plugin JSON still goes through existing canonical server schema/refinement/availability/occurrence checks. Host image channels sit alongside JSON, never become mandatory keys inside arbitrary plugin answer schemas. `showThinking` and reading applicability remain enforced.

For builtin questions, pending interceptor input may enable preparation even with no initial native selection or text. After interception, text-mode answer readiness requires nonempty answer text or answer-channel images; thinking/reading images alone do not satisfy it. Select-mode answers still require a valid final selection/Other/dontKnow state, which the hook may supply or transform. Reject incompatible dontKnow/selection combinations, duplicate/unknown values and mode-inapplicable fields, while preserving legitimate existing native payloads and confidence normalization. Plugin questions retain existing editor readiness and answer-state requirements before preparation; pending material cannot bypass them, though hooks may transform an already-ready JSON answer subject to final server validation.

Builtin answer and question-thinking channels are available across builtin kinds, consistent with existing AnswerRequest/buildAnswer fields; reading-thinking applicability follows the existing questionNeedsReveal/phase policy. Plugin questions always have answer content; thinking requires snapshot.showThinking, and reading-thinking follows the existing `variant === "teach" && input.type === "check"` policy. Public DTOs contain empty content values for inapplicable channels. Hooks must leave those channels empty: nonempty text/images there fail preparation rather than being silently discarded. Host adapters omit inapplicable thinking/readingThinking properties and image channels entirely from transport and persisted envelopes, preserving the current absent-versus-present plugin protocol.

## 6. Image transport, storage and projections

Use optional additive image fields alongside existing string fields so old records still replay without migration. New interceptor DTOs are adapted into the existing event-specific transport rather than posted as arbitrary native messages.

Exact additions:

- Text and steer inputs: optional `images: ImageContent[]` alongside `text`.
- Practice-thinking input and marker details: optional `images` alongside `text`.
- Builtin answer and practice-thinking inputs additionally carry the host-captured optional `occurrence: PluginSubmissionOccurrence`. New UI submissions always include it; old non-image callers remain compatible. Validate it against the canonical pending call/active problem after server awaits, rather than trusting only a potentially reused tool-call ID. Fresh image-bearing builtin/thinking submissions require the occurrence binding. This is strictly required async-target protection, not a builtin grading-authority migration.
- Builtin `QuestionAnswerData`, plugin answer input and canonical plugin answer details: optional `images: PluginSubmissionImages`.
- `PluginSubmissionImages` has optional `answer`, `thinking`, `readingThinking` image arrays. Channel absence means no images, and empty image arrays are omitted on write.

Each content channel's existing string remains its sole text authority. An image has no attached-path interpretation. Preserve plugin question envelope binding and all existing grading/question metadata.

Validation/preparation:

- Require native image blocks with nonempty base64 data, not Blob/File/object URLs/data URLs or path strings.
- Accept PNG, JPEG, WebP and GIF; sniff explicit bytes to verify the declared format. Reject malformed/unsupported blocks before persistence.
- Reuse the existing image processor and actual model resize policy. Existing defaults are a 2000×2000 bounding box and 4.5 MiB base64 payload per processed image; model-specific overrides still apply. No new arbitrary image-count settings or image-store service.
- Persist the successfully prepared/normalized image bytes; these are the accepted image representation rendered in history and sent to the model. Editable/original drawing data stays plugin-owned.
- Keep instant optimistic image previews. While the owning image-bearing POST is unresolved, defer transcript adoption so normalized canonical bytes cannot duplicate the original preview. Discard deferred snapshots and reconcile through a fresh canonical read when delivery resolves, including refusal or a lost acknowledgment. Retire only that attempt's provisional image entries on failure or ownership loss; preserve native drafts and plugin pending input, and never infer an acceptance notification from the reconciliation. This bounded reconciliation policy was explicitly approved by the human during implementation.
- Processing failure is a submission refusal, not a tool-style image-omitted text fallback. Do not inject processor hints as if the learner typed them.

Saved/UI/model placement:

| Submission channel | Durable/UI placement | Model placement |
| --- | --- | --- |
| Message/steer | Native user image blocks in the user container | Native user images |
| Practice thinking | Thinking marker details/images | Existing marker projection emits labelled text plus images |
| Builtin/plugin answer images | Answer container | Existing native answer tool result content |
| Question thinking images | Question-thinking container | Labelled thinking section in native tool result content |
| Reading-thinking images | Reading-thinking container | Separately labelled reading section in native tool result content |

Keep the host-owned answer envelope and compact answer text; add native text/image blocks in channel order: answer, thinking, reading-thinking. Labels distinguish image-only thinking channels. Metadata-only images would be a bug: they must reach both UI and model projections.

Host rendering:

- One shared submitted-image component, centered at natural width, constrained to its container, maintaining aspect ratio, with the existing figure-like embedded presentation and no new image toolbar.
- Available in user messages, answer presentation, ThinkingBlock/practice thinking, reading-thinking and host plugin-question fallback/answered rendering as applicable.
- Do not dim image pixels with thinking text styling.
- Image-only containers remain visible even without text. Text continues through existing PathText/Markdown behavior; `.png` paths stay path chips/text.
- Baseline accessible image label: `Submitted image`.
- Host-owned image channels render outside plugin-owned question/answer slots, so ordinary images remain visible even when a custom renderer renders only its existing question/answer data. This increment does not add image metadata to the existing question-renderer callbacks or introduce a second generic transcript/image-renderer registration.

## 7. Actual model capability and async races

Do not implement a parallel provider resolver. Use the actual effective engine the host will dispatch.

- New-turn/save-only answer admission uses the handler's existing conversation engine resolution. Reuse its actual image capability and resize policy. After all awaited image/preflight work, recheck canonical target and effective model/resize policy before save-only persistence or turn claim. No await may intervene between that final check and the corresponding synchronous acceptance write/claim. Agent construction receives the checked engine.
- Busy steers capture the private live-agent identity/model, prepare against its policy and synchronously verify that same target before the existing registry handoff. Future chat settings are not the live agent's model.
- If the captured live run simply settled, retain the existing busy-steer refusal/fallback; new-send admission prepares against its next-turn target without re-running frontend hooks.
- If a session/question/model or replacement live-agent target changed during preparation, refuse as stale and retain input rather than silently delivering to a replacement. Distinguish this from ordinary busy/settle refusal so automatic retries do not swallow it.
- Refuse fresh image-bearing input to an explicitly text-only effective engine. Custom endpoints retain the host's current policy of attempting image transport; remote rejection is still an ordinary provider failure.
- Existing historical-image behavior when later switching models remains Pi's current policy, including omission placeholders for text-only models. No broad history/model-switch behavior change in this increment.
- Existing ChatGPT, native subscription and Claude CLI image transports are reused. Claude CLI's existing text-before-images replay ordering is not redesigned.
- Preserve current memory-only parked-steer tradeoff; do not claim every acknowledged steer is already durably written or introduce a new durable steering queue. A successful steer acknowledgment may fire onAccepted, but does not promise durable history; later failure/restart does not replay that notification.

## 8. Public surface contract

Extend existing UI contracts:

```ts
// Opaque host-created identity for one mounted native session view.
interface PluginSurfaceTarget { /* private unique-symbol brand */ }

interface PluginSurfaceProps {
  title: string; // Required accessible name; not a host-rendered heading.
  background?: "dimmed" | "opaque"; // Default: dimmed (Chains-like tint + blur).
  content: PluginUiContent;
  onClose?: () => void | Promise<void>;
}

// New PluginUi method:
openSurface(
  target: PluginSurfaceTarget,
  props: PluginSurfaceProps,
  options: PluginWidgetOptions,
): PluginWidgetHandle<PluginSurfaceProps>;
```

- Existing session top-bar `PluginActionContext` gains `surfaceTarget`; submission target/context includes the same target. It is not an HTMLElement, selector, session ID to persist or backend-serializable token.
- A native boundary owns the target and selected body region. With live plugin/caller signals, an unknown or expired target throws synchronously: `Surface target is no longer active`. Already-aborted signals return an inert disposed handle, following existing widget convention. Recheck target lifetime when committing the mount; a late expiry disposes/reports rather than resurrecting content. Leave-and-return to the same session ID never revives a token. No arbitrary DOM-parent injection or global current-session guessing.
- Initial supported target is native teaching/practice session body only. Future coverage can extend this API without implementing unused regions now.
- Parent session stays mounted. New surfaces stack; covered surfaces remain mounted and painted, with only the eligible foreground content receiving covered-body interaction. Ordinary stack entries are visual siblings, not automatically each other's lifetime owners; disposing one plugin's lower surface must not dispose another plugin's foreground surface. Explicit caller signals may intentionally bind content lifetimes.
- Scope teardown on leaving the owning native view, plugin unload, caller abort or explicit dispose. Plugin-owned data may persist independently; surfaces themselves are not suspended/restored across navigation.
- Reuse PluginUiContent mounting, controlled update/dispose handles, async cleanup, error reporting and abort lifetimes. Content wrappers fill available width/height; replacing content cleans up exactly once, including late async cleanup.
- Use existing `view` interaction layers and explicit owner propagation; no body-modal semantics, app-wide background hiding, viewport scroll lock or second overlay registry.
- Keep logical ordering and painted stacking in agreement, including menus/dialogs above a surface. Follow the approved one-Escape rules; never dispatch submit/Tab/dictation actions into covered native inputs.
- Focus entry reuses the existing initial-focus preference: honor eligible focus already explicitly placed inside the new foreground surface; otherwise focus its first eligible editable text/number field or textarea, then an eligible plugin-content heading. With neither, focus the painted, labelled surface frame (`tabIndex=-1`), not the floating close action or a non-rendering semantic wrapper. Do not steal focus when a delayed mount finishes under a newer foreground layer.
- On foreground close, restore its captured opener if still eligible and uncovered, including exposed app chrome. Otherwise use the surviving foreground region's remembered eligible focus or its entry policy. With no plugin surface remaining, apply that policy within the native session body. Never focus covered/detached controls.
- Disposing a covered surface does not steal foreground focus. Native-view expiry never restores into the departed view. These entry/return rules do not trap focus or disable the exposed top bar/sidebar.
- Leaving/disabling an owning plugin closes only owned surfaces. Global Settings is not lifetime-owned by a plugin surface merely because it is painted above it.
- `onClose` follows existing dialog notification semantics, not a new asynchronous close veto. Programmatic disposal/abort retain existing handle cleanup semantics.

**Subsequent human-approved visual amendment — implemented and verified, uncommitted:** retain the exact session-body bounds but remove the host title/header row and inset frame padding. The required `title` is the region's accessible name, not an automatic visible heading. A quiet muted X floats above content without consuming a row and stays pinned while content scrolls; the content mount fills the body, reaches the session top bar and outer right edge, and does not inset its scrollbar. Plugins own visible headings and bottom action rows. `background` accepts only `"dimmed"` or `"opaque"`, validated on mount/update: omitted/`"dimmed"` uses the existing Chains-like background/80 and blur; `"opaque"` uses solid background without blur. The public widget update/lifetime contract is unchanged. Plugin dialogs receive the same headerless/floating-X treatment while retaining their existing modal frame bounds, backdrop and mechanics. No broader core-overlay redesign is included. Section 10 records the original visible-title presentation; section 11 verifies this amendment.

## 9. Implementation sequence and verification

Implemented and verified in this sequence:

1. Shared image/submission/surface types, strict validators, immutable preparation helpers, SDK declarations and contract tests.
2. Native image DTO/persistence/UI/model projection and actual-engine admission, with exact-target/async-race tests. Preserve existing question/privacy gates and provider/subscription semantics.
3. Frontend registry/ordered preparation, form/dictation/raw-grading integration, pending-input availability, draft/cancellation/acceptance handling.
4. Session-body surface boundary/stack using existing UI store and interaction infrastructure.
5. Documentation, public external fixtures and independent P1/P2 review. Only fix causal findings and add permanent regressions.
6. Full tests/typecheck/lint/diff checks; strict generated SDK consumer; isolated production/standalone build; payload tracing/private-root/source byte audit; packaged Electron/Chrome smoke with loopback mock, no paid providers or real learner data.

Required causal proofs include: path-not-image; image-only user/thinking/answer rendering; distinct thinking/reading placement; native model bytes, not metadata-only images; explicit unsupported-model refusal; raw-answer regrading after deterministic shuffle; invalid hook output; priority/composition; pending readiness refresh; failure/cancel retains drafts; final dictation before capture; stale occurrence/model/plugin/view; hooks that ignore abort; single interception across busy retries/fallback; model retry reuses accepted content; no acceptance callback on refusal; stacked mounted surfaces, correct bounds, one Escape, focus return, no covered-input actions, nested Settings, owner-scoped unload/navigation and late cleanup.

Implementation approval alone did not authorize staging or committing. The human subsequently authorized committing the feature-branch checkpoint; no push or release is authorized here.

## 10. Implementation verification

This increment is implemented and verified alongside the existing Markdown and bounded-question work on the feature branch. Historical verification counts for those earlier increments are separate checkpoints.

### Final gates

- Full offline suite: **3,869 tests across 564 suites**, with no failures, cancellations or skips.
- Whole-project TypeScript: passed.
- Whole-project ESLint: no errors; only the pre-existing `tests/source-name-ui.test.tsx` `<head>` warning.
- Diff whitespace check: passed.
- Fresh isolated Next.js production and curated standalone build: passed.
- Strict external consumer of the freshly emitted SDK: passed with `skipLibCheck: false`, physical isolated dependencies, positive interceptor/image/surface usage and negative readonly/protected-field/backend-pipeline checks.
- Payload audit: **96 tracing manifests, 277,077 entries, zero private-root hits**. All **410 production files** match byte-for-byte from the working tree to the isolated source and raw standalone payload, with no missing or mismatched files.
- Independent read-only P1/P2 reviews covered the shared contracts/projections, native server admission, frontend lifecycle/raw grading, surfaces and final normalization/opening deltas. No remaining confirmed P1/P2 finding was reported.

### Causal proofs

Permanent offline regressions cover structural and byte validation, effective-model/resize-policy refusal, exact occurrence and live-agent races, native persistence/UI/model projection, raw builtin regrading against the displayed shuffled question, pending material supplying the initial selection, immutable ordered hooks, final dictation capture, cancellation and newer edits, known-model changes, callback isolation, real busy-steer 409 fallback with one interception, and StrictMode-safe one-shot opening setup.

During integration, a real pre-acknowledgment normalization race was reproduced: append-only canonical adoption could duplicate an original optimistic image preview when the server resized it. The human selected the bounded deferral policy in section 6. Its implementation has **11 permanent regressions**, including refused/lost acknowledgments, failed reconciliation and delayed old ACK/GET races; the final delta review found no confirmed P1/P2 issue.

The fresh packaged Electron + Chrome smoke passed **23 assertion groups** across existing and new runtime behavior, with zero page errors, blocked external requests or unexpected HTTP failures. New checks used an ordinary external plugin and genuine native actions—not seeded answers/results or private host imports—to prove:

- Canvas PNG bytes are saved and reach actual loopback OpenAI-compatible `image_url` requests.
- Failed interception preserves the native draft, makes no POST (count **3 → 3**) and notifies no acceptance.
- Pending-input refresh enables an empty native composer to submit an image-only interaction.
- A verbatim plugin JSON-string/code answer can be transformed while answer, thinking and reading-thinking images remain distinct host-owned channels in history and model requests.
- A deliberate model failure followed by native Retry reuses accepted images without interception (**hook count 6 → 6**) or acceptance replay.
- A genuinely generated native practice problem accepts image-only thinking, persists its native marker and sends the image bytes to the model.
- A `.png` path remains text/path presentation, never an inferred image.
- Surfaces fill the actual painted session-body bounds, retain nested DOM state, expose title/X, sit below Global Settings, obey natural one-Escape ordering and expire opaque targets on native navigation.

### Evidence and boundaries

- Isolated source and payload: `/tmp/lh-session-isolated-package-0Vu03a/source`.
- Full tests: `/tmp/lh-session-full-tests-final.log`.
- Production/standalone build: `/tmp/lh-session-build-final.log`.
- Strict SDK and payload audit: `/tmp/lh-session-isolated-package-0Vu03a/final-sdk.log` and `final-payload-audit.json`.
- Passing packaged run: `/tmp/lh-session-browser-7.log`.
- Browser JSON and screenshots: `/var/folders/3x/m0pk52v160jcprrhcb6qkd340000gn/T/lh-plugin-browser-evidence-8jOHFr/` (`plugin-browser-evidence.json`).

Verification used isolated temporary storage and loopback fixtures, not paid providers or real learner data. The earlier wheel-over-transcript-prose follow-up is not claimed fixed by this increment. Broader UI placements, a native send/steer API, model-context hooks and additional surface coverage regions remain deferred. Nothing is staged, committed, pushed or released by this verification.

## 11. Subsequent UI-polish verification — 2026-11-03

The human-approved presentation amendment is implemented and verified on `feature/plugin-architecture`, **uncommitted and not released**. It does not change submission interception, grading, image projection or native question authority.

- Full offline suite: **3,908 tests / 564 suites**, zero failures, cancellations or skips. Whole-project TypeScript, ESLint (only the existing test-fixture `<head>` warning) and whitespace checks passed.
- UI Showcase: **17 tests**, strict public-SDK type checks and a frontend-only **18,421-byte** bundle passed. A separate consumer compiled against the freshly curated SDK with `skipLibCheck: false`, including both background presets and negative checks for invented targets, arbitrary opacity and plugin-selected knowledge-picker origins.
- Fresh isolated production build and standalone curation passed. **96 tracing manifests / 277,329 entries / zero private-root hits**; all **410 production files** matched the working tree, isolated source and raw payload byte-for-byte.
- Expanded packaged Electron-Node/Chrome proof passed with **223 requests / 217 responses**, zero off-origin, generation, microphone, WebSocket or page-error events. Only `GET /v1/models` reached the loopback catalog; settings, synthetic knowledge and the approved host payload remained unchanged. One canceled source read was narrowly expected.

Native proofs include accessible-only overlay titles, pinned floating X controls, outer-edge scrolling, transparent showcase content, dimmed **0.8 alpha / 8px blur** versus opaque **1 alpha / no blur**, nested surfaces/menus/dialogs/Settings, focus return and disable cleanup. They also cover self-contained 11px model controls, configured reading typography, the native standard-composer layout, continuous slider dragging (**52 → 44 → 36 → 26 → 16**, same enabled node, no disabled mutations), and all twelve worker status/presentation combinations with application Hint tooltips.

The unchanged knowledge-picker API now uses actual invocation ownership: page/session-surface origins get a main-pane view with interactive sidebar; modal origins retain a full-viewport modal. Eleven native origin/geometry cases cover sidebar configurations, native-control clearance simulations and route expiry. A global-modal picker belongs to its actual owner/widget, **not an unrelated background route**; a causal review finding here was fixed with pending/open regressions and independently re-reviewed. Covered-source retention is proved by hit-testing, unchanged DOM/draft/owner and trusted Tab/Shift+Tab/Find isolation—not by assuming that every cross-region view sets DOM `inert`. Existing modal and session-surface inertness policies remain intact. Reverse programmatic surface-over-picker ordering is a host-integration proof, not a claimed visible browser flow.

Evidence: `/tmp/lh-ui-polish-isolated-package-rPMHuU/source`, `/tmp/lh-ui-polish-tests-final.log`, `/tmp/lh-ui-polish-build.log`, `/tmp/lh-ui-polish-sdk-strict.log`, and `/private/tmp/lh-ui-showcase-native-ssfmL3/result.json` with nine viewport screenshots. Independent source/delta audits reported no remaining confirmed P1/P2. Windows/Linux checks simulate CSS window-control geometry; physical OS chrome, real microphone capture, OS IME, signed installers, paid providers and real-profile installation are not claimed. The separate proposed coding-question UI changes are not part of this checkpoint.
