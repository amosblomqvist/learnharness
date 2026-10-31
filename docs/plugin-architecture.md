# Plugin architecture — API v1

## Approved scope

LearnHarness supports trusted-local plugins, including optional official features,
using the same public API as externally installed plugins. Plugins are broad-capability
code, not a sandbox. Electron's renderer isolation and desktop HTTP credential boundary
remain in force. Backend code runs cooperatively inside the existing Node server;
broken code may require restarting the app.

The human approved implementation of this plan in the `feature/plugin-architecture`
worktree. Subsequent decisions: management/custom settings in **Settings → Plugins**,
registered views in a small sidebar group; recoverable startup-only official-package
updates rather than whole-directory swaps. Interrupted package updates must block that
package from loading until a successful retry. Package-specific update failures are
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
- Custom view, action and settings registration; navigation and live app notifications.
- A JSON operation bridge between the frontend and its own backend.

No supported API mutates core sessions or graph evidence initially. The learning-data
location remains available to trusted backend code; readers are conveniences that share
the host's file interpretation, not mandatory filesystem access control. Reads across
several files are not promised to be transactional. `readGraphFile` uses store readers:
for example `sources.json` returns source records, not the file's raw keyed JSON map.

Custom views receive an HTMLElement. A plugin may use plain DOM or bundle React and
mount/unmount its own root. Do not import private LearnHarness components or rely on
its React context. Public assets are only declared frontend entry/style files and the
explicit `assets/` subtree, never the backend or `data/` directory.

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

The canonical task outcome and delivery state are separate: formatter/unavailable-plugin
failure keeps the accepted result plus honest fallback, and cancelling a delivery does not
erase a completed task. Recovery reads safe persisted task state even for disabled packages;
it re-delivers results or reports an honest failure, never replays preparation/tools/formatters.
The shared job adapter uses atomic fsynced replacement for durable linkage/result updates.

There is no DAG framework, guaranteed execution with the app closed, new plugin concurrency
pool or competing setting. Request-level shared worker admission is separately approved app
work; this increment deliberately leaves existing admission behavior unchanged. `purpose`
classifies subscription policy and must not be mistaken for a concurrency permit.

## Notifications and recovery

The app's existing single per-window notification connection carries plugin availability
changes and namespaced live plugin messages. These are not a durable arbitrary-event
log. A reconnect fires resync callbacks; plugins read a current snapshot. Plugin-specific
model/session observation must release connections on view departure and must never
cancel server execution just because a response reader disconnects.

## Distribution and updates

External installation starts as copying a folder and refreshing the plugin list. Official
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

Validation includes focused lifecycle/storage/interaction tests, existing teaching/practice
regressions, typecheck/lint, production build and a packaged-server smoke with disposable
learner/auth directories. No actual user records or provider accounts are needed for these
checks. Full flashcards are the reference future consumer; generation cadence, review
algorithm, source/deletion policy, prompts and other product behavior require their own
approved specification.

### Implementation verification

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

Packaging verification exposed that Next 16.3.2 traces some runtime path producers even
without file reads, and instrumentation does not inherit route-level trace exclusions.
Comment-only per-expression opt-outs now keep mutable data/auth/debug paths out of the
payload while retaining shipped prompts. Controlled disposable builds checked independent
chat/graph/settings/jobs/override/auth sentinels; `tests/runtime-path-tracing.test.ts` locks
the identified source boundaries. The production payload's existing data/secret refusal
checks remain unchanged. Two existing route-only broad-trace warnings (headless browser
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
