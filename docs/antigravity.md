# Antigravity

LearnHarness can use **Antigravity** as an **External CLI** provider backed by Google's official ACP runtime (`agy_acp_server` or `agy acp`). Antigravity owns authentication, routing, model availability, and quota/billing (**CLI billing**); LearnHarness never reads raw API keys for this provider and scrubs ambient Google/Gemini/Vertex keys from child processes.

## Set up

1. Open **Settings → Providers → External CLI** and enable **Antigravity**. This app-wide opt-in is **off by default** and never probes binaries or network endpoints while disabled.
2. Provide an **Antigravity Runtime** using any supported source (see precedence below). If none is detected, click **Install runtime** to download and verify Google's official `agy-acp-server` package into LearnHarness's data directory.
3. Once the runtime status is **Ready**, click **Sign in with Google** and complete the Google OAuth flow.
4. After sign-in finishes, LearnHarness automatically discovers available models and supported thinking levels and adds them to the model picker.

### Runtime discovery precedence

When Antigravity is enabled, LearnHarness resolves the runtime in strict priority order:

1. **`LH_ANTIGRAVITY_BIN`** environment variable (source badge: **Env override**).
2. **Custom binary path** saved in Settings (`antigravity.binaryPath`, source badge: **Custom path**). Accepts `agy`, `antigravity`, or `agy_acp_server` (automatically pairing an adjacent `localharness_external` binary when present).
3. **LearnHarness-managed runtime** under `<LH_DATA_DIR>/antigravity/runtime/<platform>-<arch>/` (source badge: **Managed**).
4. **`agy` / `antigravity` CLI** found on `PATH` or common user/system locations (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, Nix profiles, or `%LOCALAPPDATA%\Programs\Antigravity\bin` on Windows), validated at **v1.5.0+** via a bounded five-second `--version` check (source badge: **System CLI**).
5. **T3 Code auto-detection** under `~/.t3/tools/antigravity-acp/<platform>-<arch>/` (source badge: **T3 Code (read-only)**).

If `LH_ANTIGRAVITY_BIN` or a custom binary path is configured but missing or not executable, LearnHarness reports an explicit error rather than silently falling back.

### Managed runtime download vs external runtimes

- **Install runtime** / **Install managed copy** downloads Google's `agy-acp-server` **1.4.5** release archive for the host OS/architecture (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64`), verifies exact archive byte size and SHA-256 digest, extracts via streaming `yauzl` with zip-slip/absolute-path/symlink rejection, verifies extracted executable and `localharness_external` sizes, probes ACP `initialize`, and writes atomic completion markers.
- When using T3 Code auto-detection, **Install managed copy** lets you switch to a LearnHarness-managed install if desired.
- **Remove** deletes **only** LearnHarness-managed files under `<LH_DATA_DIR>/antigravity/runtime/` and never modifies T3 Code, system CLI, or custom binary paths.

## Google OAuth and headless callback forwarding

Antigravity uses `oauth-personal` authentication inside the ACP server (`ADR-0001`):

1. Clicking **Sign in with Google** starts an authentication attempt (`starting` → `waiting` → `verifying` → `succeeded | failed | cancelled`) and launches the runtime with a preflight-verified executable `BROWSER` wrapper script (`open-url.sh` / `open-url.cmd` plus a POSIX `xdg-open` shim prepended to `PATH` for `agy` CLI on Linux) alongside a concurrent `stderr` line parser (`Open the following link to authenticate the ACP server:`).
2. Captured authorization URLs are strictly validated (both `https://accounts.google.com/o/oauth2/v2/auth` with `redirect_uri=http://127.0.0.1:<port>/` for `agy_acp_server`, and `https://accounts.google.com/o/oauth2/auth` with `redirect_uri=http://localhost:<port>/auth/callback` or `127.0.0.1` for `agy` CLI, with `response_type=code`, non-empty `state`, and `port >= 1024`).
3. **Local browser**: LearnHarness opens the authorization URL in a new tab/browser window. When Google redirects back to the local loopback callback, the ACP runtime's callback listener completes authentication automatically.
4. **Headless or remote servers**: If the browser runs on a different machine from the LearnHarness server, use **Open link ↗** or **Copy link** to complete Google sign-in in your local browser. When the browser lands on the unreachable `http://127.0.0.1:<port>/...` or `http://localhost:<port>/auth/callback?...` URL, copy the full URL from the address bar, paste it into **Paste redirect URL**, and click **Submit redirect**. LearnHarness validates the matching host/path, port, timing-safe `state`, and `code`/`error` parameters before forwarding the `GET` request to `127.0.0.1:<port>`.
5. **Cancel** terminates an in-progress attempt cleanly. **Sign out** invokes ACP `logout`, deletes `acp_token.json` / `antigravity-oauth-token`, removes cached `models.json`, and immediately removes Antigravity models from the model picker.

