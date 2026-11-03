# Plugin architecture — API v1

## Approved scope

LearnHarness supports trusted-local plugins, including optional official features,
using the same public API as externally installed plugins. Plugins are broad-capability
code, not a sandbox. Electron's renderer isolation and desktop HTTP credential boundary
remain in force. Backend code runs cooperatively inside the existing Node server;
broken code may require restarting the app.

The human approved implementation of this plan in the `feature/plugin-architecture`
worktree. Subsequent decisions: package management in **Settings → Plugins** and,
with the approved UI increment below, dedicated settings pages for enabled plugins
and explicit action placement instead of an automatic plugin sidebar group;
recoverable startup-only official-package updates rather than whole-directory swaps.
Interrupted package updates must block that package from loading until a successful retry. Package-specific update failures are
reported individually and do not prevent unrelated plugins from starting. These choices
do not authorize a marketplace, core learning-data mutation, or a flashcard product design.

## Package contract

A writable `<learning data>/plugins/<id>/` folder contains `manifest.json`, an optional
browser-module `main.js`, an optional Node `backend.cjs`, optional `styles.css` and
`assets/`, and persistent plugin-owned `data/`. See `src/core/plugins.ts` for the actual
manifest fields and public API types. Entries may use another root filename with the
same extension. IDs are lowercase hyphen-separated words and must match the folder.
API version is `1`; package/app version fields initially use numeric `x.y.z` versions.
Distribute built JavaScript, with dependencies bundled. Node built-ins are available
in backends. No runtime npm installation or native-module rebuilding is provided.

Disabled plugins are discovered without evaluation. New plugins, official or external,
are disabled until explicitly enabled. Code updates apply after a server restart;
refresh discovers manually installed folders, not hot replacement of running code.
Do not start timers, processes, or other side effects at module top level: activation
creates an instance and registers its cleanup; the module itself may remain cached.

Frontend entries export `activate(context)`; backends export `{ activate(context) }`
using CommonJS. Activation may return a cleanup function, and `context.cleanup(fn)`
registers additional cleanup. Backend lifecycle is per server; frontend lifecycle is
per window. View lifecycle is independent: closing a view is not disabling a plugin.

## Responsibility boundary

The plugin owns feature prompts, tools, UI, algorithms, schedules, and data. The host
provides:

- Plugin identity, paths, enable/disable, cleanup and compatibility checks.
- Full read access to learning records, graph evidence/provenance, and projections.
- App-configured model catalog and inference without exposing credentials as API data.
- Optional managed agent sessions and result-oriented tasks under the plugin's own data directory.
- Additive instructions/native Pi tools for the existing prober, teacher and practice agents.
- Shared fenced-block/tool-result renderers, including later background-result presentation.
- Host-owned view shells, explicitly placed actions, dedicated plugin settings pages,
  and controlled host UI widgets; navigation and live app notifications.
- A JSON operation bridge between the frontend and its own backend.

The backend learning-data API remains read-only; no new programmable core-write API is
exposed. The knowledge picker's existing user-driven source rename, folder creation and
drag organization are host UI operations, not backend learning-write methods. The learning-data
location remains available to trusted backend code; readers are conveniences that share
the host's file interpretation, not mandatory filesystem access control. Reads across
several files are not promised to be transactional. `readGraphFile` uses store readers:
for example `sources.json` returns source records, not the file's raw keyed JSON map.

Custom views receive an HTMLElement and a mount-scoped AbortSignal. A plugin may use
plain DOM or bundle React and mount/unmount its own root. Do not import private
LearnHarness components or rely on its React context. Public assets are only declared
frontend entry/style files and the explicit `assets/` subtree, never the backend or
`data/` directory.

## Host shell, actions and controlled UI

The exact contracts are `src/core/plugins.ts` and `src/core/plugin-ui.ts`;
`components/plugin-manager.ts` owns the per-window registration/lifecycle boundary.
`PluginView.mount(container, signal)` owns only the feature body. The host owns the
top bar, title, action layout/overflow, and plugin-settings gear. A mount may return
cleanup asynchronously; departure/replacement/disable aborts its signal. This is
separate from the activation lifetime.

