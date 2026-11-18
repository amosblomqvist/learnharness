# Session extensions: submissions, images and page-body surfaces

Current API v1 contract for the matching source/build; use documentation/types matching
the target app. Use the downloaded skill's `bundle.json` to identify the app;
API v1 alone does not identify every available capability. Exact types live in `src/core/plugin-submissions.ts`
and `plugin-ui.ts`. Custom practice submissions additionally follow the
[problem contract](plugin-problem-contract.md).

## 1. Boundary

Frontend interceptors prepare actual learner content; they do not provide native send/
steer methods, mutable agents, backend hook registration or generic model-context events.
Existing action placements launch UI. Only explicit native image data is an image: paths
retain their ordinary text/attachment behavior. There is no image store, native file-picker/
clipboard/drop importer, editable drawing format or new export-asset service.

The host owns routing, exact occurrences, derived builtin grading, acceptance and model
capability. Plugins own external input, intentional transformations, UI and persistence.
Surfaces cover page bodies, not arbitrary regions; no transcript-only coverage or navigation
suspension/restoration is provided.

## 2. Learner content

`PluginSubmissionContent` is `{text: string, images: readonly ImageContent[]}`. Images
are Pi native `{type:"image",data:<base64>,mimeType:<string>}` blocks. Text precedes images;
arbitrary interleaving is not promised.

`PluginSubmission` is a readonly discriminated union:

| `type` | Mutable learner channels |
| --- | --- |
| `text` | `content` (send vs steer is host delivery) |
| `thinking` | `content` on a captured native practice problem |
| `answer` | `answer: PluginBuiltinSubmissionAnswer`, `thinking`, `readingThinking` |
| `plugin-question-answer` | JSON `answer`, `answerImages`, `thinking`, `readingThinking` |
| `plugin-problem-submission` | JSON `submission`, `submissionImages`, `thinking` |

`PluginBuiltinSubmissionAnswer` contains optional `dontKnow`, stable option `values`
(not display indices), `other`, `text`, `confidence`, plus `images`. Thinking stays
separate. Correctness, commitments, timestamps, identities, question snapshots and native
result envelopes are never mutable learner input. Preserve finite JSON/raw strings without
coercion, trimming or truthiness filtering.

## 3. Targets and context

`PluginSubmissionTarget` is the host-produced readonly target, sharing the input's `type`:
`sessionId`, `sessionKind`, applicable `channels`, opaque `surfaceTarget` and variant data:

| Target | Additional data |
| --- | --- |
| `text` | `channels:["content"]` |
| `thinking` | `problem:{occurrence,statement}`, `channels:["content"]` |
| `answer` | Learner-facing `ClientQuestion` plus `occurrence`, optional `questionType`, actual displayed options/stable values; applicable answer/thinking/reading channels |
| `plugin-question-answer` | `question:{questionId,occurrence,pluginId,typeId,contractVersion,label,variant,showThinking}`; applicable answer/thinking/reading channels |
| `plugin-problem-submission` | `problem:{problemId,occurrence,pluginId,typeId,contractVersion,label,statement}`; `channels:["submission","thinking"]` |

`PluginSubmissionOccurrence` is exactly `{messageId,contentIndex,toolCallId,toolName}`.
`PluginSubmissionChannel` includes content, answer, submission, thinking and readingThinking.
Learner-facing builtin presentation has no grading keys. Plugin presentation is not a
promise of generic sanitization of arbitrary plugin payloads.

`PluginSubmissionContext` adds detached/deeply readonly/frozen `messages`, preparation
`signal`, and `onAccepted(callback)`. Messages are complete current browser-native history,
including potentially streamed/not-yet-durable content, not rendered text or a canonical
persistence guarantee. Full history is trusted-plugin visibility, not a secrecy boundary.
Signals/opaque targets are live host references, not JSON to persist/clone.