## Antigravity Profile vs `LH_DATA_DIR` boundaries

LearnHarness strictly separates OAuth secrets from shareable learning data (`ADR-0002`):

| Path | Contents | Boundary |
| --- | --- | --- |
| `<dirname(LH_AUTH_FILE)>/antigravity-profile/` | **Antigravity Profile** (`GEMINI_HOME` / `--gemini-dir`): `0700` dir, `0600` `antigravity-acp/settings.json` (`oauth-personal`), `acp_token.json` (or `antigravity-oauth-token` + `cache/antigravity-keyring-unavailable` marker for `agy` CLI), plus optional best-effort `~/.gemini` skills symlinks | Machine-local secrets; excluded by `.gitignore`, `next.config.ts` (`outputFileTracingExcludes`), and refused by `scripts/build-server.mjs` |
| `<LH_DATA_DIR>/antigravity/runtime/` | Managed `agy_acp_server` and `localharness_external` binaries + atomic markers | Non-secret runtime install |
| `<LH_DATA_DIR>/antigravity/models.json` | Cached discovered model IDs, context limits, and `thinkingLevelMap` | Non-secret capability cache |

Every Antigravity child process runs in a disposable temporary directory (`cwd` + `tmp`), strips LearnHarness-reflected BYOK keys (`externalCliEnv`) plus ambient `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, Vertex/GCloud project variables, SSH session variables (`SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`), and conflicting runtime flags (`ANTIGRAVITY_ENV_STRIP_KEYS`), and sets `GEMINI_HOME`, `TMPDIR`, `AGY_ACP_FORCE_FILE_STORAGE=1`, `PYTHONUNBUFFERED=1`, `ELECTRON_RUN_AS_NODE=1`, `ANTIGRAVITY_HARNESS_PATH` (when applicable), Linux `SSL_CERT_FILE` fallback if unset, `--uid=` on Linux for `agy_acp_server`, and `--gemini-dir <profileDir> --app-data-dir antigravity-acp` (plus a fresh `cache/antigravity-keyring-unavailable` marker and `DISPLAY=":0"` fallback during headless Linux `startAuth`) for `agy` CLI runtimes.

## Dynamic models, context, and CLI billing

- **Discovery**: Sign-in completion and **Refresh models** probe ACP `session/new` (sending `clientInfo: { name: "zed", version: "0.0.0" }` for runtimes `< 1.5.1` to unlock non-Gemini models, and `learnharness/0.6.1` for `>= 1.5.1`) and call `setConfigOption` per model (4-second per-model timeout with graceful fallback) to map `thought_level` values into Pi's seven-level `thinkingLevelMap`.
- **Picker readiness**: Antigravity models appear in `GET /api/models` and the model picker only when **all four** gates pass: Antigravity enabled, signed in (`acp_token.json` or `antigravity-oauth-token` present), non-empty `models.json`, and a synchronously resolvable runtime. Server boot and `GET /api/models` never spawn ACP processes.
- **Usage & billing**: Streamed `usage_update` and prompt usage populate token meters and `cliContextWindow` when provided; missing context windows stay unknown rather than guessed. Dollar costs remain **unpriced** (`cost: null`), and menus label these models **CLI billing**—internal zero rates are Pi placeholders, not free inference. See [accounting](compaction-accounting.md).

## Tool bridge, process parking, replay, and cleanup

- **MCP bridge & permissions**: LearnHarness exposes its declared harness tools over a loopback (`127.0.0.1`) `StreamableHTTPServerTransport` MCP server (`learnharness`) protected by a per-run 32-byte bearer token, rejecting undeclared tool names. Built-in `run_workflow` is suppressed via `_meta.antigravity.disabledTools`, `fs` and `terminal` capabilities are `false`, and `session/request_permission` requests are approved **only** when they match a declared tool on the `learnharness` MCP server for the active session—native Antigravity tools and any other permission requests are unconditionally declined.
- **Process parking**: When an ACP turn calls a LearnHarness tool such as `ask_user_question` or a quiz/problem tool, the live ACP child parks for up to **10 minutes** idle (with a **30-minute** MCP bridge timeout for headroom). The next turn reuses the parked process only if the stream owner, `sessionId`, configuration (`model`, `reasoning`, `systemPrompt`, `tools`, `runtime`, `profileDir`), conversation prefix, and pending `toolCallId`/`toolName` batch all match.
- **Cold-start replay**: If no eligible parked process exists (after idle expiry, restart, missing `sessionId`, or configuration/history mismatch), LearnHarness cold-starts a fresh ACP session and replays history as labelled `[user]`, `[assistant]`, `[tool call ...]`, and `[tool result ...]` blocks while preserving text and image attachments (omitting thinking blocks and system messages).
- **Clean shutdown**: Terminating an ACP process closes `stdin` first (400 ms grace, or 50 ms on forced abort/cancel) and escalates directly to `SIGKILL` without sending `SIGTERM`, avoiding absl crash dumps from `agy_acp_server`. Active/parked processes and temporary run directories are cleaned up on abort, idle expiry, and server `SIGINT`/`SIGTERM`/`exit`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Models absent from picker | Confirm **Antigravity** is enabled, status is **Ready**, Google sign-in shows **Signed in with Google**, and at least 1 model is discovered (**Refresh models**). |
| Custom path or `LH_ANTIGRAVITY_BIN` error | Verify the exact path exists and is executable by the user running the LearnHarness server; invalid overrides fail explicitly without fallback. |
| System CLI says update required | Upgrade `agy`/`antigravity` to **v1.5.0+** or clear/override with a managed install. |
| Linux `AF_INET6` / `enforce_kernel_ipv6_support` failure | Enable kernel IPv6 support on the Linux host and retry; `agy_acp_server` requires `AF_INET6` loopback support. |
| Sign-in browser does not complete automatically | On remote/headless hosts, copy the `http://127.0.0.1:<port>/?...` redirect URL from the browser address bar into **Paste redirect URL** and click **Submit redirect** before the 5-minute attempt expires. |
| Answer cold-starts a new process | Expected after the 10-minute idle park timeout, server restart, or any change to model, thinking level, prompt, or tools. |
| No dollar cost or missing context limit | Antigravity uses **CLI billing** (unpriced); missing context limits reflect omitted runtime metadata rather than zero limits. |

