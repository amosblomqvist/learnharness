# Codex engine

This fork adds a **Codex** engine alongside the existing API, ChatGPT subscription, and Claude Code connections. It uses the installed Codex CLI's [app-server protocol](https://developers.openai.com/codex/app-server) for ChatGPT sign-in, model discovery, and inference. It does not require an OpenAI API key or fall back to API billing.

## Set up

1. Install [Codex CLI](https://developers.openai.com/codex/cli) v0.163.0 or newer (`npm install -g @openai/codex`). The executable must be visible to the machine running LearnHarness. On Windows, use the native `codex.exe`; a `.cmd` launcher alone is not supported.
2. Run LearnHarness (`npm ci`, then `npm run dev`; or use its desktop host).
3. Open **Settings → Providers → External CLI**, enable **Codex**, and click **Sign in with Codex**. Open the sign-in link and complete ChatGPT authentication in your browser. LearnHarness polls until sign-in completes; you can cancel a pending attempt.
4. Select a **Codex** model in **Settings → Agent → Models → Strong** for new sessions, or in an existing session's model picker. Cheap/Vision slots and individual background roles can also select Codex models. Enabling the connection allows these explicitly selected tasks to use it.

The model list is Codex's reported catalog, not proof of access or quota. A real completed turn verifies the selected model for that request. Model rejection, rate limits, expired authentication, and CLI failures surface as errors without rerouting to another engine.

## Local credentials and controls

Codex manages its credentials in a dedicated `codex-profile/` beside LearnHarness's auth file (`LH_AUTH_FILE`, or the repository's `auth.json` during development). The directory is created private, ignored by Git, excluded from standalone traces, and rejected by the desktop packaging guard. Tokens never cross the HTTP status API or enter LearnHarness settings.

Your normal Codex CLI profile and login are separate. **Disable** stops active Codex processes and hides the model catalog while retaining this app's login. **Sign out** removes this app's Codex authentication. **Check again** refreshes installation/account/catalog state. The browser sign-in callback runs on the machine hosting LearnHarness, so remote/headless browser authentication is not supported by this integration.

As with the existing key and subscription routes, same-origin checks are browser-intent protections, not an authentication boundary for a public shared server. Run locally or supply your own server access control.

## Engine behavior and limits

LearnHarness owns its prompts, durable history, tool execution, question/answer boundaries, and background jobs. Each model operation starts an isolated, ephemeral Codex thread and replays the current transcript, including tool results and images. Actual Codex dynamic-tool requests are returned to the native Pi agent loop; speculative tool intents are never executed. Calls run serially through this bridge. It does not reuse a live Codex conversation between operations, so long transcripts can incur extra startup/replay overhead.

Native shell, patch, web search, apps, and multi-agent features are disabled in the child configuration. Unsupported native actions fail the operation. Learning tools remain subject to LearnHarness's existing execution and file-access policies. Ambient OpenAI/Codex credentials and route overrides are removed from child environments; Codex is pinned to managed ChatGPT authentication.

Dollar costs, context capacity, and output capacity are unknown for this route and displayed accordingly. Usage is recorded when app-server reports it; a tool handoff can end before final usage arrives. Zero-valued internal Pi placeholders are not a price estimate. The adapter uses experimental dynamic-tool APIs, so incompatible CLI changes may require an update.

## Validation

`NODE_ENV=test node --import tsx --test tests/codex.test.ts` exercises fake stdio processes, sign-in state, cancellation, catalog publication, prompt/schema/image replay, the native Agent tool loop, failed turns, and refusal of native actions. It makes no real sign-in or model request.

`node --import tsx scripts/smoke-codex-protocol.mjs` checks an installed CLI's initialize/account/catalog/thread-start protocol with a temporary unsigned profile. It never sends `turn/start`. Browser sign-in, real model entitlement, and model-authored lesson quality require separate live acceptance.

Initial validation on 2026-11-08 with Codex CLI 0.163.0: all 19 Codex tests passed; typecheck, lint (one existing warning), production build, and offline standalone provider/runtime gates passed. The full suite reported 3,562 passed, 2 skipped, and 2 failures in existing Claude CLI discovery tests. Those same two failures reproduced on an untouched upstream checkout at `713377f366771e3e4730e6acd1bc290e0ebc6d6e`. In the browser, enabling Codex, starting its real browser-login flow, and cancelling back to Signed out were verified. This initial pass used no signed-in account or real inference.

Live browser acceptance on 2026-11-08 used an already-connected Codex account and `gpt-6-luna` in the isolated local preview. A synthetic derivative micro-lesson completed diagnostics, the prober-to-teacher handoff, plan confirmation, prediction/check questions, a transfer check at a different input, and a final recap. The saved record contains 14 application turns and 18 model responses, all under the Codex provider, with no terminal errors or unresolved tool calls. A pending question survived reload and was answered successfully; the completed recap also reloaded from saved history. One rejected quiz payload was corrected by the model on its next attempt. One distractor contained an unmatched LaTeX delimiter that displayed as a stray `$`; this is an output-quality limitation. No external file, web, image/PDF, or background graph-extraction workflow was exercised. This single session establishes the tested flow, not general pedagogical quality, latency, quota, or billing guarantees.
