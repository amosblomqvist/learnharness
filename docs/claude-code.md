# Claude Code

LearnHarness can run its agents through an externally installed **Claude Code CLI**.
This is a separate provider from the Anthropic API and the built-in subscription
connections. Claude Code owns authentication, routing, model access, and billing;
LearnHarness does **not** guarantee subscription-only use.

## User setup

1. [Install and authenticate Claude Code](https://code.claude.com/docs/en/setup)
   outside LearnHarness, using a terminal on **the machine running the LearnHarness
   server**, under its operating-system user. A CLI installed only on a remote
   browser's computer is not sufficient. No always-running CLI process is needed.
2. Make the executable discoverable to that server process. LearnHarness searches
   its `PATH` and common user/native installation locations. On Windows it requires
   a directly runnable `claude.exe`; an npm installation exposing only `claude.cmd`
   does not qualify. Desktop launch environments can differ from terminal environments.
3. Open **Settings → Providers → External CLI → Claude Code** and switch it on.
   This is an app-wide, persisted opt-in, **off by default**, even when the CLI is
   installed. Enabling reveals the installation/version result and **Check again**.
4. Select a Claude Code model in the model controls (`opus`, `sonnet`, or `haiku`).
   These are CLI aliases, not pinned underlying model versions.

The current required minimum is **2.1.259**, defined in the
[shared contract](../src/core/contracts/claude-code.ts). A check reports **Not found**,
**meets minimum**, **update required**, or **Version could not be checked**. It runs
only `--version`, not an authentication check or model request. Meeting the minimum
proves neither authentication nor model access, quota, billing method, or complete
protocol compatibility. Each fresh model process also checks the version and
refuses an old or unverifiable installation.

Install, update, sign in, and change the CLI's account/configuration externally.
There is no LearnHarness Claude Code sign-in, reauthentication, or account-status
control. Switching the opt-in off blocks future LearnHarness requests using this
provider and preserves saved model selections; it does not interrupt an already
admitted turn or sign out the CLI. Use the normal cancellation control to stop
running work.

## Maintainer implementation

### Engine and tool bridge

[The shared engine factory](../src/agent/models.ts) registers
[`createClaudeCodeProvider`](../src/agent/claude-code/provider.ts) in Pi's model
collection. The provider's `claude-code-cli` stream adapter converts CLI stream-JSON
into native Pi assistant events. Model slots and background-role resolution use
the same engine seam as other providers; LearnHarness still owns the agent loop,
tool execution, questions, persistence, and jobs. The availability gate requires
opt-in plus a discoverable executable, not a successful authentication probe.

For each fresh process, [the adapter](../src/agent/claude-code/stream.ts) exposes the
current LearnHarness tool schemas through a temporary
[Streamable HTTP MCP bridge](../src/agent/claude-code/tool-bridge.ts). It binds only
`127.0.0.1` on an ephemeral port and requires a random per-bridge bearer token.
CLI built-in tools are disabled; the strict MCP configuration permits the declared
`mcp__learnharness__…` tools instead. Tool results return through the held MCP call,
including text, images, and error status.

**Streamed tool intent alone never authorizes execution.** An authenticated MCP
request must carry a unique `claudecode/toolUseId` matching the streamed ID, tool
name, and arguments. Missing/reused identities, undeclared tools, mismatches, and
CLI output that advances past unresolved calls fail closed. This is a required
compatibility seam, not an official stability guarantee for that CLI metadata.

### Credentials and process boundaries

[Environment provenance](../src/core/auth-env.ts) removes credentials reflected
into `process.env` **only by LearnHarness's key store** before launching the CLI
or its version probe. The original launch environment, the user's `HOME`, and
native CLI authentication/routing remain available. Thus an existing environment
API key or native CLI configuration can affect billing. LearnHarness neither
copies its saved API keys into this provider nor enforces a subscription-only
account. Prompts, relevant history, and tool results go through the CLI's configured
service.

Processes are spawned directly without a shell. Each has an empty temporary
working directory; the system prompt and token-bearing MCP configuration are in
a separate temporary directory, with files created in owner-only mode. Launch
arguments select user settings only, disable hooks and slash commands, disable
CLI session persistence and permission prompts, and restrict tools/MCP as above.
These are integration boundaries, **not an OS sandbox, legal certification, or a
blanket claim about provider-policy compliance**. User CLI settings and native
authentication are intentionally retained. Provider terms and account limits still
apply. CLI stderr is retained in a bounded buffer and logged on process close;
server logs can therefore contain CLI diagnostic information.

### Ownership, reuse, and recovery

LearnHarness's persisted transcript is authoritative, not a Claude Code saved
session. [Conversation agents](../src/agent/teacher-agent.ts) pass the existing
chat ID as Pi's `sessionId`; [background subagent runs](../src/agent/subagents/pi-run.ts)
get a fresh identity per invocation, stable across that run's tool turns.

A child normally exits after its final response. It is retained only while
LearnHarness tools are waiting for results, including a learner question. A held
child can continue only for the same stream owner and nonempty session identity,
matching tool-result IDs/names, the expected history extension, and unchanged
model, effort, system prompt, tools, and child environment. Colliding tool IDs in
two chats or runs do not grant cross-session reuse. A direct caller without a
session ID can run, but never retains a reusable child.

If there is no eligible held child—for example after timeout/restart, a changed
configuration, or history replacement—the next call starts fresh and replays the
active LearnHarness history. [Replay](../src/agent/claude-code/transcript.ts) is
labelled user/assistant/tool-call/tool-result text in a new user input, preserving
user/tool-result images; it is **not** CLI `--resume` or exact native-role/thinking
history restoration. The current system prompt and tool schemas are supplied
separately. A compatibility failure after admission is reported on continuation,
not silently hidden by replay. Recovery is not a guarantee that arbitrary CLI
failures will retry automatically.

### Waiting, cancellation, and cleanup

A question stops later tool work until the learner answers. An answer arriving
while the child is still eligible resolves its held MCP call. Held children have
a **10-minute idle timeout**; a later answer instead starts fresh with the question
and answer in replay. The CLI MCP timeout is **30 minutes**, intentionally longer
than LearnHarness's idle retention. These are held-tool limits, not a general
model-request deadline.

Request abort kills the child and ends the active stream as aborted. Cancellation
of an individual queued MCP call prevents its later admission; it cannot undo
work already admitted to Pi. Normal completion, abort, failure, and idle expiry
terminate the child, escalating to `SIGKILL` after one second if necessary. On
child close the adapter settles/closes bridge calls, releases the listener, and
removes its temporary directories. Startup failures also clean allocated
resources. This is normal-process cleanup, not a promise of cleanup after an OS
crash or forced server termination.

## Usage, context, and troubleshooting

Token counts come from CLI message stream usage (`input`, `output`, cache read,
and cache creation), not transcript length or a LearnHarness tokenizer. The
conversation meter uses the last qualifying completed response. A best-effort,
local CLI control query requests summary context metadata; a valid reported
budget supplies the denominator only for that session's matching model. It may
be lower than a model's nominal window because of CLI auto-compaction. Missing or
unsupported metadata does not block inference: the meter omits the maximum
rather than using adapter placeholders. Compaction clears earlier measurements.
See [compaction and accounting](compaction-accounting.md) for the shared rules.

LearnHarness does **not** ingest the CLI's successful result-line dollar total.
The adapter's internal zero rates are Pi-required placeholders; CLI turns/jobs
remain **unpriced**, and model menus say **CLI billing**, not free or subscription
usage. Any cost reported by the CLI itself is not proof of API charges, plan
entitlements, or the final bill. Check billing with the CLI/provider independently.

| Symptom | What to check |
| --- | --- |
| Model absent or saved choice unavailable | Enable the opt-in and check discovery under the server's OS user/environment. Saved selections are not silently remapped. |
| Not found / unchecked / update required | Repair or update the external executable, then use **Check again**. The probe has a five-second timeout and accepts a bounded version response; it does not install or authenticate anything. |
| Meets minimum, but request fails | Verify native CLI authentication, routing, model access, and quota externally. Installation readiness does not test them. |
| MCP identity/admission error | The installed CLI did not satisfy the bridge contract. No stdout-only tool fallback is available; investigate compatibility rather than bypassing admission. |
| Answer resumes with a new process | Expected after idle expiry, restart, or reuse-validation failure; history is replayed, not resumed from a CLI session file. |
| No context maximum or dollar estimate | Expected when window metadata is unavailable or billing is CLI-controlled; neither is evidence of zero usage. |

## Source and regression map

These offline tests use synthetic CLI processes and MCP requests. They establish
adapter behavior, not live account eligibility, billing, model quality, or provider
approval.

| Area | Durable references |
| --- | --- |
| Discovery, version checks, default-off gating | [binary](../src/agent/claude-code/binary.ts), [installation](../src/agent/claude-code/installation.ts), [launcher](../src/agent/claude-code/launch.ts), [opt-in tests](../tests/claude-code-opt-in.test.ts), [version-runner tests](../tests/claude-code-version-runner.test.ts) |
| Actual Settings controls and status HTTP boundary | [UI](../components/settings/claude-code-status.tsx), [HTTP handler](../src/server/claude-code.ts), [UI tests](../tests/claude-code-status-ui.test.tsx), [HTTP tests](../tests/claude-code-status-http.test.ts) |
| MCP transport and identity admission | [bridge](../src/agent/claude-code/tool-bridge.ts), [bridge tests](../tests/claude-code-tool-bridge.test.ts), [stream tests](../tests/claude-code-stream.test.ts) |
| Launch isolation, auth provenance, reuse, abort, cleanup | [stream](../src/agent/claude-code/stream.ts), [reuse comparison](../src/agent/claude-code/reuse-context.ts), [live-process registry](../src/agent/claude-code/live-processes.ts), [stream tests](../tests/claude-code-stream.test.ts) |
| Replay and learner-question lifecycle | [transcript](../src/agent/claude-code/transcript.ts), [transcript tests](../tests/claude-code-transcript.test.ts), [harness tests](../tests/claude-code-harness.test.ts) |
| Context and pricing | [window probe](../src/agent/claude-code/context-window.ts), [server pricing](../src/server/pricing.ts), [context tests](../tests/claude-code-context-window.test.ts), [usage/UI tests](../tests/claude-code-usage.test.tsx) |