## Maintainer entry points

- **Contracts & ADRs**: [`src/core/contracts/antigravity.ts`](../src/core/contracts/antigravity.ts), [`ADR-0001`](adr/0001-antigravity-acp-server-oauth.md), [`ADR-0002`](adr/0002-antigravity-profile-secret-boundary.md).
- **Agent runtime**: [`src/agent/antigravity/`](../src/agent/antigravity/) (`installation.ts`, `release.ts`, `profile.ts`, `auth.ts`, `acp-client.ts`, `models-discovery.ts`, `tool-bridge.ts`, `live-processes.ts`, `reuse-context.ts`, `transcript.ts`, `stream.ts`, `provider.ts`, `constants.ts`).
- **Server, catalog & routes**: [`src/server/antigravity-config.ts`](../src/server/antigravity-config.ts), [`src/server/antigravity-provider.ts`](../src/server/antigravity-provider.ts), [`src/server/antigravity.ts`](../src/server/antigravity.ts), [`app/api/antigravity/`](../app/api/antigravity/), [`src/agent/models.ts`](../src/agent/models.ts), [`src/server/model-catalog.ts`](../src/server/model-catalog.ts), [`src/server/pricing.ts`](../src/server/pricing.ts).
- **UI**: [`components/settings/antigravity-status.tsx`](../components/settings/antigravity-status.tsx).
- **Automated tests**: `tests/antigravity-*.test.*` use synthetic fake-ACP fixtures and run without network access or real Google credentials.
