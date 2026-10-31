---
name: learnharness-plugins
description: Build, inspect, or debug a trusted-local LearnHarness plugin using the public plugin API. Use for custom views, native teaching tools/instructions, content renderers, validated background workers, interactive agents, learning-data readers, or plugin lifecycle problems.
---

# LearnHarness plugin authoring

First read `docs/plugin-authoring.md`, `docs/plugin-architecture.md`, and the actual
contracts `src/core/plugins.ts`, `src/core/plugin-agents.ts`, and
`src/core/plugin-workers.ts` in the matching app
checkout. These paths are repository-relative, not relative to an installed plugin.
If only a packaged app is available, use its matching `plugin-authoring/` docs/types
bundle beside the standalone server rather than inventing private-module imports. Type-only API
bundles can be emitted with `node scripts/build-plugin-types.mjs`.

## Rules

- Ask the human for feature behavior, prompts, defaults, algorithms, source policy,
  data deletion, and interface decisions. A plugin platform does not choose a product.
- Start from `examples/plugins/hello-plugin` (frontend only) or
  `examples/plugins/managed-agent` (Node + managed interactive/background agent), or
  `examples/plugins/teaching-extension` (instructions, native tools, renderers and a
  detached result worker in existing lessons).
- Installed folder ID must match `manifest.json`. Ship built ES-module frontend and
  CommonJS backend JavaScript, with JS dependencies bundled. No app-side npm install.
- Only use the supported context APIs. Do not import host implementation modules or
  mutate core learning records. Trusted code can read files, but APIs offer shared
  interpretation and preserve version guards. Keep feature data under plugin `data/`.
- Backend activation is server-owned; frontend activation is window-owned; view mount
  is neither. Return cleanup, dispose React roots, and honor cancellation after awaits.
  Do not start side effects at module top level.
- Auth and transport stay host-owned. Select an available configured model explicitly.
  Automatic work uses background purpose and existing subscription consent. Do not
  extract credentials, refresh accounts implicitly, or bypass a refusal with fallbacks.
- Use low-level inference for single responses or your own orchestration. Use managed
  agent sessions when navigation-independent execution, persistence, input tools, and
  reattachment are needed. They live in plugin data, not core teaching/practice chats.
- Use `ctx.workers` for bounded tasks that need one validated final result. `start`
  accepts work; `wait` returns a terminal outcome. Supply explicit model, purpose,
  request ID and maxTurns. Validate against immutable `task.input`, not model-authored
  task/source identity. A plain final model response or idle snapshot is not success.
  Keep semantic validators side-effect free. All unfinished tasks become interrupted
  on restart/disable; a new attempt requires a new explicit request identity.
- Add existing-agent instructions/tools through `registerInstructions/registerTools`.
  Keep native Pi tools and scoped targets; never replace built-in prompts/registries.
  Use `createBackgroundTool` for ack-now/result-later delivery, not a suspended tool
  Promise or a second agent framework. Keep model text separate from rendered data;
  the original native result stays an acknowledgement. Preparation/formatting must
  not introduce side effects. Shared worker admission is separate app policy, not
  something to implement with a new plugin-local pool or misclassified purpose.
- Use `registerCodeBlock/registerToolRenderer` for shared presentation, not private
  Markdown/React imports. Honor per-mount abort signals and async cleanup. Preserve
  raw fallback and incomplete fence state; don't insert unsanitized model HTML.
  Renderers may style other plugins' tools; producer identity isn't a sandbox gate.
- Deferred `kind:'input'` tools are declarative: no execute callback. Server tools can
  return normal results with `endRun:true`. Do not persist successful placeholder
  answers for questions the person has not answered.
- Reuse request IDs when retrying the same accepted input. Never replay interrupted
  side effects automatically. App shutdown interrupts live execution; navigation does
  not. Missing definitions/schema incompatibility must be explicit errors.
- Use live notifications plus snapshot/resync, not standing polling of hidden views.
  Unsubscribing observation must not cancel server-owned execution.
- Frontend assets are declared entry/style files and `assets/`; never place secrets or
  user data there. Plugin CSS must be scoped. Renderer isolation is not to be disabled.

## Verification

Use temporary, disposable learning/auth directories. No real account calls or learner
records without explicit permission. Test enable/disable, cleanup, invalid data, repeated
submissions, multiple pending inputs, cancellation, navigation away/back and restart
recovery. Verify externally installed folders in the actual packaged runtime, not only
in dev/source imports. Report what was exercised and what remains unverified.
