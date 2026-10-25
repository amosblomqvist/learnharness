# Codex and Claude Code subscriptions

LearnHarness can run its teaching, practice, research, extraction, demo, and vision agents through local Codex or Claude Code agents using the [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview). The native agent uses your subscription sign-in and its plan allowance. Provider eligibility, model access, and usage limits still apply. Optional web-search services and dictation retain their separate service keys.

## Setup

Open a local checkout with `npm run app` after building and curating its standalone payload. See [open/rebuild instructions and the acceptance exercise](acp-manual-test.md). The local launcher and Electron bind to loopback and enable ACP; ordinary public web deployments keep ACP process connections disabled. `data/local-app/`, subscription sign-ins and installed adapters are machine-local and are not included in a clone.

Install Node.js 22 or newer and the CLI/adapter for the provider you want to use. If the CLI is already installed through another supported method, install only the adapter package.

Codex:

```sh
npm install -g @openai/codex @agentclientprotocol/codex-acp
codex login
```

Choose ChatGPT sign-in. [Codex authentication](https://learn.chatgpt.com/docs/auth) distinguishes subscription access from API-key billing.

Claude Code:

```sh
npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp
claude auth login
```

Choose your Claude subscription account. See [Claude Code with a subscription](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan). If you previously signed in with an API key, switch the CLI to your subscription before connecting.

In LearnHarness:

1. Open **Settings → Subscriptions**, or use the subscription connections in first-run setup.
2. Click **Connect** for Codex or Claude Code. This checks the installed adapter, MCP/image support, and subscription authentication, then discovers its models and each model's reasoning options without sending an inference prompt. It does not open a login browser on your behalf. Reconnect after upgrading an adapter or changing account/model access to refresh those choices.
3. Pick the connected agent for **Strong**, **Cheap**, and **Vision**. The same subscription can fill all three slots; API models and the other subscription can also be mixed by slot or background role. Existing sessions keep their own model selection; change it with the session's model picker.

The existing model picker below the composer and the model-slot pickers list the installed adapter's advertised models. The adjacent thinking picker offers the reasoning levels reported for that specific model. Model swaps retain an explicit level where possible and clamp it to the new model's supported levels. **Agent default** remains available for both model and reasoning: an unset reasoning choice delegates to the native agent; an in-session reset inherits a configured Strong-slot reasoning choice, following the existing session/slot resolution rule. Models with no advertised reasoning options keep that control disabled.

Choices are saved per slot or per session through the existing settings paths. Named model IDs are stored as `model/<native ID>` to distinguish the adapter's own `default` model from older `default` connection pins. Existing pins continue using the agent default until changed. Every fresh ACP round applies explicit model and reasoning choices before prompting, checks the resulting native configuration, and refuses unavailable choices instead of silently choosing another model. The cost display identifies subscription use as **Codex** or **Claude Code**; mixed sessions also show API dollar estimates for API-backed turns.

### Executable paths

The default executables are `codex-acp` and `claude-agent-acp`, resolved through the server process's `PATH`. Desktop applications can have a different `PATH` from your terminal. Custom paths belong in a host-owned JSON file selected by `LH_ACP_HOST_CONFIG`. The local launcher creates `data/local-app/acp-host.json`; edit it locally and restart the app.

For example, use adapter executables on PATH:

```json
{
  "codex": { "command": "codex-acp", "args": [] },
  "claude": { "command": "claude-agent-acp", "args": [] }
}
```

Windows `.cmd` shims and paths containing spaces are supported. Executable and arguments are separate fields; the executable field is not a shell command. An absolute Node executable with an adapter script path in `args` also works. Browser Connect requests accept only an empty object and require a same-origin local app request. Saved legacy command/args fields in HTTP-writable user settings are ignored when launching a process.

## Authentication and failures

Credentials remain in the native CLI's own credential storage. LearnHarness saves connection preferences and a non-secret snapshot of advertised model/reasoning choices in `settings.json`; it neither reads nor copies OAuth tokens. Child processes exclude the app's provider API keys and provider-routing environment overrides. Before inference, the adapter must report `account` authentication through its `_auth/status_update` extension. API-key, gateway, cloud, logged-out, or unreported authentication is rejected. Older adapters that cannot report the authentication type must be updated.

Connect checks installation and sign-in, rather than proving that a model request will succeed. Expired sessions, unavailable models, provider outages, and exhausted plan limits can still fail a turn. These failures are surfaced without switching to API billing. Disconnect hides the agent from model pickers; it preserves existing session records and model pins, and does not log the native CLI out.

The released adapter protocol handshakes were checked with `@agentclientprotocol/codex-acp` **2.2.2** and `@agentclientprotocol/claude-agent-acp` **0.95.0**. Subscription inference requires the user's own active sign-in and is not exercised by the offline test suite.

## Implementation

- `src/server/acp.ts` is the composition seam: it reads connection preferences and chooses ACP or the existing pi-ai engine for a resolved model spec. Slot resolution and all stores keep their existing ownership.
- `src/agent/acp/client.ts` owns stdio JSON-RPC, authentication checks, native tool permissions, timeouts, cancellation, and process-tree cleanup. Windows uses an OS Job Object with kill-on-close ownership, assigned before the adapter starts; POSIX owns a process group even after its leader exits. Native coding/file/terminal permissions are declined; only the registered LearnHarness MCP tools can be approved.
- `src/server/acp-host.ts` reads executable configuration from the trusted local host file and gates connection mutations to the loopback local launcher. HTTP settings never provide executable authority.
- `src/core/usage.ts` preserves optional reported counters through chat, job, extraction and compaction accounting. Internal numeric defaults required by pi are not persisted as measured usage. ACP `thoughtTokens` maps to reasoning without counting it twice.
- `src/agent/acp/catalog.ts` discovers model-specific choices through ACP `configOptions` and applies saved selections with `session/set_config_option` before inference. Discovery only changes its throwaway native session. Grouped options are supported; legacy `models`/`session/set_model` remains a fallback for adapters without model configuration controls.
- `src/agent/acp/tool-bridge.ts` exposes current tool declarations through a temporary, bearer-authenticated loopback MCP endpoint. It holds requests without executing them. The existing Pi loop validates and executes tools; compatible continuation returns the actual result through the held request, including validation errors and images.
- `src/agent/acp/engine.ts` adapts ACP text/thought updates into the existing Pi stream. `session.ts` retains a native prompt across compatible tool calls, keyed by the Pi conversation ID. A learner's answer can resume through a new server-side engine. Reuse requires the same launch/model/reasoning/prompt/tools and unchanged model-facing history followed only by the expected tool results. A mismatch, steering or app compaction closes native state and replays the current app transcript into a fresh session. `transcript.ts` owns replay and content comparison.

Retained state is an optimization; the app record remains authoritative. One native `session/prompt` stays in flight while Pi supplies successive tool results. Completed prompts, finite background runs, aborts, connection checks/disconnects and chat deletion release native resources. Idle retention is bounded to ten minutes and four waiting sessions, with earlier expiry possible from native/RPC timeouts; a later answer reconstructs from the saved record. Native context management remains with the agent; unavailable token counts and context limits are not estimated. Reported usage is recorded once when the native prompt completes; intervening Pi tool steps remain unreported rather than receiving fabricated counters. See [session reuse and verification](acp-session-reuse.md). Configuration follows the [ACP session configuration protocol](https://agentclientprotocol.com/protocol/v1/session-config-options).

### Native chat history

LearnHarness's saved lesson is the conversation record. Codex rounds use **ephemeral native threads**, so replay prompts do not become separate chats in the Codex app. The installed Codex ACP 2.2.2 adapter does not forward an ephemeral option on `session/new`; LearnHarness supplies a private `CODEX_PATH` stdio proxy which sets `thread/start` (and `thread/fork`) to `ephemeral: true`. It verifies the native acknowledgement before allowing a prompt. An adapter that bypasses the proxy, or a CLI that ignores the flag, is refused rather than saving internal chats.

The proxy retains the adapter's bundled Codex version, or an explicitly configured native `CODEX_PATH`, and uses the existing subscription sign-in. It does not relocate `CODEX_HOME` or read/copy credentials. Session reuse keeps this already verified ephemeral session in memory; it does not load a saved Codex chat or bypass verification when reconstruction creates a new session. Claude receives `persistSession: false` in its native options. See the [official app-server thread protocol](https://learn.chatgpt.com/docs/app-server).

Older internal replay chats created before this fix can be archived in Codex. Archiving them does not remove the lesson saved by LearnHarness. After installing/rebuilding this fix, restart LearnHarness with `npm run app`. The history-isolation regression suite uses a fake native CLI to verify that repeated rounds create no stored chats, ignored flags fail, incompatible adapters are refused, and the bundled CLI is retained.

The adapters are user-installed local programs and are not bundled into the desktop release. Source references: [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp), [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp), and [ACP session/MCP setup](https://agentclientprotocol.com/protocol/v1/session-setup).

## Verification

For hands-on testing, use the [local ACP acceptance test](acp-manual-test.md). The [2026-10-25 adversarial review](review-2026-10-25.md) records the ACP-related fixes, including the subsequently found native-history issue, their regression evidence, and the four independent repository findings still open.

`tests/acp-engine.test.ts` runs real fixture subprocesses and a loopback MCP client: streaming, tool permissions, validation retries, teaching-question pause/resume, images, authentication errors, cancellation, and descendant cleanup. `tests/acp-connections.test.ts` checks connection writes, model-slot integration, billing separation, and route validation. `tests/acp-ui.test.tsx` and the setup interaction suite cover subscription-only onboarding and billing labels. These tests make no external inference requests.

Run the normal test suite, lint, typecheck, and production build. The ACP integration tests require local loopback networking and permission to terminate their fixture child processes.

`tests/acp-models.test.ts` checks both providers' discovery, model-specific reasoning, persisted metadata, model/effort application on repeated rounds, legacy default pins, opaque native `default` IDs, and refusal of expired/ignored choices. `tests/acp-picker.test.tsx` drives the existing composer picker for both providers, including per-session persistence, remount, keyboard cycling, and resetting reasoning to the agent default.

`tests/acp-history.test.ts` drives the native CLI boundary through real offline subprocesses to verify ephemeral sessions, refusal of ignored flags/incompatible adapters, and preservation of the adapter's bundled CLI. `tests/svg-isolation.test.tsx` checks the inline/fullscreen image boundary for generated figures.

`tests/acp-reuse.test.ts` checks native process/session/prompt counts across sequential and parallel calls, real tool results and validation retries, question pause/resume through a new engine, context/model/prompt/tool invalidation, conversation isolation, cancellation, process exit, idle expiry and finite-run cleanup. History tests also cover a verified ephemeral Codex session across multiple application tool calls.