`onAccepted` observes this attempt's acknowledged API acceptance, independent of later
model success. It is live/best-effort, not durable replay or exactly-once delivery. Lost
acknowledgment never fires it or authorizes clearing external input. Callback errors report
a plugin error, not failure of an accepted submission. Snapshot eligible callbacks before
delivery, invoke without blocking native stream consumption on async observers, and continue
after individual observer failure. Late registrations/canceled-owner callbacks do not run.

## 4. Registration and ordering

```ts
interface PluginSubmissionInterceptor {
  id: string;
  priority?: number;
  hasPendingInput?(target: PluginSubmissionTarget): boolean;
  intercept(input: PluginSubmission, context: PluginSubmissionContext):
    PluginSubmission | null | void | Promise<PluginSubmission | null | void>;
}
// Frontend context:
registerSubmissionInterceptor(definition: PluginSubmissionInterceptor): () => void;
refreshSubmissions(): void;
```

IDs are lowercase-hyphen identifiers unique per activation. Priority is a finite integer,
default 0; higher first, then plugin ID/interceptor ID. Capture the ordered hook set once
per attempt; later hooks see earlier output. `undefined` passes through, same-type replacement
transforms, `null` cancels without sending. Throws/rejection/invalid output fail closed.
Validate/clone/freeze replacements before proceeding; late mutation cannot alter payloads.

`hasPendingInput` is synchronous and side-effect-free. Call `refreshSubmissions()` when
external state changes. True enables preparation, not final validity: builtin answers may
prepare before native selection/text exists, but custom questions/problems still require
a current ready editor value. Context-only attachments need not advertise native readiness.
Predicate exceptions report errors and contribute no readiness. Captured unregister/unload
cancels preparation, not silent omission; new registrations join the next attempt.

## 5. Preparation, acceptance and retries

One runner covers normal/contextual/opening messages, busy steers, builtin/custom answers
and native/custom practice submissions:

1. Capture the native view/occurrence and reserve one attempt **before any await**.
2. Finish original-target dictation/editor publication. Recheck identity; capture final
   learner input, form draft and readonly history. Never switch targets after an await.
3. Keep preparation distinct from delivery; preserve visible drafts and prevent duplicates.
4. Run ordered interceptors serially, validating each output.
5. Recheck instance/occurrence/readiness/plugin ownership. Rebuild builtin derived answers
   through native grading using captured rendered question data, not plugin-supplied fields.
6. Create optimism from prepared content; use existing POST/admission/steer delivery.
7. Notify acknowledged acceptance once, including internal steer fallback; release the
   preparation/delivery lease on acknowledgment/refusal, **not** model-stream completion.
   Fresh busy steers may prepare while earlier accepted work streams.

Preparation is silent: no progress row, label, spinner or preparation Cancel control is
rendered. Existing submission-disabled states and preparation errors remain. Internal
pre-POST cancellation (for example view disposal or interceptor unregistration) ignores late
hook results, retains drafts/final dictated text, and works even if a hook ignores its signal.
When no interceptors were captured, no history snapshot is allocated; payload validation,
target capture, reservation and eligibility checks still run. With interceptors, the complete
detached/frozen history snapshot is captured before the first hook, at the same preparation
boundary, and shared by the ordered hooks.
Failure uses `Could not prepare submission ({plugin name}): {message}. Your input has been kept.`
Once POST starts, preserve native accepted-delivery/turn-abort semantics; preparation
cancellation no longer applies. Clear only captured draft revisions at confirmed boundaries;
newer edits remain. Host never clears plugin-private material: its acceptance observer does.

- Model Retry/Continue, malformed-question retry, control-only Next and silent dismissal
  do not intercept content. Submit of a restored unaccepted form is a fresh attempt.
- Busy-refusal resend / steer-to-send fallback reuse prepared content and observers.
- Lost acknowledgment requires canonical reconciliation/exact-question guards, not guessed
  clearing or automatic invention of another submission. A later explicit submission is
  fresh; no global deduplication/exactly-once transaction is added.
- Between problems, empty text with pending plugin content is a submission, not control-only Next.

## 6. Validation and host authority

