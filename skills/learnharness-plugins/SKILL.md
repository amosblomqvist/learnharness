---
name: learnharness-plugins
description: Build, inspect, or debug trusted-local LearnHarness plugins using the public API. Covers views/actions/settings, host UI, teaching questions, practice problems, whole-session context, submission interception/images, page-body surfaces, renderers, document conversion, learning-data readers, model calls, managed agents, workers and plugin lifecycle.
---

# LearnHarness plugin authoring

## Read the matching contract

Start with the [authoring guide](../../docs/plugin-authoring.md), then read only the
contracts relevant to the task:

| Area | Reference |
| --- | --- |
| Host boundaries and implementation map | [Architecture](../../docs/plugin-architecture.md) |
| Teaching questions/editors/grading | [Question contract](../../docs/plugin-question-contract.md) |
| Practice problems/editors/processing | [Problem contract](../../docs/plugin-problem-contract.md) |
| Submission interception, images, surfaces | [Session extensions](../../docs/plugin-session-extension-contract.md) |
| Read-only transcript/presentation/unsent drafts | [View context](../../docs/plugin-view-context.md) |
| Controlled hierarchy presentation | [Tree contract](../../docs/plugin-tree-contract.md) |
| Modal/menu/Escape/focus ownership | [Interaction contract](../../docs/dialog-overlay-contract.md) |

In a checkout, public types are under `src/core/`: `plugins.ts`, `plugin-ui.ts`,
`plugin-agents.ts`, `plugin-workers.ts`, `plugin-questions.ts`, `plugin-problems.ts`,
`plugin-submissions.ts`, `plugin-view-context.ts`, `plugin-tree.ts`.
These paths are repository-relative. Use **type-only** imports, never private runtime
modules. Emit portable declarations with `node scripts/build-plugin-types.mjs`.
Without a checkout, download the complete authoring skill from **Settings → Community
plugins → Download authoring skill**. Keep its root `SKILL.md`, `docs/`, `examples/`
and `types/` together; use the included SDK rather than running repository build scripts.
Read `bundle.json` for the producing app/API/SDK versions. API v1 can gain capabilities:
check actual host compatibility rather than copying a stale `minAppVersion`. The exported
examples conservatively require the producing app version; older targets need verification.

## Choose a starting point

[No-build examples](../../examples/plugins/) include `hello-plugin` (view/settings),
`managed-agent` (persistent conversations) and `teaching-extension` (native tools,
renderers, detached workers). Repository `plugins/` contains larger feature source
projects; inspect them as examples, not private APIs or a promise of bundled availability.
Model-using examples may incur cost when explicitly run.

## Guardrails

- Ask the human for product behavior, prompts, defaults, algorithms, source policy,
  interface and deletion decisions. The platform supplies mechanisms, not product authority.
- Plugins are trusted local code, not a sandbox. Never expose credentials, mutate core
  learning records, import host components or inject unsanitized model HTML.
- Community runtime layout is `<learning data>/plugins/<id>/dist/manifest.json` plus bundles/assets.
  Optional source/build configuration lives beside `dist/`; persistent `data/` is a sibling.
  Build directly into `dist/`, not `dist/<id>/`. Bundle JavaScript; no host-side npm install.
- Distribute built contents into the installed `<id>/dist/`, preserving sibling data.
  Cleanup targets only generated `dist/`, never workspace/data, and must refuse symlinked
  `dist/` or misplaced `dist/data/` before deletion.
- Core code loads directly from app `core-plugins/<id>/`; writable core records are in
  `<learning data>/core-plugin-data/<id>/`. Always use `ctx.directory`/`ctx.dataDirectory`,
  never infer sibling paths. Core updates with the app; both origins start disabled and
  retain explicit choices. Core IDs are reserved; community copies are skipped with a
  diagnostic, not replacements. Use Settings → Community plugins for installations and
  Settings → Core plugins for shipped features. `plugins:build-core` stages the four
  catalog-selected packages; it never installs into learner data.
- Refresh discovers packages/first builds; admitted code changes need server restart.
  No hot reload, separate development registration or root-manifest fallback exists.
- Backend activation is per server; frontend activation per window; view/editor mounts
  have shorter lifetimes. Scope widgets to mount signals, clean up React roots/events/
  subscriptions, fence late awaits/publications and avoid top-level side effects.
- Host view shells own top bar/title/gear. Register actions before explicit placements;
  registration creates no automatic chrome. Top bars require explicit sessions/own-view
  targets. Optional action `shortcut` metadata explicitly scopes app-wide/session/own-view
  invocation and an optional default chord; the existing Keyboard page handles rebinding.
  Accept `placement: "keyboard"` when opting in. Use `refreshActions()` for plugin-owned
  dynamic predicates; shortcut scope/default are captured at registration.
- Use controlled `ctx.ui` helpers, not private imports or DOM-dependent styling. Feed
  accepted values back through shallow handle updates; replace whole nested props.
  Model/thinking controls do not write core settings. Keep host keyboard/IME/focus,
  dictation ownership and one-Escape rules. Declarative action shortcuts do not expose
  raw events, bypass foreground dialogs/editors, or register OS-wide hotkeys.
- Session top-bar `context.view` is a fresh detached/frozen whole-session snapshot,
  including current messages/transcript, presentation and unsent published drafts.
  Use it instead of a second history parser/shuffle or private DOM inspection. Reads
  never flush dictation, reveal, save, process or submit. Respect reveal/availability
  flags for learner-facing output; inspectable history is not sanitized visible prose.
- Teaching questions use saved schemas/exact occurrence and validate → optional grade →
  save → continue. Grading returns finite JSON observations; the plugin owns display.
  Practice problems use validate → optional process → save → continue; only the model's
  existing `conclude` assesses/closes them. Never invent native envelopes or bypass
  unavailable implementations. Custom editor values must publish ready before submission.
- Interceptors are ordered and fail closed while retaining drafts. Keep `hasPendingInput`
  side-effect-free; call `refreshSubmissions()` on external state changes. Consume only
  captured material through acknowledged `onAccepted`, never model retry, dismissal or
  guessed acceptance after a lost response. Attach explicit native images, not paths/URLs
  or base64 inside answer JSON. Host thinking/images remain separate renderer channels.
- Surfaces capture one page boundary or exact opaque target; never persist/reconstruct
  targets or retarget after awaits. They cover body only, expire on navigation and stay
  below Settings/dialogs. Use public content mounts and respect generation cleanup.
- `ctx.documents.toMarkdown` accepts a browser File (PDF/strict UTF-8), not paths or
  JSON-bridge uploads. It is bounded/cooperatively canceled, not OCR/storage/inference.
- Inference needs explicit available model and truthful user/background purpose. No
  silent provider/key fallback. Managed conversations and result workers have distinct
  lifecycle/request-ID semantics; observation/navigation does not cancel execution.
  Disable/restart interrupts unfinished work; recovery never replays arbitrary tools.
- Notifications are live hints, not durable logs: use `onResync` plus current snapshots,
  and release observers rather than polling hidden views.

## Verify without disturbing the installation

Check plugin types/tests/build, runtime layout, disabled discovery, activation/cleanup,
restart/data preservation, stale/async generations and native lifecycle paths actually
used. Test through public APIs and real host controls, not private component imports in
the plugin. Use disposable data and loopback providers where possible. Portable SDK,
component/browser fixtures, packaged runtime checks and real-provider/OS tests establish
different things; report those boundaries. App builds/installs, release changes, commits,
plugin selection and distribution changes require their own human authorization.
