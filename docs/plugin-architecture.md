# Plugin host architecture — API v1

This is the host-maintainer map. Start with the [authoring guide](plugin-authoring.md)
for plugin code and use feature contracts for normative public behavior. It describes
the current checkout, including additions beyond released 0.4.1; it is not a release
verification report.

## Boundaries and ownership

Plugins are trusted local code. Backends execute cooperatively in the existing Node
server; frontends execute in the application page, not an untrusted iframe. Electron
renderer isolation and desktop HTTP credential boundaries remain in force, but the
plugin API is not a filesystem/network sandbox or resource-isolation guarantee.

The host owns package identity/compatibility, enable state, lifetimes, native session
contracts, persistence/admission and credential transport. Plugins own feature data,
prompts, tools, presentation, algorithms and product policy. Official and externally
installed plugins use the same host/APIs. No special Flashcards, Coding Questions or
Drawing Pad domain logic belongs in host infrastructure.

Backend learning APIs share native record interpretation and are read-only, not mandatory
filesystem access control. Cross-file reads are not transactional. Native user-driven
source management in the knowledge picker is not a programmable graph-write API.

## Source map

| Boundary | Main implementation |
| --- | --- |
| Public browser-safe contracts | `src/core/plugins.ts`, `plugin-ui.ts`, `plugin-agents.ts`, `plugin-workers.ts`, `plugin-questions.ts`, `plugin-problems.ts`, `plugin-submissions.ts`, `plugin-view-context.ts`, `plugin-tree.ts` |
| Server composition and runtime | `src/server/plugins.ts`, `plugin-host.ts` |
| Native external backend loading | `scripts/plugin-loader.cjs` |
| Browser module loading | `public/plugin-loader.js`, `components/plugin-manager.ts`, `plugins.tsx` |
| Recoverable bundled installation | `src/store/plugin-installation.ts` |
| Data/model adapters | `src/server/plugin-learning.ts`, `plugin-inference.ts` |
| Persistent conversations/tasks | `src/agent/plugin-agents.ts`, `plugin-workers.ts`; `src/store/plugin-agent-records.ts`, `plugin-task-records.ts` |
| Background result delivery/activity | `src/server/plugin-background-tools.ts`, `plugin-worker-activity.ts` and existing host jobs/steers |
| Agent tool contributions | Native agent composition plus `src/agent/plugin-question-tools.ts`, `plugin-problem-tools.ts` |
| Canonical question/problem submission | `src/server/plugin-questions.ts`, `plugin-problems.ts` |
| Frontend submission preparation | `components/plugin-submission-runner.ts`, `plugin-submission-adapters.ts` |
| Chrome/controlled UI/settings | `components/plugin-chrome.tsx`, `plugin-ui-host.tsx`, `plugin-settings-rows.tsx` |
| Surface identity and body coverage | `components/plugin-surface-targets.ts`, `plugin-surfaces.tsx`, `plugin-surface-shell.tsx` |
| View-local snapshot readers | `components/chat.tsx`, `session-view-readers.ts`, native/custom dock owners |
| Authoring payload/types | `scripts/build-server.mjs`, `build-plugin-types.mjs` |

Bare filenames in a row share the preceding directory. These are implementation seams,
not supported runtime imports for plugin code.

## Package discovery, installation and lifecycle

Runtime lookup is fixed: `<learning data>/plugins/<id>/dist/manifest.json` and referenced
bundles/assets. Optional source lives beside `dist/`; persistent `<id>/data/` is never
runtime/static content. Manifest API version is 1; app/package versions are numeric
`x.y.z`. Validate identity, paths, compatibility and built entries before executing code.
Disabled packages are discovered without evaluation; new packages default to disabled.

There are three distinct locations:

1. Repository `plugins/<id>/`: feature source projects and local build output.
2. App `bundled-plugins/<id>/`: flat built package contents used as managed startup input,
   if provided. Selection/build staging is a separate distribution concern.
3. Writable `<learning data>/plugins/<id>/`: installed `dist/` plus persistent sibling data.
   Electron supplies its user-data location through `LH_DATA_DIR`; development uses the
   configured local learning-data root.

`installBundledPlugins` validates/stages code, atomically replaces individual files,
commits the manifest last, and preserves data. It records ownership in
`plugins-bundled.json` beside the plugins directory. Durable write-ahead markers in
`plugins-installing/` block a partially updated package from loading until startup retry
succeeds. This is recoverable installation, **not a whole-directory atomic swap**.
External ID collisions are refused. Per-package failures block only that package;
corrupt shared ownership/enable metadata is refused rather than overwritten.

Refresh discovers manual folders/first builds; admitted code changes require a server
restart. There is no hot replacement, separate development registration, runtime npm
installation, root-manifest fallback or automatic community updater. Build cleanup must
never reach sibling data or follow symlinked/misplaced data inside build output.

Backend activation is server-owned, frontend activation window-owned, view mounts
independently scoped. Abort and returned/registered cleanup revoke owned registrations,
widgets and cooperative work; async late results are fenced by instance/generation.
Module caching lasts until restart, so top-level side effects are not lifecycle-owned.
Navigation does not disable a plugin or stop its server-side tasks.