Capture native `QuestionData` privately with its actual shuffle/resolved grading. Combine
final dictation/reading fields before hooks; afterward validate types, finite confidence,
known unique values, cardinality/combinations, meaningful content and channel applicability.
Reject unknown/duplicate selections rather than dropping them. Preserve legitimate existing
confidence rounding/clamping. Build derived answers through existing `buildAnswer` against
that same captured question. This is frontend recomputation, not a builtin HTTP grading migration.

Builtin text answers need text or answer images; thinking/reading images do not satisfy it.
Select answers need valid final selection/Other/dontKnow (possibly supplied by a hook).
Plugin JSON follows canonical saved-schema/refinement/availability/occurrence checks.

Builtin answer/thinking applicability follows native fields; reading follows existing reveal/
phase policy. Plugin questions always have answer content, thinking only with `showThinking`,
reading only on teach checks. Public DTOs have empty inapplicable channels; nonempty injected
text/images reject. Transport/envelopes omit inapplicable channels, preserving absence versus
presence. Practice custom submissions have submission/thinking, not reading-thinking.

## 7. Images, transport and model admission

Use additive optional native image fields beside existing strings; old records replay without
migration. Text/steer/native-thinking inputs carry optional `images`; builtin/plugin answers
carry channelled images; custom practice carries submission/thinking images. Empty arrays omit
on write. Strings remain each channel's sole text authority. New builtin/thinking UI requests
include exact occurrence; fresh image-bearing requests require that binding, while old
non-image callers remain compatible. Recheck canonical target after server awaits.

Require nonempty base64 native image blocks, not File/Blob/URLs/path strings. Accept PNG,
JPEG, WebP, GIF only, sniffing bytes against MIME. Reuse actual model resize policy (existing
defaults: 2000×2000 bounding box and 4.5 MiB processed base64 payload per image). Persist
normalized accepted bytes for history and model; originals/editable drawings remain plugin-owned.
No new arbitrary image-count setting/store is added. Processor failure refuses submission,
not image-omitted success or synthetic learner hints.

Optimistic previews remain immediate. Defer canonical adoption while their image-bearing
POST is unresolved to avoid duplicate normalized/original previews. On delivery settlement,
discard deferred snapshots and reconcile afresh, including refusal/lost acknowledgment.
Retire only that attempt's provisional entries; preserve drafts/external input and never
infer acceptance from reconciliation.

| Channel | Saved/UI placement | Model placement |
| --- | --- | --- |
| Message/steer | Native user image blocks | Native user images |
| Native practice thinking | Marker details / thinking block | Labelled text + native images |
| Builtin/custom question answer | Host answer container | Native answer tool result |
| Question thinking / reading | Separate host thinking containers | Separately labelled sections in tool result |
| Custom practice submission / thinking | Marker details / submitted card and thinking | Labelled submission/thinking + native images |

Model bytes must be native image content, never metadata-only or base64 inside answer JSON.
Question result channel order is answer, thinking, reading-thinking. Shared submitted images
are centered thumbnails bounded in both dimensions by five lines of configured session prose,
without cropping/upscaling or dimming with thinking text. Clicking opens the same accepted
bytes in the existing session figure viewer with fit/pan/zoom and Escape/X close; without a
session viewer, the preview remains noninteractive. Thinking images remain inside their
thinking disclosure. Image-only channels stay visible, labelled `Submitted image`; text uses
normal PathText/Markdown. Host images remain outside plugin-owned renderer slots.

Resolve the **actual effective dispatch engine**, not a parallel provider resolver. New-turn/
save-only admission rechecks canonical target and effective model/resize policy after awaited
preflight; no await intervenes before acceptance write/claim. Agent construction uses that
checked engine. Busy steers capture live-agent identity/model, not future session settings,
and synchronously verify it at handoff. Settled-run fallback prepares against the next engine
without re-intercepting; changed/replaced targets refuse stale rather than silently retarget.

