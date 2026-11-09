# Plugin-defined practice problems — host API v1

Custom **practice problem types** share the native practice lifecycle, not teaching
questions, a second lifecycle, a separate conclusion tool or a new assessment system.
This describes the matching source/build. Match the target app using the downloaded skill's
`bundle.json`; API v1 alone does not identify every available capability. Public types live in
`src/core/plugin-problems.ts` and the type-only `learnharness-plugin-api` SDK.

## Shared lifecycle

- A backend registers one posing tool per problem type. It is contributed to **practice
  agents only**, subject to the existing package-atomic tool-name collision admission.
- Native and plugin poses share the same synchronous one-active-problem gate and graph
  target validation. Failed/dangling poses do not activate a problem. An acknowledged
  pose ends the turn, including mixed tool batches, and owes no automatic continuation.
  Before acknowledgment, the generic collapsible tool trace is intentionally unchanged:
  its expandable arguments may include the committed solution. The human explicitly
  accepted this, like inspectable agent thinking; no streaming presentation hint or
  additional pose protocol is required. Accepted poses use the statement-only problem card.
- Every pose has `statement`, `mode: "recall" | "discrimination" | "composition"`, optional
  `target: string[]`, required `modelSolution: string`, and plugin-defined `payload`.
  Common fields and their model-facing descriptions come from the native practice schema.
- The host persists the accepted plugin contract in the actual pose acknowledgment's
  `details.pluginProblem`. The saved contract, not a live registry lookup or a guessed
  tool name, identifies historical/active plugin problems. No second question ledger is
  needed: unlike teaching-question placeholders, practice acknowledgments already persist.
- One problem accepts multiple learner submissions. Only the existing **`conclude`** tool
  records the model's final assessment and closes it. The native conclusion card reveals
  the original pose's committed `modelSolution`; plugins do not supply a conclusion tool.
- Normal practice dismissal remains available and silent. Disabling/removing a plugin,
  missing a renderer, or declaring an incompatible contract does **not** replace the
  problem with a native text editor or lose its committed solution. Submission is
  unavailable until compatible implementations return, or the learner dismisses it.

## Backend registration

```ts
import { Type } from "typebox";
import type { PluginBackendContext } from "learnharness-plugin-api";

export function activate(ctx: PluginBackendContext) {
  return ctx.registerProblemType({
    id: "example",
    label: "Example problem",
    contractVersion: 1,
    tool: {
      toolName: "example_problem",
      description: "Pose a practice problem using the example editor.",
    },
    problemSchema: Type.Object({ starter: Type.String() }),
    submissionSchema: Type.String(),
    validateProblem(context) { return undefined; },
    validateSubmission(context) { return undefined; },
    async processSubmission(context) {
      context.signal.throwIfAborted();
      // Run plugin-owned checks against context.submission and the saved input.
      // Return observations, not the host-owned outcome envelope or a verdict.
      return { observedLength: context.submission.length };
    },
  });
}
```

`registerProblemType<Q extends TSchema, S extends TSchema>(definition)` returns an
unregister function. The definition contains:

- Required stable local `id`, `label`, positive safe integer `contractVersion`, `tool`
  (`toolName`, `description`), `problemSchema`, and `submissionSchema`.
- Optional `incompatibleContractVersions: number[]`; an incompatible saved problem stays
  active but unavailable. A differing version not listed is also unavailable.
- Optional synchronous, side-effect-free `validateProblem` and `validateSubmission`,
  returning `undefined`, `[]`, or readable error strings. Async/thenable validation cannot
  grant acceptance. Schemas follow the same bounded finite-JSON/local-reference policy
  as plugin questions. Neither validation nor schema admission coerces/trims the value.
- Optional `processSubmission`, synchronous or awaited, returning **finite JSON**.

Problem validation gets readonly `chatId`, `contractVersion`, and accepted common
`input` including schema-inferred `input.payload`. Submission validation additionally
gets `problemId` and schema-inferred `submission`. Processing adds `thinking: string`,
optional `images: PluginProblemSubmissionImages`, and host-owned `signal: AbortSignal`.
Owned JSON is detached/frozen; the live signal itself is not frozen. No private turn
controller, history accessor, scoring API, or conclude capability is supplied.

### Validate → process → save → continue

The saved schema and pose-frozen refinement/processing requirements govern **each**
submission. Required implementations must be available at the saved contract version.
New hooks do not retroactively change a previously posed problem's requirements.

The host validates synchronously, captures the exact implementation, awaits optional
processing, rechecks canonical problem identity/activation, saves one learner marker,
and starts one normal practice continuation. The marker stores separate `submission`,
`thinking`, optional `images`, and optional `processing`:

```ts
type PluginProblemProcessingOutcome =
  | { result: JsonValue }
  | { error: string };
```

`false`, `null`, zero, and empty JSON/string results are valid observations. Ordinary
throws, rejection, or non-JSON returns become `processing.error` on an **accepted**
submission. They are not a wrong-answer flag or a reason to auto-conclude. The model
reads the saved observations alongside the submission and thinking. Stored observations
are never recomputed on history projection, remount, continuation, or model retry.

