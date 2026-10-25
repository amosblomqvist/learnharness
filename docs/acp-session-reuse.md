# ACP session reuse

Codex and Claude Code can keep one native session and one in-flight ACP prompt across multiple Pi tool calls. Pi still owns validation, execution, lesson state, question stops and the saved conversation. The native MCP request waits until a compatible next Pi call supplies the actual application tool result.

## Compatibility and privacy

Reuse is scoped to the Pi conversation ID, including across new teaching-agent instances after a learner answers. Background runs use their own unique IDs. Callers without an ID are isolated to their engine instance.

The next request must match the adapter configuration, native model, reasoning level, system instructions, tool declarations and prior model-facing history. The only new messages may be the expected tool results, with matching IDs and tool names and no duplicates. Display IDs, timestamps and accounting fields do not affect comparison. Changed history, app compaction, steering, model/reasoning changes or tool changes discard native state and replay the authoritative app record. Copied history from another conversation cannot claim a pending session. Concurrent callers cannot both resume the same session.

Codex's existing native proxy and ephemeral acknowledgement requirement are unchanged. Reuse retains the verified native session; it introduces no saved-chat load/resume path. Every reconstructed session must pass the same ephemeral check before prompting. Claude keeps `tools: []`, `settingSources: []` and `persistSession: false`; native coding permissions remain declined.

## Lifetime and accounting

- Native prompts close on completion or failure. Stop/cancellation terminates the retained process tree and closes the MCP endpoint, including cancellation during a tool handoff or after resumption.
- A waiting teaching question may retain native state until the learner's next answer. A finite background run releases its session when it finishes, including a final submit that ends Pi before another model call.
- Successful connection rechecks release waiting sessions and retire active sessions after their current call, preserving an in-progress reply. Disconnects and chat deletion release matching retained state. Session cleanup also waits for process disposal already triggered by an abort.
- Idle retention is capped at ten minutes and four waiting sessions, evicting the oldest waiter first. Each active model call has its own ten-minute deadline; time waiting for a learner/tool does not consume the resumed call's budget. Native adapter timeouts can expire a session earlier. Later input reconstructs from the saved app history; tools already recorded in that history do not run again merely because a session expired.
- A failed or abandoned MCP request invalidates the retained session. Parallel native tool requests are handed to Pi in sequence, and each real result reaches its own waiting request.
- Usage is recorded only when the adapter reports it. Intermediate Pi tool steps can have no token counters while a native prompt is still pending. Completion counters are recorded once; no per-step token split, API dollar charge or cache saving is inferred.

The app's compaction invalidates reuse. This optimization does not remove the native agent runtime or independently disable its own context management.

## Verification

The initial regression failed for both adapters: one tool operation created two native processes instead of one. The same test now observes one initialization, one native session and one prompt, and verifies that the actual application result reaches that native prompt without replay.

An accelerated-clock regression also reproduced the old absolute RPC deadline expiring during a resumed model call after a long learner pause. The session now owns separate active/idle deadlines. Tests verify both that waiting does not consume inference time and that genuinely hung inference still terminates.

Offline subprocess tests cover sequential/parallel calls, schema-error retries, real teacher question pause/resume, a new engine with the same conversation ID, incompatible context/model/reasoning/tool changes, cross-conversation isolation, mismatched tool results, concurrent claims, stale abort signals, cancellation, adapter exit, idle expiry and finite-run cleanup. Codex history fixtures confirm that multiple tool calls retain one verified ephemeral session without producing stored chat files; ignored ephemeral flags still fail before prompting.

The orphan-cleanup regression allows up to two seconds for asynchronous signal delivery. On Linux, an already terminated process awaiting OS reaping counts as stopped. A live-process positive control must fail the same assertion, so a running descendant cannot pass merely because it still has a PID. Temporary diagnostic logging was removed after reproducing the immediate-PID race in CI.

Live checks on the installed Codex ACP 2.2.2 and Claude ACP 0.95.0 adapters used two dependent MCP calls: the first returned a random code that the second had to provide. Both completed with exactly **one initialization, one session and one prompt**. Codex used `gpt-6.1-sol` at low reasoning; Claude used `claude-sonnet-4-6` at low reasoning. Codex's native ephemeral acknowledgement was verified before inference, and both native workspaces were removed afterward. No app lesson was created for these checks. Credentials remained in the CLIs' own stores and were not printed or committed. A separate desktop chat lookup was unavailable, so it was not counted as an additional verification result.

The final Windows test run executed **2,216 tests: 2,204 passed, 12 failed**, with no canceled or skipped tests. All ACP tests passed. The twelve remaining failures are the same POSIX mode/Windows ESM-path cases recorded in the [upstream sync report](upstream-sync-2026-10-25.md#verification). Typecheck, lint, a fresh Webpack build and payload curation passed; curation excluded 1,155 private trace entries.

The packaged HTTP exercise uses a disposable profile, empty credentials and the offline fixture adapter. It verifies that separate question and answer requests share one native process/session/prompt, that the real learner answer returns through MCP, and that deleting a chat or disconnecting releases native state across separate API routes. Run it after building and curating the standalone payload:

```sh
node scripts/smoke-acp-reuse.mjs
node scripts/smoke-acp-reuse.mjs --electron
```

Both HTTP exercises passed, as did the existing `smoke-server.mjs` checks under host Node and Electron, including offline provider initialization and dependency confinement.

The standalone CI matrix runs both ACP HTTP exercises after payload curation on macOS, Windows and Linux. Local execution in this report covers Windows; CI supplies the additional platform checks and the complete Linux suite. Current results are linked from [PR #94](https://github.com/amosblomqvist/learnharness/pull/94).

These checks demonstrate session reuse and preserved tool execution. Latency improvement and token/cache savings have not been measured.
