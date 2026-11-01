# Cursor

LearnHarness can teach through the Cursor subscription already signed in on this machine. There is no Cursor API key to paste. A loopback proxy turns each chat-completions call into a `cursor-agent` run, then turns the agent's text back into a stream.

## Sign in

1. Install the Cursor CLI. The binary is `agent` (some installs call it `cursor-agent`).
2. Run `agent login`.
3. Restart LearnHarness. The login check is cached for the life of the process.
4. In Settings → Agent → Models, pick a `cursor/` model. `cursor/auto` lets Cursor choose.

Settings → Providers says the same thing. The model list stays hidden until `agent status` reports that you are logged in. A turn that starts without that login is refused with: `Cursor is not signed in — run cursor-agent login, then restart LearnHarness`.

## What is sent

The lesson prompt, the conversation, and LearnHarness tool results go to Cursor through the local CLI. Image parts are not uploaded; each one is replaced with the text `[image]`. Cursor models are text-only in the picker for that reason.

The CLI runs in ask mode against an empty temporary workspace, so it is not asked to edit the learner's files. LearnHarness still owns its own tools (quiz, plan, and the rest). When a tool is needed, the model replies with a single JSON object, `{"name","arguments"}`, and the app runs the tool. Cursor's own tool events are ignored. A model that does not follow that instruction answers in prose instead of calling the tool.

## Cost and context

Cursor bills this usage on the Cursor subscription. The cost meter shows **Cursor** and does not invent a dollar price. The context window on these models is a local estimate of 200,000 tokens. The CLI does not publish one.

## If it does not connect

The desktop app's PATH often misses a user-level install. LearnHarness checks `CURSOR_AGENT_BIN`, then `~/.local/bin/agent`, `/usr/local/bin/agent`, `/usr/bin/agent`, and finally `agent` on PATH.

The proxy listens on `127.0.0.1` port **32124**. If that port is taken, set `LEARNHARNESS_CURSOR_PORT` and restart. The model catalog reads the port when the process first builds its provider list, so a port change needs a restart.

Changing the login also needs a restart. `agent logout` does not kick a running app off the catalog until the next launch.

### Replacing an older patched desktop installation

An older local installation may start a separate `learnharness-cursor/proxy.mjs` from its launcher and inject a Cursor provider into the packaged pi-ai dependency. That bridge is independent of this repository: updating the source alone does not replace it.

The old bridge can terminate with `spawn E2BIG` when a conversation exceeds the operating system's argument limit. Its stdin fallback also supplies a positional prompt, which takes precedence over stdin in the Cursor CLI. The integrated bridge fixes both paths and reports CLI failures as model errors.

Quit LearnHarness and back up its user-data directory before replacing the app. Install a complete desktop package built from this branch, point the launcher at that package, and stop the old external proxy. The integrated bridge starts on demand and needs port 32124 free. Do not copy the patched pi-ai dependency into the new package or keep the old proxy startup in the launcher. Preserve the user-data directory so sessions, settings and saved connections remain available.

If the old patch saved `CURSOR_API_KEY` with the literal placeholder `cursor-agent-login` in `auth.json` or the launch environment, remove that placeholder. It is not a credential and can override the CLI's saved login. Preserve any real keys and other saved connections.

For a Linux package directory, use Node 26 and the existing packaging steps:

```sh
npm ci
npm run build
node scripts/build-server.mjs
node scripts/smoke-server.mjs --electron
npx electron-builder --linux --x64 --dir --publish never
```

Launch `dist/linux-unpacked/learnharness` from the resulting directory. Verify that Cursor models appear and a chat responds after restarting the app; an old proxy's successful `/health` response does not verify the integrated bridge.

## For developers

Cursor is not a pi-ai builtin provider and it is not a row in `AUTH_PROVIDER_KEYS`. Those tables are pinned to pi-ai's env-key list. The provider is registered with `piModels().setProvider` after the builtins. The turn gate treats it like a subscription connection: `providerKeyPresent("cursor")` is the CLI login, not an env var. It does not use the ChatGPT/Copilot/Grok OAuth stream or background-consent path.

| Piece | Role |
|---|---|
| `src/core/cursor.ts` | The sign-in error and the Providers copy. Browser-safe. |
| `src/agent/cursor/protocol.ts` | Prompt, tool envelope, and stream-json deltas. No I/O. |
| `src/agent/cursor/proxy.ts` | Loopback chat-completions server. Spawns the CLI. |
| `src/agent/cursor/login.ts` | Binary lookup and `agent status`. |
| `src/agent/cursor/provider.ts` | Catalog and the dummy loopback key. |
| `src/agent/cursor/stream.ts` | Starts the proxy, then streams through pi-ai. |

The CLI is spawned as `agent --print --mode ask --output-format stream-json --stream-partial-output --trust --workspace <tmpdir>`. Prompts larger than 16,000 bytes are sent through stdin to stay below operating-system argument limits. Launch failures, error results and unsuccessful CLI exits propagate as model errors instead of lesson text. Partial deltas are the events whose `timestamp_ms` is a number and whose `model_call_id` is not a string. Thinking deltas become `reasoning_content`. A result event ends the stream.

pi-ai will not stream until auth resolves. The provider resolves a fixed dummy, `learnharness-local`, and the proxy does not forward it to the CLI. If that value is sitting in `CURSOR_API_KEY`, the child environment drops it so the CLI keeps using its own login. Loopback is the trust boundary.

`npm test` sets `NODE_ENV=test`. In that mode the CLI is never spawned. The catalog is the fixture `auto` and `composer-2.5`, and the login is off unless `LH_CURSOR_CONNECTED=1`. `tests/cursor-provider.test.ts` covers the protocol, the proxy (with a fake binary), and the picker gate. `tests/cursor-runtime.test.ts` exercises the production Pi engine through the bridge, including text/tool calls, long conversations, launch failures, CLI errors and a final result without a trailing newline.
