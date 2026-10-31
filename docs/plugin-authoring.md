# Build a LearnHarness plugin

Plugins are **trusted local code**. Only install code you trust: backend modules have
Node filesystem/network capabilities inside the LearnHarness server. Frontends run in
the application page, not in an untrusted iframe. This API does not disable Electron
renderer isolation or grant access to OAuth/BYOK credentials through the API.

## Start without a build system

1. Open **Settings → Plugins**. It shows the writable plugins directory.
2. Copy `examples/plugins/hello-plugin` into that directory (keep the folder name).
3. Refresh the plugin list, then enable **Hello plugin**.
4. Open its view from the sidebar. Its action and custom settings are also available
   in the plugin's Settings entry.
5. Edit the installed code, restart LearnHarness, and enable it if necessary. Refresh
   discovers packages; it is not a JavaScript hot-reloader.

Packaged desktop builds also include a `plugin-authoring/` directory beside the
standalone server, under the app's resources. It contains these docs, examples, a
coding-agent skill, and the generated type-only API tree. This is read-only authoring
material, separate from the writable installed plugins directory.

No npm command is run by LearnHarness. Packages contain built JavaScript. A production
plugin can use TypeScript, React, and a bundler during authoring; ship the browser
bundle as an ES module and the Node bundle as CommonJS. Bundle JavaScript libraries;
leave Node built-ins external in the backend. Native dependency installation/rebuilds
are not provided. The examples use plain JS and Node built-ins, needing no build. Besides the independent
hello/managed-agent views, `examples/plugins/teaching-extension` demonstrates contributions
to existing lessons: a normal native tool, a background-worker tool, and shared renderers.
The background example may incur model cost, but runs only when explicitly requested.

The exact API contracts are `src/core/plugins.ts` and `src/core/plugin-agents.ts`.
For TypeScript in a checkout, use **type-only** imports from those files. Do not import
application implementation modules at runtime. `scripts/build-plugin-types.mjs` emits
a portable declaration tree for authors who do not use a source checkout. Pi native
message/tool types are intentionally part of API v1 and match the app's pinned SDK;
this is not an unversioned compatibility promise for arbitrary Pi releases.

## Installed folder

```text
my-plugin/
  manifest.json
  main.js           # optional browser ES module
  backend.cjs       # optional Node CommonJS module
  styles.css        # optional; requires a frontend entry
  assets/           # public distributable assets/modules
  data/             # persistent plugin-owned records, never served as static assets
```

```json
{
  "apiVersion": 1,
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "minAppVersion": "0.3.7",
  "description": "What this plugin does",
  "main": "main.js",
  "backend": "backend.cjs",
  "styles": "styles.css"
}
```

The folder name must match the lowercase-hyphen ID. All three entry filenames are
optional except that at least one of `main` or `backend` is needed. They name root
files, not paths into `data/`. Version fields initially use numeric `x.y.z`. An
incompatible or malformed package is reported without executing its code.

Use `data/` for user-created state. Disabling never deletes it. Official code updates
preserve it. If you manually replace an external package, preserve its data yourself.
A plugin owns its data schema and migrations; refuse to rewrite a newer format you
do not understand. Reserve `data/agents/` for the optional host-managed agent helper
and `data/tasks/` for result-oriented workers, plus `data/usage.jsonl` for host inference
accounting.

## Frontend lifecycle and views

```js
export function activate(ctx) {
  ctx.registerView({
    id: "library",
    name: "My library",
    mount(container) {
      const title = document.createElement("h1");
      title.textContent = "My library";
      container.append(title);
      return () => container.replaceChildren();
    }
  });
  ctx.registerAction({
    id: "open-library",
    name: "Open my library",
    run: () => ctx.app.openView("library")
  });
}
```

`activate` runs once per enabled plugin per window, not once per view mount. The host
calls your returned cleanup and registered `ctx.cleanup(fn)` functions on disable.
Register views/actions/settings during activation, and keep their disposables scoped
to it. View/action IDs use 1–128 ASCII letters, digits, dots, underscores or hyphens,
starting with a letter or digit; display names can be normal human-readable text. `mount` may return cleanup or a Promise of cleanup. A view that uses React
must unmount its own root in that cleanup. Register browser events/timers for cleanup;
never leave them running after disable. Avoid work at module top level because native
module caching lasts until restart.

Views are custom screens in designated host surfaces, not extensions to the existing
teaching question dock. Use app theme variables such as `var(--foreground)`,
`var(--background)`, and `var(--border)`, with plugin-scoped CSS selectors. Shared-page
CSS is not sandboxed. Use `textContent` for text rather than unsafe HTML insertion.