Registering views/actions creates no automatic navigation chrome. Register an action
with `registerAction` first, then attach it using `placeAction({ id, actionId,
location, ...targets })`. Locations are `sidebar`, `graph`, and `top-bar`. Top-bar
placements require explicit `sessions` (`teaching`/`practice`) and/or `views` (the
placing plugin's view IDs) targets. Sidebar actions share the core teaching/practice
action area; there is **no dedicated plugin sidebar section**. Graph actions occupy
the host graph strip. Placement and registration have separate unregister handles.

Actions receive typed surface context: session ID/kind on session top bars, plugin/view
IDs on plugin top bars, or the sidebar/graph surface discriminator. Plugins supply
name, optional trusted SVG icon, disabled boolean/predicate, and `run(context)`.
`ctx.refreshActions()` explicitly asks the host to re-evaluate enabled state after
plugin state changes. The host owns surrounding buttons and async busy state, prevents
repeat invocation of the same action until its Promise settles, and surfaces errors.

`ctx.ui` is a framework-neutral controlled facade, implemented in the host tree rather
than exported private React components. It provides independently mountable composer,
dictation, model picker, thinking picker, knowledge picker, button, settings rows,
static Markdown and worker-result presentation; `mountStandardComposer` combines composer, dictation, model
and thinking controls as a preset. Menus and
dialogs are available via `openMenu` and `openDialog`. Every call takes
`options: { signal }` and returns a handle with shallow `update(partialProps)` and
idempotent `dispose()`. Widget scopes terminate on mount-signal abort or plugin disable.
Plugins retain values and callback/persistence policy; selectors never write core
model defaults or other core settings. No widget implicitly starts inference.

The standard composer deliberately excludes usage, practice controls, attachments and
default file/drop insertion. Dictation has an explicit plugin text destination, never
an implicit core composer/question target. There is one recording owner across core
and plugin instances in a window; another start reports “Dictation is active elsewhere”.
Only focused plugin controls claim their matching shortcuts, with core fallback otherwise;
An Escape owned by dictation cancels the recording owner; a handled Escape in a higher
interaction layer cannot also cancel it. The preset finishes dictation and awaits
transcript delivery before send. Independent widgets leave that coordination to the plugin.

Every enabled plugin gets a dedicated Settings navigation page, even without registered
settings or a frontend entry. The host displays an empty state when appropriate; package
management stays separate in Settings → Plugins. Both the view gear and
`ctx.app.openSettings()` select the owning plugin's page. `registerSettings` accepts
one `{ rows }` schema or a custom `mount(container, signal)` escape hatch. Rows support
toggle, text, dropdown, number and slider controls, controlled values, plugin callbacks,
optional validation/description/disabled state and numeric bounds. Schema validation
rejects invalid registrations; value validation prevents invalid commits. Async callback
failures are inline errors, not successful saves. The schema overload returns
`PluginWidgetHandle<PluginSettingsSchema>`: `update({ rows })` validates and publishes
accepted values, and `dispose()` unregisters; stale/disposed handles are inert. The
custom-mount overload retains its unregister-function return. Plugins own persistence
and backend validation, publishing rows only after a successful save; a custom mount
is not required for live updates, but may use `mountSettingsRows` itself. No general
declarative UI language or host-owned plugin settings store is added.

### Static Markdown rendering

The additive API v1 surface is `PluginMarkdownProps { text: string }` and
`ctx.ui.mountMarkdown(container, props, { signal }): PluginWidgetHandle<PluginMarkdownProps>`.
It retains the standard shallow `update`/`dispose` and per-mount cancellation contract.
The private `HostMarkdown` adapter reuses the actual shared host Markdown pipeline,
including math, highlighted code, tables, callouts, Mermaid, images and typography for
complete static content. It adds no dependencies or API-version bump.

Only built-ins render: registered plugin code-block renderers are excluded from this
surface. Copy/download/retry/expand/zoom/disclosure controls are all omitted. Ordinary
links retain native host new-tab behavior (`target="_blank"`, `rel="noopener noreferrer"`)
without an extra confirmation modal. Invalid Mermaid displays the existing error
heading/message plus source directly, with no retry/details controls. Plugins own data,
text and layout; this is not storage, inference, a worker result or a public React import.
Use it for generic static content such as card fronts/backs, not fabricated worker-result
shells. Missing capabilities require an explicit host contract decision rather than
private imports or a copied renderer. The implementation passed
[final Markdown verification](#static-markdown-final-verification--2026-11-02).

### Shared interaction foundation

The [human-approved dialog/overlay contract](dialog-overlay-contract.md) governs the
shared foundation, replacing the provisional picker-specific hiding/coordinator experiment.
Core and plugin surfaces share private `HostDialog`/`InteractionLayersProvider`,
`MenuShell`, popup ownership and content-view scopes. Existing visuals and domain flows
remain; this exposes no new SDK primitives or general public overlay framework.

Nested parents remain mounted and painted with state/scroll intact, but covered parents
are inert. One physical Escape belongs to its original topmost interaction, with leaf
handlers first; handled or blocked dismissal cannot cascade to a parent or fallback action.
Tooltips remain passive help, not Escape-owning layers; owned portals keep them painted
above the modal frame without intercepting the field/menu/dialog's Escape.
Native Tab/Shift+Tab navigation and primitive looping remain off. Existing explicit
field-cycle, question/thinking and rebinding actions remain scoped to eligible controls.
Preserve explicit initial focus; otherwise choose the first eligible editable field or
heading, never an action button. Child close restores eligible invoking focus only.
Settings field Escape follows validated blur/save, retains unsuccessful drafts and keeps
Settings open; credential Save and explicit rename cancellation retain their own rules.
Acknowledged full settings snapshots remain authoritative across close/reopen: older
responses and Settings/startup appearance GETs cannot undo a newer save or its appearance.
The newest full snapshot applies its appearance slice regardless of the section written.
A save finishing after reopen updates the current instance; fresh loads still read normally.
Busy deletion guards consume Escape without dismissal. See the contract for canonical-save
acknowledgements, editor-first ordering, popup-specific restoration and close outcomes.

Settings is a singleton. A fresh open nests above existing surfaces without discarding
them. Returning to existing Settings requests top-down closure through normal callbacks,
stopping on blocked, handled-without-closing or pending outcomes. Callbacks run at most
once per request, with no queued navigation or forced cancellation; retarget only when
return-to succeeds. Visual ordering is not lifetime ownership.

### Knowledge selection through existing host UI

The approved additive API v1 method is
`ctx.ui.mountKnowledgePicker(container, { value: readonly string[], onChange(ids), disabled? }, { signal })`.
Its `PluginKnowledgePickerProps` and standard `update(partialProps)`/`dispose()` handle
are defined in `src/core/plugin-ui.ts` and included in the generated type bundle. The
plugin chooses bubble placement, controls selected node IDs and owns persistence; the
host never writes plugin state.

The host reuses the exact existing `NodePickerControl` and real `ChainTableOverlay`, not
copies. The bubble shows **Pick nodes**, selected count and **Clear**; Clear emits `[]`.
Opening it presents a **full-window modal** using the existing translucent/blurred Chains
appearance. The background, including the sidebar, is inactive. Existing core
Graph/Practice Chains remain nonmodal content-area views with unchanged bounds and
sidebar interaction; only the new plugin picker gets this modal presentation. Checkbox
changes are immediate controlled updates. Done, X and an unconsumed selector-owned
Escape close only the selector, retain controlled IDs and restore eligible invoking focus.
Reopening retains selection. The host supplies canonical graph/source organization,
loads lazily at first open following the existing new-practice pattern, and handles focus,
portals and mount-signal/disable cleanup.

Ordinary plugin views, plugin Settings and public `ctx.ui.openDialog` content use the
same public API, props and mount-signal contract. Launching Settings/public dialogs stay
mounted, **painted and visible underneath**, preserving state and scroll, but are inert
while covered—not `display: none`. New public dialogs and menus foreground normally.
Fresh Settings opens above the picker without discarding it; returning to already-open
Settings uses the shared guarded return-to rules above, not unconditional picker cancellation.

A generic exclusive opening slot allows one active selector through the shared controller's
normal close guards. Closing a previous selector retains its controlled IDs; it is not
automatically reopened. Newer UI openings or retargets invalidate old pending graph loads,
preventing stale promotion. The old picker-only foreground coordinator is not the foundation;
shared ordering, focus, close guards and lifecycle remain host-private.

Selection mode retains user-driven source **rename**, folder **creation** and **drag
organization**. It must not become a read-only source tree. Management Delete is not
available in practice-picker mode, as before. These existing host UI edits do not expose
new programmable core-write APIs or change the read-only backend learning API. Deck trees,
state, membership and selection limits remain plugin-owned; no generic deck/library-tree
host API is added. The shared foundation and modal picker passed the
[historical interaction verification gates](#historical-shared-interaction-final-verification--2026-11-02).

## Managed agents

Persistent session, active run and observing view are distinct lifetimes. The host
uses the installed Pi Agent loop, not a second general-purpose agent framework.
Definitions select instructions, an explicit model, tools, and optional stopping rules.
Sessions live in `<plugin>/data/agents/`; they are not a new core ChatKind and do not
trigger teaching extraction, graph writes, or teacher/prober behavior.

Two pause mechanisms are supported:

1. `kind: "input"` declares a tool whose result comes from external input. Its valid
   call becomes a persisted pending interaction. The run ends; no unresolved Promise
   or successful placeholder is persisted. `prepareArguments` can validate arguments;
   `resultSchema` validates submitted results; `formatResult` produces model content.
   Input tools do not have `execute` or `endRun`.
2. A server tool executes normally and may use `endRun: true` to end the run after
   a successful result. Later explicit user messages continue the conversation.

Required pending results must all be present before another model request. A failed
argument validation is an error result, not a pending question. Request identities
make retried input idempotent. Accepted input is durable before a run starts; tool
calls are checkpointed before side-effecting execution. Completed tool results are
checkpointed, too. Persistence failures must not claim successful acceptance.

`send(id, explicitText, {requestId, purpose})` starts or continues a task; purpose is
`user` or `background` and the host's existing connection policy applies. `run()`
resumes existing runnable input; it never invents a user message such as “Continue.”
Tools are registered by the backend. Frontends submit through plugin-defined bridge
operations, so plugins own their interaction policy and interface.

Navigation/reload detaches the view without stopping server work. Snapshot observation
reattaches to current state and response-so-far, not an ever-growing chunk replay log.
App/server shutdown does not preserve live execution. Waiting inputs survive restart;
a run interrupted during execution is reported as interrupted, not auto-replayed.
An interrupted incomplete tool batch cannot safely continue automatically; explicit
new input can establish recovery context while the original history stays on disk.
The host does not promise exactly-once execution of arbitrary external side effects.

Inference and managed calls use host-owned authentication/transport and usage collection.
Plugins supply request content and supported generation options, not credential/transport
callbacks. Contributions to core teaching/practice use that conversation's existing engine,
authentication and usage path, not the plugin's independent worker model selection.

## Agent and content contributions

Backend `registerInstructions` and `registerTools` explicitly target prober, teacher and/or
practice. Instructions append to built-in/overridden system-prompt segments; native Pi tools
append to the built-in registry. A fresh synchronous factory receives immutable chat identity
for each turn. Core names remain reserved even if toggle-disabled. Deterministic package-ID
order resolves ownership; a collision/invalid factory omits the offending package's complete
loadout for that turn and reports a visible diagnostic without disabling its other services.
Successful re-evaluation clears that diagnostic. Basic schema hygiene is not a universal
provider-compatibility guarantee. Disabling fences captured tools and aborts cooperative
execution; running conversation prompts are not rewritten.

Frontend `registerCodeBlock` and `registerToolRenderer` use the same HTMLElement/cleanup
model as views. Source, metadata, incomplete-fence state and native result details/content
are public data—not private React components. Built-in exclusive presentations remain
reserved; ordinary generic presentation is extensible. A presentation plugin may render
another plugin's tools. Abort signals and generation-owned DOM prevent stale mounts from
clobbering replacements. Missing/disabled/failing renderers preserve readable raw content.
These hooks do not add a new pending learner-input protocol or change question grading.
Existing compaction behavior is deliberately unchanged: valid provider usage anchors remain
the normal basis, with an estimated appended tail; the rare unanchored fallback does not
include plugin instructions, and changing prompt/tool contributions does not refresh an old
usage anchor. The current trigger prefers `usage.totalTokens` whereas the visible measured
meter sums input/output/cache-read/cache-write. This increment does not align those paths or
promise exact pre-request context sizing for arbitrary contributions.

## Bounded native plugin questions

The [human-approved question contract](plugin-question-contract.md) defines bounded v1;
exact public contracts are `src/core/plugin-questions.ts` and the context registrations in
`src/core/plugins.ts`. Backend `registerQuestionType(PluginQuestionTypeDefinition)` and
frontend `registerQuestionRenderer(PluginQuestionRenderer)` return unregister functions.
The implementation passed the [question verification checkpoint](#plugin-question-verification-checkpoint--2026-11-02)
and is implemented and verified on `feature/plugin-architecture`, not released.
Migration checkpoint `792671e` remains historical evidence.

This is teaching question enrollment, not a generic pending-input/forms SDK. `probe?` and
`teach?` explicitly name native tools; at least one variant is required, and each enrolls
only its own prober/teacher role, not practice. `showThinking` is required host policy,
not model-authored. Host tools accept `{ question, payload }`, plus teach-only
`{ type: "predict" | "check", nodeId }`; live plan applicability and existing positioning/
reveal rules remain host-owned. Common non-whitespace Markdown supplies readable saved
fallback without guessing a public field from payload. One accepted per-turn package
snapshot admits ordinary tools, question definitions and instructions together; failed
admission omits all of that package's contributions for the turn.

Definitions supply stable ID/label, positive safe-integer `contractVersion`, persistable
question/answer schemas and optional synchronous, side-effect-free refinements. Compile
the saved self-contained JSON representation; preserve local JSON Pointer meaning when
embedding payload. No external/runtime schema dependencies, coercion, cleaning or string
trimming are permitted. Finite JSON and raw strings retain `0`, `false`, `null`, empty
strings and arrays when allowed. Refinements validate structure/semantics, never grade;
async/thenable refinements are rejected. A schema-valid incorrect answer remains valid.

The host owns validated pose execution, a frozen accepted registry and a private pose
ledger. Saved `lhQuestions` occurrence metadata uses local protocol version 1 without a
global chat migration. A successful snapshot binds stable question ID, exact native
occurrence, historical input/schemas, variant/node policy, Thinking and refinement
requirements. Attempts have visibility annotations but no pending authority. Temporary
engine pose acknowledgements are filtered, not saved as learner results; errors and
ordinary sibling results remain. Successful mixed-batch poses stop for input without
changing builtin stopping behavior. Raw authored payloads/private reference material
never become generic expandable traces, including failed/live/unavailable attempts;
safe fallback uses common question Markdown/status. App-only metadata is removed from
model input; it is not plugin permission to edit native history.

Editors become actionable only after canonical persistence, adoption and terminal
reconciliation. Sync failure offers reconciliation-only retry, not another teacher run.
Submission checks exact occurrence and saved schemas, finishes dictation, rechecks active
refs/readiness, then saves the genuine native result before ordinary continuation. A
host single-submit latch, stale/duplicate guards, legacy-route rejection and existing
sibling-question/owed-turn discipline prevent bypass or extra turns. The host builds
`PluginQuestionAnswer` with canonical identity/time, plugin `answer` and applicable host
Thinking/ReadingThinking channels in native result details; plugins never author that
envelope or replace its model-facing JSON. Host-owned cancellation/dismissal is not a
learner answer and does not automatically run the teacher.

Compatibility is exact: compatible package changes retain `contractVersion`, historical
schemas remain authoritative, and required historical refinements need a same-contract
implementation. A newly added refinement does not rewrite old acceptance. Only explicitly
listed `incompatibleContractVersions` (or a genuinely unreadable host protocol with enough
exact binding) permit quiet host cancellation. A version/package/hash change alone does
not. Missing/disabled backend, unknown version, missing required refinement or unavailable/
failed rendering stays pending with host fallback/dismissal. No frontend incompatibility
claim, version ranges, automatic migration or plugin history-rewrite hook is added.

Renderers are owner/type/version-scoped slots inside the host card. Optional `mountQuestion`
defaults to host Markdown; optional `mountAnswered` defaults to readable accepted answer.
`mountAnswerEditor` receives immutable saved identity/input, signal, active state and
atomic `PluginQuestionAnswerState`: empty (no value), or unready/ready with finite JSON.
A current handle must publish ready synchronously; values need not be truthy. Update
must not echo publication or reset identical selection/composition. Async mounts/late
handles and callbacks are fenced to exact mount generation. The handle owns focus and
disposal; optional key handling is limited to `Tab`, `Enter`, `Shift+Enter`, `Escape`,
with handled/pass outcomes. Host shortcuts, Shift+Tab model-thinking, Mod+Enter submit,
IME suppression, private field cycling and normal editing precedence stay host-owned;
there is no generic public shortcut/field-scope API or plugin-DOM probing.

Stats/session metadata, microphone, model/model-thinking controls, fold/reveal and
submit/dismiss remain host-owned/present. Check ReadingThinking is independent of
showThinking. Speech goes to ReadingThinking before check reveal, then host Thinking
when enabled; Thinking-off answer speech requires editor `appendTranscript`, otherwise
the visible microphone is disabled with no hidden-composer fallback. Final transcript
publication is awaited before reveal/submit; obsolete destinations settle/cancel capture.
Folding preserves mounts/drafts. Drafts persist only in the existing in-memory session
model across remount/adoption, not navigation that destroys it, reload or restart. Posed
questions and accepted answers remain durable; no persistent editor-draft store is added.

**Teacher review only:** no assessment hook/schema/result, node-assessment API, async
grading stage, execution service or new worker lifecycle. Plugins may expose separate
ordinary tools if desired. Builtins and their grading are unchanged. Generic forms,
extra button/dialog/layout catalogues, source metadata and installer work remain deferred;
both product implementations remain paused.

## Native session extensions — implemented and verified

The [human-approved session-extension contract](plugin-session-extension-contract.md)
is normative for this increment. **Implemented and verified on
`feature/plugin-architecture`; not released.** The human separately authorized committing
all changes and preparing the branch for a human-performed push, not an agent push or release.
The [3,869-test session-extension checkpoint](#native-session-extension-verification-checkpoint--2026-11-02)
records this increment's SDK, packaging/privacy and exercised browser proof. Earlier
Markdown, question, interaction and packaging checkpoints remain separate historical
evidence. The existing question/Markdown WIP and product pauses remain unchanged. Exact public definitions are in `src/core/plugin-submissions.ts`,
`src/core/plugin-ui.ts` and the frontend context in `src/core/plugins.ts`; the
[authoring guide](plugin-authoring.md#native-session-extensions--implemented-and-verified)
details their use. The contract is also part of packaged authoring documentation.

### Immutable frontend preparation boundary

Frontend `registerSubmissionInterceptor(PluginSubmissionInterceptor): () => void` and
`refreshSubmissions(): void` extend native learner submission, not backend agent hooks
or generic native send/steer. IDs are lowercase-hyphen and activation-unique; finite
integer priority defaults to 0, high-first, with plugin-ID/interceptor-ID ties. Capture
one ordered set per attempt; run serially, feeding each validated/frozen output onward.
Pass-through is undefined, same-type replacement transforms learner input, null cancels;
exceptions/invalid output fail closed with drafts retained. Captured unregister/unload
cancels preparation rather than dropping a contribution; new registrations wait for
the next attempt.

Raw DTOs distinguish text, practice thinking, builtin answer and plugin-question answer.
`PluginSubmissionContent` is text followed by native images. Builtin learner fields
(values use stable option IDs) exclude correctness/identity; plugin answers remain finite
JSON with separate answer images. Thinking/reading content is separate. The host retains
the rendered deterministic shuffle/grading privately and calls existing `buildAnswer`
after strict type/mode/choice/cardinality/confidence validation. This does not migrate
builtin HTTP grading authority. Plugin historical schema/refinement/availability and
exact-occurrence validation remain authoritative; inapplicable nonempty channels fail,
with absent transport fields preserved rather than new empty protocol properties.

Targets carry session kind/ID, same discriminant, applicable channels, learner-facing
question/problem context, exact `{ messageId, contentIndex, toolCallId, toolName }`
occurrence where applicable, and opaque `surfaceTarget`. Detached recursively readonly,
runtime-frozen input/history cannot mutate identity. Context `messages` is the current
browser native snapshot, including potentially streamed/not-yet-durable content—not
canonical persisted history or rendered text. Opaque targets/signals are host references,
not serializable data; trusted history access is not a security sandbox.

Synchronous side-effect-free `hasPendingInput` plus explicit `refreshSubmissions()`
permits external input readiness; predicate failure reports an error and no readiness.
Builtin preparation may begin before initial selection/text, but final transformed text
needs answer text/images and select mode needs valid selection/Other/dontKnow. Thinking
images alone never satisfy answer readiness. Plugin questions still require a current
ready editor/answer state before preparation; pending input cannot bypass renderer gates.

Reserve the attempt before awaits, finalize dictation/editor delivery for the original
target, then capture input/history. Recheck view/occurrence/readiness/ownership after
awaits; never retarget. Distinct **Preparing submission… / Cancel** state retains drafts
and final dictated text; pre-POST cancellation fences late output even if a hook ignores
abort. The native error area reports
`Could not prepare submission ({plugin name}): {message}. Your input has been kept.`
The preparation signal is not accepted-POST cancellation authority. Optimism derives
from prepared input. Release the lease on acceptance/refusal, not stream completion,
so later busy steers can prepare normally without erasing newer drafts.

`onAccepted(callback)` is per-attempt, live/best-effort acknowledged-API notification,
not durable replay, exactly-once delivery or model success. Successful memory-only parked
steers may notify without durable-history guarantees; refusal/lost acknowledgment never
authorizes consuming plugin pending input. Owners consume only their captured revision.
Snapshot eligible callbacks before delivery, ignore late registrations, report failures
without failing accepted input, and do not await callback completion before streaming.
Model retries reuse accepted stored/transformed content; Continue/malformed retry/Next/
silent dismissals do not intercept. Busy retries and steer-to-send fallback reuse a
single preparation and observers; explicit unaccepted-form resubmit is fresh. Uncertain
acceptance keeps existing canonical reconciliation/exact-target guards, not auto-replay.
Empty between-problems text with pending material is content, not control-only Next.

### Explicit image admission and projection

Only `{ type: "image", data: <base64>, mimeType: <string> }` is image input; even `.png`
paths retain existing path behavior. No picker, automatic file read/inference, data URL,
asset service or arbitrary rich-transcript renderer is added. PNG/JPEG/WebP/GIF bytes
must match declared formats and pass existing processing/actual effective-engine policy
(default bounds 2000×2000, 4.5 MiB processed base64 per image; model overrides apply).
Failure refuses submission rather than omitting images or manufacturing learner text.
Explicitly text-only engines refuse fresh images; custom endpoints keep current policy.

Optional additive transport/persistence fields preserve old records. Text/steer/practice
thinking carry images beside text; answer envelopes use optional `PluginSubmissionImages`
answer/thinking/readingThinking arrays, omitting empty arrays. Async builtin/thinking
admission binds captured occurrences (required for fresh image-bearing input), and final
canonical target/effective-model checks precede synchronous acceptance with no intervening
await. Busy steering checks the private actual live agent/model, not future settings;
ordinary settled-run fallback reuses prepared input, while replacement/stale targets refuse.
No parallel provider resolver or durable steering queue is introduced.

Accepted normalized bytes persist and reach both model-native image content and the
matching UI container, including image-only user/thinking/answer content. Keep instant
optimistic previews, but defer transcript adoption while their owning image-bearing POST
is unresolved, preventing raw-preview/normalized-canonical duplication. Discard deferred
snapshots and perform a fresh canonical read when delivery resolves, including refusal
or lost acknowledgment. Failure/ownership loss retires only that attempt's provisional
images, preserving native drafts and plugin pending material without guessing observers
or acceptance. This bounded reconciliation policy was human-approved during implementation.
Existing marker and answer-result projections label distinct answer/thinking/reading
sections in that order. Shared centered, natural-width, aspect-preserving figures use **Submitted image**
labels; thinking styling never dims pixels. Host image channels remain outside plugin
question/answered slots so custom renderers cannot accidentally hide them. Existing text
PathText/Markdown and historical model-switch/provider transport policies remain intact.

### Native-view-scoped body surfaces

`ctx.ui.openSurface(target, { title, content, onClose? }, { signal })` returns the normal
`PluginWidgetHandle<PluginSurfaceProps>`. Session top-bar action context and submission
context expose host-minted opaque `PluginSurfaceTarget`, not DOM/session-ID selectors.
Tokens expire with one mounted native teaching/practice view; return to the same ID never
revives them. Unknown/expired live targets throw synchronously:
`Surface target is no longer active`. Already-aborted signals yield inert handles; commit
rechecks expiry, and late async cleanup/content replacement cleans up exactly once.

The boundary covers the whole session body/inputs, **not top bar/sidebar**. Native and
covered plugin bodies remain mounted/painted; only eligible foreground body content
receives interaction. Ordinary stack entries are visual siblings, not lifetime owners;
lower-owner disposal/unload does not remove another owner's foreground surface. Caller
signals may explicitly bind lifetimes. Navigation, plugin unload, caller abort and explicit
dispose tear down only the appropriate scopes; Settings above a surface is not its child
lifetime merely by paint order. No suspension/restoration across navigation is added.

Reuse `PluginUiContent`, existing `view` layers and explicit ownership, not body-modal
semantics, global background hiding, viewport scroll lock or another registry. Body-bound
background/80 blur, p-4 framing and a slim visible-title/accessible-label Close/X header
surround a width/height-filling content mount, without a forced diagram viewport border.
One Escape keeps one owner; covered native submit/Tab/dictation is ineligible. Entry honors
eligible explicitly placed foreground focus, else first editable text/number/textarea,
then title heading. Late covered mounts never steal it. Foreground close restores an
eligible uncovered opener (including chrome), else surviving foreground remembered focus/
entry policy, then native-body policy. Covered disposal/expired views never steal/restore
focus. Exposed chrome remains interactive, with no focus trap; `onClose` notifies, never
adds an asynchronous veto.

No broader message/card/composer slots, backend hooks, native send/agent catalogue, image
importer/path inference/asset store, generic rich transcript renderer, extra surface
regions or graph/plugin-route targets are authorized. These remain deferred.

## Result-oriented workers and background tools

`ctx.workers` complements managed conversational agents: a task has immutable accepted
input, explicit model/purpose, bounded model-turn budget, native tools, a result schema and
optional semantic validation. `start` persists acceptance and defers execution; `wait` returns
a terminal outcome, never an ambiguous idle snapshot. One host `submit_result({result})`
tool provides correction feedback in the same native context. The first durably accepted
valid result wins, including falsy JSON values; subsequent batch effects and replacement
submissions are fenced. No-result exit, turn exhaustion, deadline, provider and storage
failures are not success. Storage uncertainty is not turned into an invented durable result.

Tasks use the existing native sub-agent runner, not another model loop. Records under
`data/tasks/` contain native history/progress, input/configuration and outcomes; usage also
uses the host inference ledger. Views/waiters do not own execution. Explicit cancellation
is cooperative. On disable/restart **all unfinished tasks become interrupted**, including
queued tasks and stored tasks in disabled packages. Retry is a new explicit attempt;
no automatic tool replay or JavaScript handler restoration occurs.

`createBackgroundTool` is a thin native Pi tool helper. It derives identity from the actual
conversation/tool call, starts background-classified work, persists a linked generic plugin
job, and returns an acknowledgement. The original native tool result remains that ack.
Completion uses the existing job/wake/steer pipeline, including live turn boundaries,
pending-question gates, consent, continuation coalescing and deterministic delivery IDs.
Model text and rendered data are separate; the later card reuses the tool renderer with
explicit background metadata rather than fabricating a native tool result.

The user-approved default result presentation is collapsed, sharing the research/PDF
completion/disclosure grammar. Host identity/status (and disclosure when collapsed)
remain authoritative; plugin renderers replace the body only.
`PluginToolRenderer.backgroundPresentation?: "collapsed" | "card" | "plain"` chooses
the shell for later host-delivered results, not the original tool acknowledgement.
`ctx.ui.mountWorkerResult` exposes the same choices through its `presentation` prop
for plugin-owned surfaces: default `"collapsed"` disclosure, expanded bordered `"card"`,
or expanded unframed `"plain"` for SVG/demos. All retain host identity/status and
host-delivered formatter errors remain visible. The helper also takes terminal status,
label, fallback text and optional custom `content`. Content may be an HTMLElement or a signal-scoped mount with cleanup, including
an async mount. Trusted SVG, interactive demos and other rich bodies are permitted;
this does not authorize unsanitized model HTML or hiding readable fallback results.

The canonical task outcome and delivery state are separate: formatter/unavailable-plugin
failure keeps the accepted result plus honest fallback. Worker completion ends the job's
computing state; END does not cancel completed work or its queued delivery. A generic
outcome is persisted before asynchronous formatting; live delivery waits for formatting,
but restart recovery can use that persisted fallback. Recovery reads safe persisted task
state even for disabled packages; it re-delivers results or reports an honest failure,
never replays preparation/tools/formatters. Durable delivery distinguishes result, learner
abort, and failure notices; missing/unreadable task state is not relabeled as learner abort.
The shared job adapter uses atomic fsynced replacement for durable linkage/result updates.

There is no DAG framework, guaranteed execution with the app closed, new plugin concurrency
pool or competing setting. Task computation and result delivery retain their existing
lifecycles; host admission does not add automatic retry or a new task-history screen.

### Shared host worker-request admission

Host admission establishes one process-global FIFO gate for
background **model request streams**, not whole agents. A permit is released when its
request ends, before tool execution or waiting for child work. The pool spans routes and
windows connected to the same app-server process; independent server processes do not
share it.

Settings → Agent → Models exposes **Concurrent worker requests** as
`agent.workerRequestConcurrency`, default **8** when unset. Any positive safely
representable whole integer (JavaScript safe integer) is valid, without an arbitrary cap;
invalid values are rejected rather than clamped. A live increase drains queued requests
immediately up to the new limit. A decrease lets active requests finish and waits until
the active count is below the new limit before admitting another request. Queued
cancellation prevents provider dispatch.

Extractor, auditor, researcher, demo builder, visual maker and PDF reader requests share
the gate with **all** detached `ctx.workers` tasks, including user-initiated tasks.
Direct teacher/prober/practice requests and their compaction, interactive plugin-managed
conversations and standalone raw plugin inference are excluded. `purpose` governs
subscription consent, not worker classification. The old whole-extractor-phase
three-permit wrapper is removed; source-serial chunks and the audit-through-merge FIFO
consistency lock remain. The frontend's three-file upload queue is independent.

Standalone `ctx.workers` tasks integrate into the existing **Background agents** panel:
one row titled **plugin name · worker definition ID**, with elapsed time, activity,
model and usage when available. There is no invented session link. **END** cancels
computing work, including queued work; completion still ends computing state without
cancelling pending delivery. A linked `createBackgroundTool` host job already represents
its task, so the standalone projection is suppressed to avoid duplicate rows. Canonical
task state and existing durable delivery/recovery semantics remain authoritative.

Request admission, activity registration and SDK engine operations/callback metadata are
host implementation details, not new plugin contracts or a public agent framework.
Plugins continue using the existing worker and background-tool APIs.

## Notifications and recovery

The app's existing single per-window notification connection carries plugin availability
changes and namespaced live plugin messages. These are not a durable arbitrary-event
log. A reconnect fires resync callbacks; plugins read a current snapshot. Plugin-specific
model/session observation must release connections on view departure and must never
cancel server execution just because a response reader disconnects.

## Distribution and updates

External installation copies built package contents with a root manifest and referenced
bundles, not the source project root, then refreshes the plugin list; preserve existing
plugin `data/` when replacing code. Official
packages ship in the app and are installed into the writable plugins location at startup.
Ownership metadata prevents silently overwriting an external package with the same ID.
Official code updates validate/stage first, use per-file atomic replacements, write the
manifest last, and preserve `data/`. A durable in-progress marker blocks loading an
incomplete update until startup retries successfully. Package-specific failure reports
block that package only; corrupt shared ownership/enable-state metadata is refused
rather than overwritten. This is recoverable, not a fully atomic whole-package swap.
Uninstall/data deletion and automatic community updates are not part of v1.

## Implementation increments and validation

1. Package/runtime host, activation, management state, native external module loading.
2. Frontend activation, custom view/settings/action surfaces and operation bridge.
3. Thin learning-data readers, catalog/inference and usage attribution.
4. Plugin-local managed agents and navigation/restart interaction recovery.
5. Off-network example plugins/testing, packaged external-plugin proof.
6. Authoring docs/types, template and coding-agent skill.
7. Additive native agent contributions and shared renderer surfaces.
8. Validated result tasks, native background-tool adapter and durable delivery/recovery.
9. Host view shell, explicit action placements, controlled UI helpers, dedicated plugin
   settings pages and shared collapsed result presentation.
10. Shared host worker-request admission and standalone worker activity integration.
11. Knowledge-picker control reusing the existing host Chains/source-organization UI.
12. App-wide shared dialog/menu/popup/view-scope foundation and full-window modal plugin
    picker integration.
13. Static host Markdown mount, built-ins only and without auxiliary controls.
14. Bounded native plugin questions and owner-scoped question/editor presentation.
15. Native submission interception, explicit learner images and session-body surfaces —
    implemented and verified on `feature/plugin-architecture`, not released, at the
    separate 3,869-test checkpoint below.

Validation includes focused lifecycle/storage/interaction tests, existing teaching/practice
regressions, typecheck/lint, production build and a packaged-server smoke with disposable
learner/auth directories. No actual user records or provider accounts are needed for these
checks. Full flashcards are the reference future consumer; generation cadence, review
algorithm, source/deletion policy, prompts and other product behavior require their own
approved specification.

### UI implementation note — 2026-11-01

This increment documents the approved host-shell/explicit-placement API, controlled
widgets and composer preset, exclusive explicit-destination dictation, dedicated settings
pages for enabled plugins with schema/custom mounts, and research/PDF-style collapsed result
default with a reusable rich-body result helper and explicit collapsed/card/plain
renderer presentation control. The hello-plugin, managed-agent and
teaching-extension examples now consume these public APIs. This scope does not add
automatic sidebar chrome, core settings writes, a general UI schema, or a new worker
execution model. Existing installed example copies are not overwritten.

### Native session-extension verification checkpoint — 2026-11-02

The native submission/image/surface increment passed **3,869 tests / 564 suites**, with
**zero failures or skips**, whole-project TypeScript, ESLint (**zero errors**, only the
existing `tests/source-name-ui` head warning) and diff checks. A fresh isolated Next
production build and standalone assembly passed. A physical external strict SDK consumer
passed with **`skipLibCheck: false`**. Privacy tracing checked **96 NFT manifests / 277,077
entries** with **zero private-root hits**; all **410 production source files** were
byte-identical, with **zero missing or mismatched files**. This increment is implemented
and verified on `feature/plugin-architecture`, not released. A subsequent fresh run again
passed the full **3,869 tests**, plus **47 flashcards tests**; these test results do not
broaden the host extension contract or establish product/release readiness. The human
separately authorized committing all changes and preparing the branch for a human-performed
push; no agent push or release is authorized. Historical **3,778-test question** and
**3,681-test Markdown** evidence below is preserved separately.

The final packaged **Electron-Node server and Chrome** scenario passed **23 assertion
groups**, with **zero page errors**, **zero blocked external requests** and **zero
unexpected HTTP responses**. Actual new-API proofs included:

- Genuine Canvas image bytes persisted and decoded from the provider's `image_url`, not
  metadata-only attachments; pending-input refresh enabled image-only submission.
- A failed interceptor left POST count **3 → 3**, acceptance count **0**, and the draft
  retained. A verbatim plugin JSON string containing code retained separate answer,
  thinking and reading image channels.
- Native model retry left hook count **6 → 6**, without replaying acceptance callbacks.
  An actual practice `problem` accepted empty-text thinking with images through its marker
  and provider projection. A `.png` path remained text, not image input.
- Exact session-body bounds/title/X, nested mounted surface DOM, Settings/one-Escape
  behavior and navigation-expired target rejection.

Builtin regrading after deterministic shuffle/pending initial selection and real busy
steer **409** fallback with a single hook invocation have focused **unit proof**, rather
than browser proof. Integration found a P2 raw-preview/normalized-canonical duplicate
before acknowledgment. The human-approved fix preserves instant previews, defers canonical
adoption during the owning POST, then makes a fresh canonical read on success, refusal
or lost acknowledgment, preserving drafts without guessed observers. **Eleven permanent
causal regressions** cover the fix; the independent delta audit was clear.

Final browser log: `/tmp/lh-session-browser-7.log`. Evidence:
`/var/folders/3x/m0pk52v160jcprrhcb6qkd340000gn/T/lh-plugin-browser-evidence-8jOHFr/plugin-browser-evidence.json`.
These fixture/loopback proofs do not establish real-provider quality/entitlement, actual
OS microphone/IME interaction, signed-installer behavior, a full Electron-window run or
Windows/Linux runtime behavior. The previously recorded wheel-over-native-prose follow-up
in [architecture](architecture.md#10-verification-seams) remains unresolved; this checkpoint
does not claim it fixed. Broader UI anchors/context hooks/native send remain deferred.

### Plugin question verification checkpoint — 2026-11-02

The bounded v1 host implementation passed **3,778 tests / 560 suites**, with **zero failures
or skips**, global TypeScript, ESLint (**zero errors**, one pre-existing head warning at
`tests/source-name-ui.test.tsx:27`) and diff checks. Following three P2 fixes, independent
**201 backend** and **126 frontend** checks plus **three unchanged causal reproductions**
passed; no confirmed P1/P2 findings remain. This host increment is implemented and verified
on `feature/plugin-architecture`, not released; migration checkpoint `792671e` and the
**3,681-test Markdown checkpoint** below remain separate historical evidence.
Both products remain paused, with no assessment, generic forms or installer scope added.

A fresh isolated Next production build and server assembly passed. The strict **external
packaged SDK consumer** passed with **skipLibCheck false**, NodeNext, ES2022 and DOM,
covering typed question definitions/renderers, rejected generic-pending/frontend-submit
capabilities, picker and Markdown. Privacy tracing checked **96 NFT manifests / 275,228
entries**, with **zero private-root hits**; all **401 production source files** were
byte-identical from checkout to isolated source to payload, with zero missing/mismatched
files. Authoring-document payload checks passed **11 tests**, including the question-contract
link target.

The packaged browser used an isolated **Electron-Node server, system Chrome, public
external plugin and loopback mock**. It exercised a native predict mixed invalid/valid
pose, canonical editor adoption, verbatim answer plus separate host Thinking, and ordinary
teacher review; trusted fold/selection, Tab, newline and Mod+Enter; check ReadingThinking/
reveal and showThinking-false visible disabled microphone; backend-disable fallback and
identity-bound native dismissal without a new turn. Existing Markdown, overlay, native
number-input and admission assertions also passed. CDP confirmed **all three SSE streams
reached `[DONE]`**; matching terminal `ERR_ABORTED` entries were narrowly explained for
those completed streams, not treated as general transport success. There were **zero page
errors or off-origin requests** in the exercised flow. Actual OS microphone capture and
IME interaction are **not browser-proof claims**; focused causal tests cover final STT,
IME, replacement and related ownership paths. See the
[authoritative question contract](plugin-question-contract.md) for scope and verification limits.

Artifacts: `/tmp/lh-question-final-gates-Q7Hu4L/*-v3.log`;
`/tmp/lh-question-isolated-package-MH6M2n/build-v3.log`, `final-sdk-v3.log`,
`final-payload-audit.json` and `browser-v3-script-reading-field.log`; browser evidence
`/var/folders/3x/m0pk52v160jcprrhcb6qkd340000gn/T/lh-plugin-browser-evidence-20Ls0y`.
These are fixture/runtime proofs, not real-provider quality/entitlement, signed-installer,
full Electron-window or Windows/Linux runtime guarantees.

### Static Markdown final verification — 2026-11-02

This is the historical pre-question Markdown checkpoint, not question-v1 verification.
The additive Markdown implementation passed **3,681 tests / 555 suites**, **four example
tests**, scoped and full TypeScript checks, full lint (only the historical no-head warning),
and diff checks. Independent P1/P2 review found no findings; **107 focused tests** passed.
A fresh isolated production build and full packaged-browser scenario passed. The strict
packaged-SDK consumer compiled **without `skipLibCheck`**, exercising the new mount,
update/dispose and expected type errors. All **393 production files** were byte-identical
between checkout, isolated source and standalone payload; **96 NFT traces / 273,716 entries**
contained **zero private-root hits**.

Actual new-API browser checks in both a plugin view and public dialog verified Mermaid
SVG, math, highlighted tokens, tables, callouts and a local image. Registered plugin
code-block counters stayed unchanged, auxiliary controls were absent, and invalid Mermaid
showed its error heading/message and source directly. Checks covered retiring a pending
diagram to plain text, updating back to a diagram, abort/dispose/remount sentinel
preservation, navigation/disable cleanup and acknowledged prose-setting updates.
Real new-tab navigation reached the expected URL while leaving the original page intact,
without a link-safety modal; the fixture was corrected to match existing host link behavior,
with no production fix or API/UX change required.

The same packaged run passed existing picker/source rename/folder/drag, nested painted/inert
parents, passive-tooltip Escape, native incomplete `1e` retention, canonical `3.0 → 3` /
`-5 → 12`, and admission regression checks. Local packaging/browser artifacts are under
`/tmp/lh-markdown-isolated-package-6sHn16`, including `browser-retest.log` and browser
evidence `lh-plugin-browser-evidence-bX4qCm`. This does not establish signed/notarized
installer behavior, a full Electron-window run, Windows/Linux runtime behavior or real
provider generation. The **3,665-test** migration checkpoint `792671e` below remains
separate historical evidence, not verification of the later Markdown API.

### Historical shared interaction final verification — 2026-11-02

The [approved contract](dialog-overlay-contract.md) is implemented by the shared modal,
menu/popup, keyboard and view-scope foundation, superseding the provisional hidden-parent
picker coordinator and unconditional any-Settings-open picker cancellation.

At migration checkpoint `792671e`, source verification passed **3,665 / 3,665 tests across 555 suites** with fresh
HOME/data/auth, **four example tests**, strict packaged-SDK consumer compilation **without
`skipLibCheck`**, typecheck, ESLint (only the existing no-head warning), and diff checks.
The final isolated production build, including the latest tooltip fixes, and full source-free smoke
passed using **Electron's bundled Node and real Chrome**. Privacy audit of **96 NFT traces /
273,464 entries** found **zero private roots**; all **392 app/components/src/lib files**
were byte-identical from checkout to isolated source to standalone payload.

Browser evidence covers the full-window picker, source rename/folder creation/dragging,
painted/inert nested parents, and guarded Settings singleton return-to/deep-linking. A
modal-owned passive Close tooltip was painted above Settings, yet one Escape closed Settings;
a focused menu tooltip likewise left one Escape to close only the menu. Native Chromium
editing-viewport inspection proved visible incomplete **`1e`** retained before/after Escape
in Agent and Appearance, with no invalid writes and no input-type/stepper change or human
fallback required. Existing field-specific canonical normalization (**`3.0 → 3`** and
**`-5 → 12`**) also passed. Admission regression exercised **1 → 2 → 1**, FIFO/live decrease
and panel END cancellation with **zero completed mock responses**, not paid-provider or
real-model generation.

Local artifacts: tests under `/tmp/lh-overlay-final-suite-kS7nJV`; packaged browser log
`/tmp/lh-overlay-isolated-package-tq6SQm/final-browser.log`, evidence `evidence-A6JwY3`.
These results do not establish signed/notarized installer behavior, a full Electron-window
run, Windows/Linux runtime behavior or real-provider inference. The older checkpoints below
remain separate historical evidence; none of these checkpoints verifies the later static Markdown API.

### Historical ordinary-view picker checkpoint — 3,530 tests

The ordinary-view picker checkpoint passed **3,530 tests**, packaged actual-browser checks
including source rename, folder creation and drag organization, the full admission checks,
and the SDK consumer check. This is historical evidence, not verification of the current
full-window modal picker or app-wide interaction migration.

The human-requested WIP checkpoint `2c44868` recorded **3,559 tests** before this migration.
It includes the provisional foreground experiment and is not final migration proof.

### Historical worker admission and activity verification checkpoint — 2026-11-01

The admission/activity increment passed **3,513 tests / 552 suites** under the default
test runner, plus **four separate example-UI tests**, typecheck and lint (zero errors;
one pre-existing warning already present at HEAD). An isolated source-copy production
build, server payload assembly and source-free smoke with Electron's bundled Node and
local Chrome all passed. Inert private-sentinel tracing found **zero** private sentinels;
the assembled payload contained no private records.

The browser exercised the actual Settings → Agent numeric control: **1 → 2 → 1**,
with each value persisted. Three standalone `ctx.workers` tasks appeared in Background
agents without chat links. The run verified live increase and FIFO admission; decreasing
the limit left two active requests running. END cancellations drained the active count
**2 → 1 → 1 → 0**: the third request was admitted after the second cancellation freed
capacity, and all three tasks ultimately became cancelled. The loopback mock OpenAI
endpoint received **three held protocol requests**, with **zero completed responses**.
This was not real model generation, a paid-provider call or real-account inference.
Unlike the historical rendering-only browser checks below, this admission check did
send those three local mock protocol requests.

A reviewer P2 reproduction confirmed that constructor-time abort had replaced native
usage **7** with **0**. It failed before the fix; the exact reproduction then passed,
preserving native usage **7** and identity without leaking a permit. The actual
extraction pipeline's audit-lock test likewise failed before the cancelled-middle-waiter
fix and passed afterward.

Local verification artifacts (temporary paths):

- Tests: `/tmp/lh-admission-verified-tests-bfXAdL/tests.log`.
- Isolated packaging: `/tmp/lh-admission-isolated-package-ovfxV0/final-package.log`.
- Browser evidence: `/var/folders/3x/m0pk52v160jcprrhcb6qkd340000gn/T/lh-plugin-browser-evidence-dVX3ym`.

These results do not establish signed/notarized installer behavior, a full Electron-window
run, Windows/Linux runtime behavior or real-provider inference.

### Historical implementation verification — through checkpoint `968ceaa`

The results below record earlier checkpoints, including the UI checkpoint `968ceaa`.
They are historical evidence, **not verification of the admission/activity increment**;
that increment's distinct results are recorded above.

The UI increment passed **3,465 tests / 552 suites** under the default test runner,
plus the four standalone example-UI tests, typecheck and lint (zero errors; the same
existing `source-name-ui` warning). Its production build, payload curation and
source-free bundled-Node/Chrome smoke passed. Browser checks cover exact session/plugin
title typography, explicit placements, sidebar row-major scrolling above ten buttons,
graph-rail scrolling with the sidebar open/closed and pointer pass-through between
buttons, keyboard-accessible top-bar overflow, controlled composer/model shortcut,
dialogs, plugin settings gears/schema updates, renderer defaults and disable cleanup.
A strict TypeScript consumer also compiled against the emitted framework-neutral SDK.

Final suite verification exposed a pre-existing test-isolation bug: the background-tool
test's recovery sweep could deliver another test process's pending job from shared disk
stores. Clean pre-UI HEAD reproduced it; a cross-process write trace identified the
foreign delivery. That test now allocates private storage before importing application
modules and removes it after completion. No production scheduler or timeout was changed.

The initial host checkpoint (before additive contributions/workers) passed **2,229 tests**
(**468 suites**, no failures or skips), alongside `npm run typecheck`, `npm run lint`,
and the production Next build. `tests/plugin-integration.test.ts` exercises a native
external backend through the real host, inference adapter, managed Agent loop and
plugin-local store, including persisted input across disable/re-enable, validated
answers, end-run publication, idempotent retries and usage attribution.

The extended instructions/tools/renderers/workers checkpoint passed **2,342 tests**
(**479 suites**, no failures or skips), typecheck, lint, and the production build.
`tests/plugin-teaching-integration.test.ts` drives the teaching-extension example through
native tool execution, validated worker submission, separate result delivery, transcript
projection/persistence and usage accounting without provider requests. Worker/bridge tests
cover interruption, durable accept-one results, cancellation before dispatch, formatter
failures, and recovery without tool replay.

Integration with main **v0.4.1** (`e69e852`) passed **3,410 tests / 546 suites** with
no failures or skips, typecheck, and lint (zero errors; one existing warning in
`tests/source-name-ui.test.tsx`). The production build, payload curation and source-free
Electron/Chrome smoke also passed. The merge retains main's independent computation and
delivery lifecycle, model-aware tools, provider gates and named-core-role diagnostic
captures alongside plugin contributions and awaited native worker checkpoints. Unscoped
plugin workers do not acquire an invented diagnostic capture role.

Packaging verification exposed that Next 16.3.2 traces some runtime path producers even
without file reads, and instrumentation does not inherit route-level trace exclusions.
Comment-only per-expression opt-outs now keep mutable data/auth/debug paths out of the
payload while retaining shipped prompts. Controlled disposable builds checked independent
chat/graph/settings/jobs/override/auth sentinels; `tests/runtime-path-tracing.test.ts` locks
the identified source boundaries. The main integration additionally exposed installed
plugin data to tracing: runtime plugin/service directories, inference usage filenames,
both recovery task-directory producers, and main's background-capture paths now carry
per-expression opt-outs. Independent Next 16.4.3 inert-copy builds confirmed that the usage
join and **each** task-directory join independently reintroduced private sentinels when
left unannotated; together the opt-outs removed them while retaining shipped prompts.
The production payload's existing data/secret refusal checks remain unchanged and run
before plugin SDK assembly. Two existing route-only broad-trace warnings (headless browser
spawn and PDF download path) remain; this is not a warning-free build claim.

After `node scripts/build-server.mjs`, the extended source-free check
`node scripts/smoke-server.mjs --electron --isolated --browser` passed. It copies the
standalone payload outside the checkout, rejects imports escaping that payload or the
fixture's plugin directory, boots with Electron's bundled Node, and drives local Chrome
through Settings enablement, sidebar navigation, native ES modules/relative assets,
backend RPC, view unmount/remount and disablement. Seeded native history also verifies
shared fenced-block/tool renderers, later worker-result presentation, and readable raw
fallbacks after disablement; those browser checks make no model calls. All fixture data/auth are disposable;
provider-adapter initialization is offline. The browser evidence retains the expected
keyless dictation `503` and absent favicon `404`, separately from plugin failures.

These are not claims of a signed/notarized installer test, a full Electron-window test,
real-account inference, or Windows/Linux runtime testing. Windows directory-fsync
behavior is tested through the installer's injected platform/IO seam; its documented
recovery limitation remains. No full flashcard feature is shipped by this change.