Text-only engines refuse fresh images. Custom endpoints retain current attempt-transport
policy; remote refusal is provider failure. Historical model-switch omission placeholders,
ChatGPT/subscription/Claude CLI transport and CLI text-before-images ordering remain native.
Parked steers retain existing memory-only tradeoffs: acknowledged acceptance can notify,
but is not guaranteed durable history or a replayable notification.

## 8. Public surface contract

```ts
interface PluginSurfaceProps {
  title: string; // Accessible name, not a visible host heading.
  background?: "dimmed" | "opaque";
  content: PluginUiContent;
  onClose?: () => void | Promise<void>;
}
openSurface(props: PluginSurfaceProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginSurfaceProps>;
openSurface(target: PluginSurfaceTarget, props: PluginSurfaceProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginSurfaceProps>;
```

`PluginSurfaceTarget` is opaque host identity, not DOM, a persisted session ID or backend
serializable token. Native action/submission context exposes it. Targetless invocation
captures the active page boundary **once synchronously** (plugin views, chat, Home, New Draft),
not a later page after awaits. Explicit targets identify one mounted native teaching/practice
view. Missing/expired live boundaries throw `Surface target is no longer active`; returning
to the same session never revives a token. Already-aborted signals return inert handles before
boundary resolution. Recheck expiry at mount commit; late expiry disposes/reports.

Coverage is only the page body. Top bars/sidebar remain usable; Home/New Draft preserve
floating sidebar toggle/window chrome while body graph/composer stay mounted but inactive.
Surfaces stack, retaining covered DOM/state/paint. Only eligible foreground content receives
body interaction. Ordinary siblings do not own one another's lifetime: removing a lower
plugin surface must not remove another plugin's foreground surface. Caller signals may
intentionally bind lifetimes.

Leave/hide of the owning page, unload, caller abort or dispose tears down the scope; re-entry
creates a new boundary. No suspension/restoration or arbitrary DOM-parent injection. Content
fills available width/height; controlled replacement disposes each old mount exactly once,
including late async cleanup. Existing view layers own ordering/paint and covered-input
routing, not another modal/overlay registry or viewport scroll lock.

Dialogs/Settings always remain in front, even if a surface opens from their content. That
surface belongs to the page, not the modal opener; it cannot inherit modal focus/Escape
eligibility. If the dialog closes and the signal remains live, the surface can emerge.
Do not dispatch submit/Tab/dictation into covered inputs. Closing/unloading a plugin removes
only its surfaces; global Settings is not lifetime-owned merely by being painted above one.

Entry preserves eligible existing/remembered focus, then a synchronously mounted visible
focusable `data-plugin-initial-focus` marker, then editable fields/headings/frame. No async
retry or autofocus-on-update. Without content targets, focus the painted labelled frame,
not its floating X/nonrendering wrapper. Late mounts cannot steal focus from newer layers.
On close restore eligible uncovered opener, otherwise the surviving region's remembered/
entry target. Covered disposal/page expiry cannot steal focus or restore into departed DOM.
No focus trap across the exposed top bar/sidebar is added.

Titles are accessible only. A quiet pinned X floats over content without a header row or
inset scrollbar padding. Plugins own visible headings/actions. `dimmed` (default) uses native
tint/blur; `opaque` is solid background without blur; invalid values reject on mount/update.
Dialogs share headerless/X presentation within their modal bounds. `onClose` is notification,
not an async veto. Abort/programmatic disposal follows normal handle cleanup. Shared
Escape/focus ownership follows the [interaction contract](dialog-overlay-contract.md).

## 9. Testing

Cover ordering/immutable transforms, readiness, final speech publication, stale occurrence/
model/view/registration, cancellation retaining drafts, busy fallback once-only interception,
acknowledgment uncertainty, native image bytes/UI/model channels and unsupported engines.
Surface checks include exact bounds, retained covered state, one-Escape ownership, focus return,
page expiry, modal ordering, owner-scoped cleanup and late mounts. Use isolated storage
and controlled providers when exercising the plugin in the app.