`ctx.registerSettings(mount)` receives the same kind of container and cleanup contract.
Settings mount lazily when opened. `ctx.app` exposes supported pathname/navigation
helpers, not the application's private React context or graph selection internals.

## Backend and operation bridge

```js
const fs = require("node:fs");
const path = require("node:path");
exports.activate = (ctx) => {
  ctx.handle("get-state", () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ctx.dataDirectory, "state.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
};
```

A frontend calls `await ctx.call("get-state")`. Inputs/results must be JSON-compatible.
The host routes to this plugin's registered handler; this is not an arbitrary HTTP
router. Validate inputs in the handler and use atomic writes for important state.
Backend exceptions are visible errors, not successful empty results.

Backend activation is once per server. Returning a cleanup function or using
`ctx.cleanup` releases custom resources. All host-managed resources honor
`ctx.signal`; custom asynchronous tasks must cooperate with it. Check cancellation
again after awaited work before writing or publishing. No per-plugin process exists,
so the host cannot forcibly terminate arbitrary synchronous or uncooperative code.

## Extend existing teaching and practice

Backend contributions are additive. They do not replace the app's instructions, prompt
overrides, model selection, or built-in tools. Target `prober`, `teacher`, or `practice`
explicitly:

```js
ctx.registerInstructions({
  agents: ["teacher", "practice"],
  text: "When appropriate, use a plugin-note fenced block for a short note."
});
ctx.registerTools({
  agents: ["teacher"],
  create: ({ chatId, agent }) => [{
    name: "my_plugin_echo",
    label: "My plugin echo",
    description: "Echo a short requested text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (_toolCallId, input, signal) => {
      if (signal.aborted) throw new Error("Cancelled");
      return { content: [{ type: "text", text: input.text }], details: { text: input.text } };
    }
  }]
});
```

These are native Pi tools: parameter validation, execution and model-visible content
use the existing runner. A fresh factory receives frozen conversation identity for each
matching turn. Native calls/results are saved by the host's normal conversation pipeline;
do not duplicate them into core chat files. Instruction contributions compose with the
system prompt, like built-in prompt segments; they are not separate transcript messages.

Use globally distinctive tool names (a plugin prefix is useful): 1–64 provider-safe
letters/digits/underscores/hyphens, starting with a letter or underscore. Core names stay
reserved even when their user toggle is off. Collisions never overwrite another tool;
packages resolve in sorted ID order and the first valid loadout owns its names. A factory
or definition error omits that package's entire contribution for the affected turn and
reports a visible package warning without disabling its independent view/backend. A later
successful evaluation clears that warning. Basic schema hygiene and native compilation do
not guarantee that every provider supports every otherwise valid schema.

Unregistering affects future turns. Disable aborts cooperative plugin tool executions and
fences captured tools against further execution/results; it does not rewrite an already
running conversation's system prompt. Honor the execution signal before side effects,
especially after awaits. Arbitrary external side effects cannot be undone by cancellation.

### Shared content renderers

Frontend renderers mount into a host-owned HTMLElement. They use no private React API:

```js
ctx.registerCodeBlock({
  language: "plugin-note",
  mount(container, block) {
    container.textContent = block.source;
    // block.meta and block.incomplete preserve fence metadata/streaming state.
    return () => container.replaceChildren();
  }
});
ctx.registerToolRenderer({
  toolName: "my_plugin_echo",
  mount(container, tool) {
    container.textContent = tool.output?.text ?? tool.errorText ?? tool.state;
    return () => container.replaceChildren();
  }
});
```

Fence dispatch applies across shared Markdown surfaces, not just a plugin's own view.
Tool props carry input, state, details as `output`, and optional native `result` content.
A separate background-result card additionally sets `background`; it never pretends to
be a native result replacing the original acknowledgement. Presentation plugins may render
another plugin's tool: producer identity is metadata, not a sandbox boundary.

Built-in Mermaid and existing dedicated/hidden tool presentations remain authoritative;
registering those claims is refused. Ordinary tool names with only a generic fallback can
receive custom presentation. Renderer collisions are reported, not silently overwritten.
Unmount, replacement, unregister and disable abort each mount's `signal`. Async cleanup is
supported and must settle cooperatively. Errors, absent plugins and disabled renderers
fall back to readable source/results rather than hiding saved lesson content. Use
`textContent`, not unsanitized model-generated HTML; bundle chemistry/music libraries in
normal distributable assets if needed. These hooks do not introduce a new pending
learner-answer type into the question dock.

## Learning data

`ctx.learning` provides:

- `directory`: the learning-data location, not a credential location.
- `listSessions()` and `getSession(id)`: summaries and full native records.
- `graph()`: the current graph projection.
- `readGraphFile(name)`: host-interpreted node/chain/session/coverage ledgers, sources,
  positions, format and render metadata. Sources are returned as a record array.