Processing uses the existing inline turn-preparation owner, not a background job/queue
or another model request. It is attachable and excludes competing turns/submissions.
HTTP disconnect/navigation does not cancel accepted work. Stop, plugin disable, or exact
registration removal aborts its signal and prevents a late save. Ownership remains held
until the underlying callback actually settles: plugins must cooperate with cancellation
and own any execution timeout. Model/provider choice is captured for the admitted
submission; later picker changes apply to the next request. Plugin-problem POSTs do
**not** automatically repost after a 409. Explicit retry after a pre-save failure may
rerun processing; there is no across-crash exactly-once guarantee.

## Frontend registration and native dock

`ctx.registerProblemRenderer(renderer)` is owner-scoped by plugin ID and stable type ID,
with explicit `supportedContractVersions`. It returns an unregister function.

```ts
import type { PluginProblemRenderer } from "learnharness-plugin-api";

const renderer: PluginProblemRenderer<{ starter: string }, string> = {
  id: "example",
  supportedContractVersions: [1],
  mountSubmissionEditor(container, context) {
    const input = document.createElement("textarea");
    input.value = context.submission.status === "empty"
      ? context.input.payload.starter : String(context.submission.value);
    container.append(input);
    const publish = () => context.onChange({ status: "ready", value: input.value });
    input.addEventListener("input", publish);
    publish();
    return {
      update(props) {
        input.readOnly = !props.active;
        if (props.submission.status !== "empty") input.value = String(props.submission.value);
      },
      focus() { input.focus(); },
      dispose() { input.removeEventListener("input", publish); },
    };
  },
  mountSubmitted(container, context) {
    container.textContent = context.submission;
    // Optional context.processing is observational data; display it as desired.
    // context.headerContainer ?? container can host a generic ctx.ui.mountBadge.
  },
};
// During frontend activation: ctx.registerProblemRenderer(renderer).
```

Both mounts receive the saved `input`, `chatId`, `problemId`, `contractVersion`, and
an `AbortSignal`. `mountSubmissionEditor` also receives `active`, controlled `submission`,
and `onChange`. State is `{status:"empty"}` or `{status:"unready"|"ready",value:JsonValue}`.
A ready editor value is mandatory even when an interceptor has pending external input.
The required handle has `update`, `focus`, `dispose`; optional `handleKeyDown` and
`appendTranscript` use the same editor-handle vocabulary as teaching questions.

The native practice dock retains its statement, then inserts the plugin editor above
**Your thinking**, with one **Submit** button. After acceptance the editor value stays
for further revisions; only thinking unchanged since capture is cleared. The editor
and draft survive collapse and a busy processing/continuation cycle. Stale async mounts,
callbacks, registration replacements, and cleanup cannot mutate a successor generation.

Keyboard behavior shares the existing plugin-editor ownership/IME/layer guards: handled
keys stay with the editor; unhandled Enter submits, Shift+Enter is native editing,
Tab cycles host fields, and unhandled Escape moves directly from editor to thinking.
The reserved Ctrl/Cmd+Enter chord submits. Escape outside the editor retains native
practice discard-confirmation precedence. The host still owns thinking dictation.

`mountSubmitted` is optional and receives the exact accepted `submission` plus optional
`processing`; thinking/images stay host-owned presentation channels. Its optional readonly
`headerContainer` is a generation-owned inline suffix after the host label, sharing its
signal and cleanup lifetime. Optional readonly `footerContainer?: HTMLElement` is a
generation-owned block at the bottom of the submission card, after host submission images
and thinking. It shares that same signal/cleanup lifetime. Use it for output that belongs
below thinking; it is not available to `mountSubmissionEditor`. Never replace the host
heading or thinking, move surrounding DOM, or retain either slot across mount generations.
If either optional slot is absent, mount its content in the body. Sync/async mount failure,
replacement, StrictMode replay and unmount remove all three generation-owned slots.
Failure/missing renderers use readable saved-value/observation fallback; they do
not erase history or invent success/correctness badges.

## Images and submission interceptors

Plugin practice submissions participate in the existing preparation pipeline:

```ts
// Extract<PluginSubmission, { type: "plugin-problem-submission" }>
{
  type: "plugin-problem-submission",
  submission: /* finite JSON */ "editor value",
  submissionImages: [],
  thinking: { text: "learner reasoning", images: [] },
}
```

The corresponding target has `channels: ["submission", "thinking"]` and
`problem: { problemId, occurrence, pluginId, typeId, contractVersion, label, statement }`.
Identity remains host-owned. Interceptors can transform the value/thinking or attach
images, not retarget the problem. `onAccepted` fires only after canonical acceptance,
so a drawing plugin can retain unsent strokes through cancellation/refusal and clear
only accepted material. Interceptor cancellation and invalid output preserve drafts.

Transport/saved image channels are `images: { submission?, thinking? }`; reading-thinking
is not applicable. Images go through existing structural, byte/MIME, model-capability,
and resize admission. Actual native image blocks reach the model alongside labeled text;
base64 is not stuffed into the structured submission or model-facing JSON string.

## Verification

Cover saved contracts, the shared native/plugin lifecycle/gate/conclusion, registration
revocation, processing ownership/cancellation/repeat submissions, images/interceptors,
controlled dock cleanup/drafts, renderer slots and portable SDK inference. Browser
component diagnostics with simulated HTTP do not establish packaged-app, real-provider
or plugin-product release readiness. Native text-practice behavior remains independent.
