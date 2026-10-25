# Run and test ACP locally

## First build

Use Node.js 22 or newer. Open a terminal in the project directory containing `package.json` (the `learnharness` directory if your checkout has an outer wrapper folder), then run:

```sh
npm ci
npm run build -- --webpack
node scripts/build-server.mjs
npm run app
```

The CLI and ACP adapter for each subscription are installed separately; follow [subscription setup](acp-subscriptions.md) before connecting. They are not included in the checkout or desktop payload.

Open [LearnHarness](http://127.0.0.1:3005/chat/new) after startup. Keep the terminal open; **Ctrl+C** stops it. The launcher binds to `127.0.0.1` and enables local ACP connections.

This Webpack build path was verified on Windows. The default Turbopack build encountered a CSS-worker failure on the tested Windows environment. Always run payload curation after rebuilding standalone output.

## Reopen or develop

After the first build, reopening only needs:

```sh
npm run app
```

Routine reopening does not require reinstalling or rebuilding. After source changes, repeat the build and curation commands before launching. If port 3005 is already in use, check the existing app terminal/browser or select another port.

For source development with an Electron window, use `npm run desktop:dev`. It starts a loopback Webpack dev server and Electron using portable Node environment setup. Both launchers use the same local profile; stop one before running the other.

## Local profile and adapter paths

Saved lessons, settings and app keys live in `data/local-app/` by default. This directory is ignored by Git and excluded from desktop payloads; a fresh clone does not include another machine's lessons, connection state or installed adapters.

Native subscription credentials stay in the CLIs' own storage. The launcher creates `data/local-app/acp-host.json` for optional adapter executable/argument configuration. Empty entries use adapters on PATH. See [executable configuration](acp-subscriptions.md#executable-paths) for the JSON format. Edit this file locally and restart the app after changing paths.

Desktop applications can inherit a different PATH from a terminal. If an installed adapter is not found, use its absolute executable path in the local host file. Browser requests cannot set executable paths.

## Connect and choose models

1. Sign in with your subscription through `codex login` or `claude auth login`.
2. Open **Settings → Subscriptions** and click **Connect** for the desired agent. This checks account sign-in and discovers models/reasoning options without inference.
3. In **Settings → Agent → Models**, choose a connected subscription model for Strong, Cheap and Vision. One subscription can fill all three.
4. The existing picker below the composer chooses the session's model. The adjacent thinking picker selects supported reasoning effort. **Agent default** delegates to the adapter, unless an existing Strong-slot reasoning setting is inherited.
5. Reconnect after an adapter update, changed subscription, or changed model access to refresh the advertised choices.

A successful connection check does not prove remaining plan allowance or inference availability. Public web startup does not enable ACP; use the local launcher or Electron.

### Windows Claude npm installation troubleshooting

For the tested Claude Code npm package, if its native installer was skipped by npm script policy and the installation includes `cli-wrapper.cjs`, the supplied wrapper can perform sign-in. Replace the path with your actual installation:

```powershell
node 'C:\path\to\node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs' auth login
```

Complete subscription sign-in yourself, then connect Claude in Settings.

If Claude still fails, distinguish **Connect** from a message failure. Start the app with `npm run app`, check the adapter path under **Settings → Subscriptions → Claude Code → Adapter location**, and use **Check connection** after changing sign-in or upgrading the adapter. Restart the app after editing the host file. Existing chats keep their own model; choose Claude in the picker below the composer even if the Strong default has changed.

After updating the source, stop the old app terminal and repeat the build and curation commands above. Restarting an old standalone build does not load source changes. Report the visible error and whether it occurs on Connect or after sending a message; never include credential files or tokens.

## Acceptance exercise

1. Start a lesson, such as “Teach me how transformers work.”
2. Choose a named Codex model and reasoning level using the composer controls. Submit a prompt; verify the response, selected model and **Codex** subscription cost label (**Claude Code** for Claude). Subscription turns must not acquire an API dollar estimate.
3. Answer a teaching question. Check that the lesson resumes and the answer survives a page refresh.
4. Change model/reasoning and send another turn. Verify the choices persist after reopening.
5. Stop an active turn; verify activity clears and another input works.
6. Ask for a figure or interactive demo. Check the background result, teacher continuation and fullscreen figure controls.
7. Disconnect a subscription while a background role is pinned to it, then dispatch that role. It should return an explicit failure rather than remain running. Reconnect afterward.
8. Repeat with Claude after sign-in.

Answer a teaching question while its session is still warm, then repeat after an idle gap longer than ten minutes. Both answers should resume correctly; the latter can rebuild from saved history. Change the model or reasoning while waiting for a question and verify that the next response uses the new selection. Stop a tool-heavy request and verify another input works. Check Codex's sidebar for unwanted replay chats throughout. See [session reuse](acp-session-reuse.md) for lifetime rules and automated/live verification.

These steps make real subscription requests and use your plan allowance. The automated test suite uses offline adapters and makes no inference requests. Report provider, adapter version, chosen model/reasoning and visible errors when reporting a failure.

Verify that no new LearnHarness replay chats appear in the Codex sidebar. Codex rounds require confirmed ephemeral native threads; the lesson remains saved in LearnHarness. Older replay chats created before this fix can be archived in Codex.

The [review register](review-2026-10-25.md) records nine ACP-related fixes and four separate repository findings that remain open. Passing this exercise does not close those independent concurrency/updater findings.

## Optional local settings

| Variable | Purpose |
|---|---|
| `LH_PORT` | Port; defaults to `3005` for `npm run app`, `3000` for `desktop:dev`. |
| `LH_APP_PROFILE` | Another absolute profile directory. |
| `LH_ACP_HOST_CONFIG` | Another host-owned JSON file with adapter executable paths/argument arrays. |
| `LH_IGNORE_ENV_KEYS` | The local launcher defaults to `1`; set `0` to restore inherited API-key environment behavior. Explicit API keys saved in Settings still work. |

For another port in PowerShell:

```powershell
$env:LH_PORT = '3006'
npm run app
```