Read the native transcript for learner answers/thinking/mistakes. The knowledge graph
is extracted from teacher prose, not a complete representation of learner responses.
Reads across files are not transactional. The supported API does not mutate core
learning records; write plugin-generated cards/notes/schedules to plugin-owned state.

## Model calls

```js
const catalog = await ctx.inference.catalog();
// Let the user choose a catalog entry, or explicitly use a configured slot.
if (!catalog.defaults) throw new Error("Configure a model first");
const result = await ctx.inference.complete({
  model: { ...catalog.defaults.model, thinkingLevel: catalog.defaults.thinkingLevel },
  purpose: "background",
  context: {
    systemPrompt: "Your plugin's instructions",
    messages: [{ role: "user", content: "Your explicit task", timestamp: Date.now() }]
  },
  signal: ctx.signal
});
if (result.stopReason === "error") throw new Error(result.errorMessage);
```

`stream` exposes native model events including text/thinking/tool calls; `complete`
returns the final native assistant message, including error/abort states. This is not
a text-only completion API. The catalog is the host's last-known catalog: it does not
silently refresh accounts or select a fallback provider. Model selection must be
explicit and currently available; an unset model is an error.

`purpose` classifies automatic/background versus user-initiated work. Existing
subscription background-use consent, admission, quota, and cancellation rules apply.
Do not misclassify automatic work as user input to bypass those rules. Connecting a
view never changes a background call into user-initiated work. There is no automatic
API-key fallback after a refused subscription call.

The host owns credentials and transport. Supported generation/reasoning/retry options
are listed in `PluginInferenceOptions`; transport callbacks, custom fetch/env, headers,
and deferred remote work are not part of this API. Put thinking level on the model
spec. Usage appends to plugin-local `usage.jsonl`, not core chat records.

## Managed agent sessions

See `examples/plugins/managed-agent` for a complete frontend/backend example. It uses
normal public APIs; the host has no special knowledge of its operations or tools.
Its model calls may incur cost. It is not installed or enabled automatically.

Backend pattern:

```js
ctx.agents.register({
  id: "assistant",
  instructions: "Your own instructions",
  model: selectedModel,
  tools: [{
    name: "ask",
    kind: "input",
    description: "Ask the person for input",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    resultSchema: { type: "string", minLength: 1 }
  }]
});
const session = ctx.agents.create("assistant");
await ctx.agents.send(session.id, explicitTask, {
  requestId: crypto.randomUUID(), purpose: "background"
});
```

Persist/reconstruct definitions consistently across activation, including their model
selection. The helper stores conversations, not JavaScript handlers. A missing
definition is an unavailable-definition error, not permission to reinterpret history.
A `kind: "input"` tool does not have `execute`: its call becomes persisted external
input. Read `snapshot.pending`, render your own form, and submit via your backend:

```js
await ctx.agents.answer(sessionId, toolCallId, validatedAnswer, {
  requestId: crypto.randomUUID(), purpose: "user"
});
```

Retry the **same** submission with the same request ID. A new ID means a new action.
Do not answer the same question twice under different identities. Multiple required
inputs all need results before continuation. Invalid answers are refused, not saved
as successful tool results. `formatResult` can define model-facing answer content.
An ordinary server tool instead has `execute` and may use `endRun: true` to return a
successful result and pause; future user text is a new contribution, not that tool's
missing result.

`get`, `list`, `subscribe` expose full state/current partial. Subscription teardown
only detaches an observer. The app emits the live plugin notification topic
`agents-changed` on managed state changes; re-read your selected session and coalesce
in-flight fetches as the example does. On reconnect, use `ctx.onResync` to read current
state. Never keep polling a hidden view. A plugin may use backend `subscribe` for its
own feature-local coordination; unsubscribe on cleanup.

`abort` requests cooperative cancellation. `run` resumes runnable persisted input;
it never authors “Continue” for you. App navigation/reload does not stop a run, but
app shutdown does. Restart recovers waiting inputs and marks in-flight work interrupted.
Incomplete side-effecting tool batches are not auto-replayed. Explicit new input may
establish recovery context; do not claim exactly-once external side effects.

## Result-oriented workers

`ctx.workers` is for bounded tasks with one validated result, not conversational sessions
with external human-input tools. The host uses the same native sub-agent runner and
inference/accounting path. Reserve `data/tasks/` for its persisted records.