Only declared frontend/style entries and `assets/` are publicly served, never backend
code or persistent data. The frontend JSON operation bridge routes to the owning
backend's registered handlers; it is not an arbitrary router. Document conversion uses
a separate bounded multipart path, not that JSON bridge.

## Frontend presentation and interaction

The host owns view shells, titles, top-bar overflow and settings gear. Views mount only
feature bodies. Registering actions/views creates no implicit navigation: placements
explicitly target sidebar, graph or selected session/plugin-view top bars. Async action
busy/repeat/error handling is host-owned. Each enabled plugin has its own Settings page;
package management stays in Settings → Plugins.

`ctx.ui` exposes controlled helpers rather than React/private component access.
Handles shallow-update props, dispose idempotently and follow their mount signals.
Values/persistence remain plugin-owned; selectors never mutate core model defaults.
Generic badges/colors do not interpret grades. `mountMarkdown` uses the actual host
pipeline with built-ins only, without auxiliary controls or plugin fence dispatch.
`mountTree` shares presentation/navigation primitives with Chains, not its domain
controller; callers own hierarchy/selection, sufficient width and scrolling.

Dialogs, menus, pickers and page-body surfaces use the shared interaction controller;
see [dialog/overlay rules](dialog-overlay-contract.md). One Escape has one owner,
covered content cannot receive native submit/dictation actions, and eligible focus is
restored without focusing detached/covered controls. Browser Tab navigation remains
unchanged. Declarative action shortcuts use `src/core/plugin-shortcuts.ts` for validation,
static scope-overlap/conflict resolution, and `components/plugin-shortcuts.tsx` for
route-keyed page readers and eligible dispatch through the existing action runner.
Shortcut metadata is captured at registration; dynamic disabled state stays live.
The existing `lh:keymap` store, Keyboard Settings and cheat sheet include plugin actions.
The interaction controller snapshots original foreground ownership at key capture;
only the same owner's page-body surfaces allow a plugin action through. UI factories
receive host-supplied plugin identity for this check, never author-supplied surface props.
See [action shortcuts](plugin-authoring.md#action-shortcuts) for the public contract.

Knowledge pickers capture opening origin. Page/surface origins use a main-pane view;
modal/Settings origins use a full-viewport modal with the parent still painted/inert.
Origin/widget lifetime and pending-load invalidation prevent stale graph loads from
opening on a successor view. Existing user source organization stays host-owned.

Page-body surfaces capture one live boundary (targetless) or use an explicit opaque
native target. Top bar/sidebar remain usable. Covered pages/surfaces remain mounted;
ordinary stack siblings do not acquire each other's lifetimes. Navigation expires
boundaries; tokens never revive on return. Dialogs/Settings remain in front regardless
of opening order. Titles are accessible names, not forced visible headings. See the
[surface contract](plugin-session-extension-contract.md#8-public-surface-contract).

## Agent contributions and native input authority

Native instructions/tools, question types and problem types are admitted once per turn
as a package-atomic loadout. Core names remain reserved. Sorted package admission never
overwrites collisions; a bad package contributes nothing for that turn and gets a
visible warning without losing its unrelated backend/view. Captured tool executions
are revocable; unregister affects future loadouts. Native calls/results use the existing
runner/history, not a plugin-specific conversation framework.

Teaching questions and practice problems deliberately use different native authorities:

- **Questions:** a frozen per-turn registry and pose ledger attest successful execution.
  App-only `lhQuestions` metadata binds saved contracts to exact assistant occurrences;
  raw tool names/arguments/results do not create pending authority. Temporary pose acks
  are suppressed; canonical adoption gates actionable editors. Saved schemas/refinement/
  grading requirements govern answers. Validate → optional grade → save → continue;
  grading observations/errors do not fabricate native correctness. Required unavailable
  implementations keep pending input unavailable. See the [question contract](plugin-question-contract.md).
- **Practice:** accepted pose acknowledgement details contain `pluginProblem`; native
  acknowledgements already persist, so no second question ledger is needed. Native and
  plugin poses share one active-problem gate and the existing `conclude` assessment.
  Each submission validates, optionally processes, saves observations and continues.
  Missing/incompatible implementations leave the problem active but unavailable, with
  native dismissal; no text-editor fallback. See the [problem contract](plugin-problem-contract.md).

Grading/processing run inside the existing inline turn-preparation owner, not a new job,
queue or model pass. Identity/registration checks after awaits prevent late saves.
Explicit Stop/revocation aborts cooperatively and retains ownership until the callback
settles. HTTP disconnect/navigation alone does not cancel admitted server work. Historical
projection/retry/remount never recomputes saved grading/processing.

## Submission preparation, images and view snapshots

One frontend preparation runner captures target occurrence, ordered interceptors and
original dictation destination before awaits. It freezes detached context/input,
serially transforms learner values, rechecks ownership, then uses native POST/steer
admission. Preparation cancellation/failure preserves drafts; accepted delivery clears
only captured revisions. The lease ends at acknowledgment/refusal, not model-stream end,
so ordinary busy steering remains possible.

Acceptance callbacks are live/best-effort, not durable transactions. Lost acknowledgments
never authorize clearing plugin material. Model retries reuse saved transformed input;
internal steer-to-send fallback does not intercept twice. Builtin derived answers are
rebuilt by the host from captured native question data, not spread from plugin fields.
Plugin JSON remains subject to canonical saved schemas. See [session extensions](plugin-session-extension-contract.md).

Explicit native image blocks travel through existing byte/MIME, effective-model capability
and resize admission. Persisted normalized images reach both UI and model channels;
paths are not implicitly read, and base64 is not inserted into JSON answer strings.
Existing optimistic/canonical reconciliation prevents duplicate previews while preserving
uncertain drafts. No image asset store or broad provider/model-switch redesign is added.

Session top-bar `context.view` is a detached/frozen whole-session snapshot captured at
invocation. It reuses current browser messages, projected transcript and view-local
input readers; native/custom dock owners expose actual presentation/drafts without
DOM inspection, another history parser or a global store. Reads never save, flush speech,
reveal, process or submit. Data stays bound across awaits; opaque targets keep their live
lifetimes. Disabled predicates use lazy render snapshots; clicks capture afresh through
the action error boundary. See [view context](plugin-view-context.md).

## Inference, persistent work and recovery

`plugin-inference.ts` reuses host model/provider admission, consent, cancellation and
usage attribution. Catalog selection and purpose are explicit; no credential DTO,
custom transport or silent key fallback is exposed.

Managed agents persist native interactive conversations and pending external inputs under
plugin data. Definitions are reconstructed by activation, not serialized handlers.
Request IDs distinguish retries from new actions. Restart recovers waiting input and
marks in-flight runs interrupted; navigation merely detaches observers.

Result workers persist accepted input/configuration, native progress and a terminal
validated outcome under `data/tasks/`. First durable valid result wins, including falsy
JSON; cancellation cannot replace it. Disable/restart interrupts all unfinished work,
including queued tasks. Recovery never replays arbitrary tools.

`createBackgroundTool` returns a native dispatch ack and links a generic host job.
Worker outcome and later delivery are separate durable facts: persist generic outcome
before async formatting, use existing wake/steer gates and deterministic delivery IDs,
and retain readable fallback when formatting/plugin availability fails. Restart re-delivers
persisted results, not formatters/tools. A finished worker's pending delivery is not
canceled by END. Plugin renderers replace only the result body, not host identity/status/errors.

One process-global FIFO admission pool limits background **model streams**, releasing
permits before tools/child waits. It covers native background workers and all detached
plugin workers, not direct teaching/practice/compaction, interactive managed conversations
or raw plugin inference. `agent.workerRequestConcurrency` defaults to 8, accepts positive
safe integers and updates live. Purpose governs subscription consent, not pool membership.
Standalone worker activity uses Background agents without duplicating linked-job rows.

The existing per-window app notification connection carries availability/app events and
namespaced plugin messages. It is not a durable arbitrary-event log. Reconnect invokes
resync callbacks; observers fetch current snapshots and release subscriptions on cleanup.

## Verification

Maintain tests at each actual boundary:

- Manifest/path guards, disabled discovery, enable/disable cleanup and revocation.
- Recoverable bundled updates, external ownership collisions, interrupted installs and
  preservation of sibling data.
- Native loadout collision atomicity, canonical pose authority, exact occurrences,
  schema compatibility, mixed tool batches and stale submission rejection.
- Inline grading/processing ownership, Stop/revocation, write-before-continuation,
  compaction joins and no recomputation on replay.
- Editor lease generations, async cleanup/StrictMode, draft retention, keyboard/IME,
  dictation destination, missing-renderer fallback and image placement.
- Submission interception/acknowledgment races and snapshot freshness/immutability,
  including real input owners and inline/overflow top-bar actions.
- Durable agent/task state, accepted-result preservation and fallback delivery recovery.
- Portable SDK compilation and curated authoring docs/examples/type payload.

Run root tests/typecheck/lint and relevant plugin tests. Production verification additionally
needs a clean-checkout build, curated standalone/privacy audit and isolated packaged
runtime/browser checks; passing component fixtures is not packaged-app proof. Use
throwaway learner/auth directories and loopback providers rather than live accounts or
replacing the installed app. Relevant tools include `build-plugin-types.mjs`,
`build-server.mjs`, `smoke-plugin-runtime.mjs`, `smoke-plugin-browser.mjs` and
`smoke-server.mjs` under `scripts/`.

Historical implementation/test counts and temporary evidence paths are preserved in
[implementation history](archive/plugin-implementation-history.md), not mixed into the
current contract. They describe their original scope and are not evidence that the
current combined tree, signed installers, real providers, microphone/OS IME or every
platform has been verified for release.

## Non-goals

No sandbox/per-plugin process, marketplace/community updater, hot replacement,
programmable core-data writes, generic forms/UI or raw keyboard-event framework, persistent arbitrary
editor drafts, or automatic replay/exactly-once external effects. Host infrastructure
must not choose plugin product prompts, algorithms, defaults or deletion policy.
