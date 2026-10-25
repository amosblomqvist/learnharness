# Upstream sync and subscription verification — 2026-10-25

## Commit identity

The ACP feature commit was amended to `b5a6a503f86ec8ed41c5026e0a6a570dc9e876d6` with both author and committer using `222277241+Yawsom@users.noreply.github.com`. Its source tree is identical to the previous feature commit. The corrected commit was pushed with an exact force-with-lease, and this checkout's repository-local Git email now uses the same no-reply address for future commits.

This replaces the commit referenced by the fork's main branch; it does not erase copies of an old commit object from caches or other clones.

## Upstream integration

The fork was one commit ahead and 30 behind `amosblomqvist/learnharness:main`. The merge integrates upstream `b277ee3e0fa24249c1b2d0f9b7fd6ed485f484b9` (version 0.3.7), preserving upstream history and the existing ACP implementation.

Conflict resolutions retain both implementations' behavior:

- Upstream's app-owned ChatGPT, GitHub Copilot and Grok connections coexist with local Codex and Claude Code ACP connections. **Providers** remains the first settings page; the ACP **Subscriptions** page remains available.
- The shared model catalog includes both connection families. ACP connect/disconnect signals invalidate every catalog reader, and stale responses cannot restore a disconnected catalog. Model and reasoning selections still use the existing picker and settings paths.
- The server engine seam forwards upstream's foreground/background purpose and dispatch lifecycle for native connections. ACP still resolves only trusted local executable configuration.
- Upstream's Pi-based pricing, per-call job accounting, one-hour cache writes and context measurement are retained. ACP subscription turns receive provider labels rather than fictitious API dollar prices; unreported ACP usage stays absent.
- Upstream's staged automatic request persistence and provider-error visibility are retained alongside ACP accounting-failure cleanup.
- Desktop access controls, Google provider tracing, OAuth runtime assets, research without search keys and release changes are retained. ACP process assets and prompt trees remain in the standalone payload; Codex ephemeral history isolation remains enabled.

## Claude checks on Windows

The reported connection failure did not reproduce with the machine's current subscription sign-in and configured adapter paths. The checks used `@agentclientprotocol/claude-agent-acp` 0.95.0 and Claude Code 2.1.310:

1. Native ACP initialize and session creation succeeded.
2. A minimal direct subscription prompt completed successfully.
3. The app's Claude Connect HTTP route returned 200, and **Check connection** in the rebuilt UI completed without an error.
4. A real app conversation dispatched the LearnHarness `ask_user_question` MCP tool without a provider error.
5. The merged build completed another real tool turn with the advertised named model `claude-sonnet-4-6` and explicit `low` reasoning. The saved session retained both selections. Its pricing reported Claude Code subscription use, zero API dollars and no unpriced API turn. The browser displayed the structured question, **Sonnet 4.6**, **low** and **Claude Code**.

These checks made real subscription requests. They establish successful operation with the current account and installation, not the cause of the earlier failure. Temporary test conversations were removed; existing lessons and default model settings were preserved. Credentials were neither printed nor committed. See [self-launch and troubleshooting](acp-manual-test.md) for rebuilding an old standalone app, selecting Claude in an existing session, adapter paths and reporting a reproducible error.

## Verification

- `npm run typecheck` and `npm run lint` passed.
- The focused ACP/accounting group passed 100 tests. The adjusted settings/tracing group passed 58; shared catalog tests passed all four, including the new ACP invalidation regression.
- `npm run build -- --webpack` passed. `node scripts/build-server.mjs` excluded 1,120 private trace entries and accepted the curated payload without moving or deleting original app data.
- Both `node scripts/smoke-server.mjs` and `node scripts/smoke-server.mjs --electron` passed. Their offline native provider probes initialized Google, Copilot and Grok transports with zero network attempts and confirmed module confinement to the payload. Server routes returned 200 using disposable data and empty app keys.
- The final full Windows run (`npm test -- --test-concurrency=4`) executed **2,181 tests: 2,169 passed, 12 failed**, with no canceled or skipped tests. All ACP and merge integration regressions passed.

The remaining failures are Windows portability cases, not suppressed passes:

| Test file | Failures | Observed issue |
|---|---:|---|
| `tests/auth-store.test.ts` | 1 | Windows reports `0666` rather than the asserted POSIX `0600` mode. |
| `tests/chatgpt-file-store.test.ts` | 1 | The same POSIX mode assertion in unchanged incoming upstream code. |
| `tests/subscription-auth.test.ts` | 2 | The same POSIX mode assertion for incoming Copilot/Grok storage tests. |
| `tests/data-dir-seam.test.ts` | 1 | A Windows drive path is passed to an ESM import. |
| `tests/schema-stamps.test.ts` | 1 | A file URL pathname produces a doubled Windows drive prefix. |
| `tests/verify-release.test.ts` | 6 | The release CLI test harness imports Windows drive paths directly. |

Nine were reproduced against the original baseline during the [earlier review](review-2026-10-25.md#commit-validation). The three additional mode assertions arrived in upstream files that remain unchanged by this merge. The full suite is not green on Windows; POSIX runtime behavior remains untested on this host. Live Claude inference is now verified as described above, superseding that earlier verification limit.