```js
ctx.workers.register({
  id: "make-note",
  instructions: "Write a short note about the supplied topic, then call submit_result.",
  resultSchema: {
    type: "object", properties: { note: { type: "string", minLength: 1 } }, required: ["note"]
  },
  validateResult(result, task) {
    // task.input is the immutable accepted input; don't trust a model-authored task ID.
    if (!result.note.trim()) throw new Error("The note cannot contain only whitespace.");
  }
});
const accepted = ctx.workers.start("make-note", {
  requestId: crypto.randomUUID(), input: { topic: "Example" }, prompt: "Write a note about Example.",
  model: selectedModel, purpose: "background", maxTurns: 3,
  options: { maxTokens: 1024 }, timeoutMs: 60000
});
const outcome = await ctx.workers.wait(accepted.id);
if (outcome.status === "succeeded") useResult(outcome.result);
else showFailure(outcome.error);
```

The numbers above are example limits, not host defaults. Model and purpose are explicit;
plugins choose their own slot/override policy. `start` synchronously persists acceptance
before scheduling execution and returns a snapshot, **not completion**. Repeating an
identical request ID/request returns the original task; reusing it for different work is
an error. A new attempt uses a new ID. `maxTurns` is required; `options` uses the inference
allowlist and applies across native turns. Task `timeoutMs` is wall-clock lifetime from
acceptance (including admission waits), separate from per-request `options.timeoutMs`.

The host installs `submit_result({ result: ... })`. Schema errors and semantic validation
errors return correction feedback in the same context. The validator must be side-effect
free. Ordinary tools may be supplied by a task-context factory; tool exceptions can be
corrected, but a model ending without a valid final submission is failure, not success.
The first durably accepted valid result is immutable, including falsy JSON values. Later
cancellation or cleanup cannot replace it. There is no exactly-once promise for arbitrary
external tool side effects.

States are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `interrupted`.
`get`, `list`, and snapshot-first `subscribe` expose committed history/progress; streaming
`partial` is ephemeral. `wait` resolves a terminal outcome, while aborting its signal only
stops that waiter. Unsubscribing or leaving a view does not cancel execution. Use `cancel`
explicitly. Disable and server restart mark **all unfinished tasks interrupted**, including
queued tasks and disabled packages' saved tasks. Nothing automatically replays tools or
starts a new model attempt. Completed results/history remain available.

This service does not add a DAG, scheduling language, or a separate concurrency setting.
Compose sequential stages with `wait`; coordinate independent tasks in plugin code.
App-level worker-request admission remains a separate host concern; `purpose` classifies
subscription consent and is not itself a concurrency permit.

### Background tools in existing lessons

Inside `registerTools.create(context)`, return `ctx.createBackgroundTool(context, spec)`.
It returns a **native Pi tool**, not a separate sub-agent framework. `spec` contains native
tool metadata/schema, `workerId`, `prepare(input, context)` returning worker start options
without request ID/purpose, and `format(outcome, context)` returning `{ text, data? }`.
The host derives the request identity from the actual chat/tool call and always classifies
the detached worker as background work. See `examples/plugins/teaching-extension`.

The tool returns a dispatch acknowledgement promptly; its original native result remains
that acknowledgement forever. A shared background-job row tracks progress/cancellation.
After completion, the existing result-steer pipeline delivers the formatter's model text
and a separate rendered payload, respecting live-turn boundaries, pending questions,
consent and idempotent message identities. `tool.background` distinguishes that later
card in your renderer. The header/status and formatter errors remain host-owned; your
renderer owns the body. Raw fallback stays readable without the plugin.

Do not perform side effects in `prepare`/`format`. Completed task outcome and result delivery
are separate facts: cancelling a queued delivery does not erase an already accepted task
result. Recovery re-delivers persisted results, never re-runs plugin tools or formatters;
missing/unreadable task state produces an honest failure notification rather than a
fabricated result. Formatter failure or unavailable plugin code keeps the real task
outcome and a safe fallback, not a false task failure.

## App events and notifications

Backend `ctx.events.on(listener)` and frontend `ctx.onAppEvent(listener)` receive the
supported app events. For example, `turn-settled` follows core turn persistence;
extraction is asynchronous and is not promised complete at that moment. Avoid
recursively emitting in response to your own notifications.

`ctx.events.emit(topic, jsonData)` is scoped to your plugin. Frontend
`ctx.onNotification` receives those live notifications. There is no arbitrary durable
event log: on reconnect use `onResync` and fetch current state. Notifications share
the existing per-window app channel; do not open standing polling loops.

## What v1 deliberately does not do

No marketplace, automatic community updater, sandbox, per-plugin process, hot code
replacement, core-data write API, teaching-specific agent framework, declarative UI
schema, or automatic restart/replay of interrupted arbitrary tools. Your feature owns
its own product behavior. Host internals are not a supported extension API.
