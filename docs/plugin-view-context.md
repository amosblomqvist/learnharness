# Whole-session view context for actions — API v1

Whole-session read-only context is general infrastructure, not a Drawing Pad-specific
or current-question-only API. This describes the current checkout, including additions
beyond released 0.4.1. Public types live in `src/core/plugin-view-context.ts` and the
matching type-only SDK.

## Public entry point

A session top-bar action, or a shortcut action invoked on a session, receives readonly
`context.view: PluginSessionViewContext`. Keyboard invocations use `placement: "keyboard"`;
see [action shortcuts](plugin-authoring.md#action-shortcuts) for opt-in and scope rules:

```ts
ctx.registerAction({
  id: "inspect-session",
  name: "Inspect session",
  run(context) {
    if (context.surface !== "session") return;
    const view = context.view;
    console.log(view.title, view.messages.length, view.composer.text);
    if (view.input.type === "answer") {
      // The actual native display order, not a consumer-authored shuffle/parser.
      const options = view.input.question.options;
      const selectedValues = view.input.draft.values;
      console.log(view.input.revealed, options, selectedValues);
    }
  },
});
ctx.placeAction({
  id: "inspect-session",
  actionId: "inspect-session",
  location: "top-bar",
  sessions: ["teaching", "practice"],
});
```

The existing `placement`, `surface`, `sessionId`, `kind`, and opaque `surfaceTarget`
remain unchanged. Sidebar/graph contexts and plugin-owned-view action contexts do not
acquire a host session snapshot. Plugin-owned views retain their owner/view identity;
their owning plugin already owns their private state. There is no automatic serializer
for arbitrary plugin DOM or a new plugin-view context-provider protocol.

## Whole view, not just a submission

`PluginSessionViewContext` contains:

| Field | Meaning |
| --- | --- |
| `sessionId`, `kind`, `title` | The underlying session's identity, teaching/practice kind, and current committed title. |
| `messages` | Complete detached current browser-native history, with the same visibility as submission-context messages, including potentially streamed or optimistic content. |
| `transcript` | The existing host-projected transcript (`LhViewMessage` data), including its grouping and parts. Not a DOM serialization, screenshot, or independently parsed transcript. |
| `status` | Existing `ready`, `submitted`, `streaming`, or `error` session status. |
| `reconciliation` | Existing `ready`, `syncing`, or `failed` canonical-sync status. |
| `busy`, `compacting` | Current host turn/reconciliation and compaction state. |
| `phase` | The displayed `probe`, `plan`, `teach`, or `practice` phase. |
| `contextTokens` | Existing completed-conversation context-usage estimate, or `null`. |
| `queuedSteers` | Currently visible queued learner steers, with `id` and `text`. |
| `composer.text` | Exact unsent composer text, retained even while a question/problem owns the dock. |
| `input` | The host-selected current input, its applicable presentation state, and unsent learner values. |

History is **not** restricted to learner-facing question fields. It may contain tool
arguments, commitments, reasoning, custom payloads, and other already-exposed native
records. This trusted-local-plugin API does not create a new secrecy boundary or promise
canonical persistence, accepted delivery, or exactly-once semantics. Projected transcript
parts are view-model data; final rendering can still hide pending parts in favor of the
dock. Neither field is a claim that every byte is currently painted in the viewport.

## Current input and unsent learner input

`PluginSessionViewInput` reuses existing submission-target types, including exact
`{messageId, contentIndex, toolCallId, toolName}` occurrences, session identity, applicable
channels, and the existing opaque surface target. It is **not** a submission attempt.

- **`text`**: the existing ordinary-content target. The retained draft is `view.composer.text`.
- **`answer`**: the native learner-facing `question`, with actual displayed/shuffled option
  order, Markdown context, applicable option descriptions, exact occurrence, and optional
  `questionType`. Adds `expanded`, `revealed`, `available`, and `draft`.
  `PluginNativeQuestionViewDraft` contains `dontKnow`, stable selected `values`,
  `otherSelected`, `other`, `text`, `thinking`, `readingThinking`, and optional displayed
  numeric `confidence`. Other text survives even when its row is not selected. Values
  are raw drafts, not a normalized/graded answer envelope; whitespace is not trimmed.
- **`thinking`**: the existing native practice target/statement and exact occurrence,
  plus `expanded` and `draft.thinking`.
- **`plugin-question-answer`**: existing plugin-question target identity/metadata, plus
  saved `input` including payload, `expanded`, `revealed`, implementation `available`,
  and `draft: {answer, thinking, readingThinking}`.
- **`plugin-problem-submission`**: existing plugin-problem target identity/metadata, plus
  saved `input` including payload, `expanded`, implementation `available`, and
  `draft: {submission, thinking}`.
- **`unavailable`**: the host cannot interpret/read the pending input. Carries
  `expanded`, `revealed`, and the exact occurrence when known. It does not invent a
  composer/native fallback or manufacture an answerable contract.

Custom `answer`/`submission` draft state is the actual published editor state:
`{status:"empty"}` or `{status:"unready"|"ready",value:JsonValue}`. Finite JSON falsy and
empty values remain exact. Private editor state that a plugin has not published is not
read by inspecting its DOM. External plugin-private unsent material is likewise not
silently harvested. These fields are informational; neither `available` nor an editor's
`ready` state alone grants permission to submit.

The native question's structured `question` uses the existing `ClientQuestion` projection,
not its answer keys/explanation/committed answer. The complete history remains available
separately without artificial filtering. Reveal/collapse flags **describe** the host UI:
unrevealed question data is still inspectable, but a read never opens/reveals the question.
A consumer deciding what to render as a learner reference must use the supplied flags
and its own approved product behavior, not pretend that inspectable data is already visible.

## Snapshot, identity, and lifetime

- An actual action invocation captures a fresh snapshot **before** calling plugin `run`.
  Re-reading `context.view` during/after an await returns that same detached snapshot;
  it does not follow navigation, a newer occurrence, or subsequent learner edits.
- The snapshot's data is recursively readonly/frozen. Native history, projected transcript,
  input/payload, and draft values are detached from live host state. Captures do not grant
  setters, submission callbacks, or private component handles.
- Existing opaque surface targets remain live host capabilities. They are deliberately
  not JSON-cloned or frozen. A captured target still refers to its original underlying
  view; normal surface lifetime rules govern later use. A stale view cannot silently
  substitute a new session's content.
- Dynamic `disabled(context)` predicates receive the same read-only shape. Their
  render-time snapshot is lazy/shared for that render; the eventual click/shortcut captures anew
  and checks disabled state again. Host input owners notify ordinary React rendering
  when their public presentation/drafts change. Plugin-owned external state still uses
  the existing `refreshActions()` mechanism.
- Capture failures are contained by existing plugin action error handling. No action
  runs if its originating view has gone away before capture.

There is no public subscription/global mutable context API, screenshot service, raw keyboard
shortcut addition, or new session state model. A snapshot read does not finish dictation,
request microphone access, persist drafts, invoke submission interceptors, process/grade,
submit, acknowledge, or send a model request. It reports current typed/published values,
not a forced flush of pending speech.

## Host implementation and verification

`components/chat.tsx` supplies its existing native history, projected transcript, current
session metadata and shared submission-target factories. Its native dock publishes a
private view-local reader. Mounted question/practice components read their actual
presentation and ref-backed draft state; custom components expose their already-published
editor value and availability. Cleanup is generation-owned. No second history parser,
independent shuffle, DOM inspection, global store, polling, or product-plugin dependency
is introduced.

Tests cover portable SDK readonly/discriminated types, complete context copying, custom
payloads/editor states, unavailable input, real native input-owner reads, untrimmed drafts,
cleanup, inline/overflow action freshness, async capture stability, disabled predicates,
and capture-error containment. Browser diagnostics exercise real host top-bar actions,
`DockOverlay`, native/custom inputs and the snapshot helper with in-memory data; they are
not a packaged-app, real-provider, or actual plugin-installation proof.
