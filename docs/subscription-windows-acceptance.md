# Issue 8: Windows human acceptance handoff

Recorded 2026-10-20, Asia/Shanghai. This archives the original manual acceptance
handoff and the owner's later results. The handoff alone did not establish a
passed desktop test. The final section records acceptance and issue closure.
Neither establishes a clean security audit.

## Scope and decision

The owner requested delivery of the existing latest Windows build without further remediation of remaining dependency findings and without inspecting an existing Windows installation. This supersedes the installation pause in the earlier artifact report for the **new Next 16.3.8 artifact only**. Do not deliver the earlier Next 16.3.2 installer.

At the original handoff, issue 8 was open, assigned to `gzy31007`, with `ready-for-human`. The remaining work then was human desktop testing plus external account authorization. The agent cannot certify the owner's Windows session, provider sign-in or actual subscription entitlement. The owner performs those steps and returns results. No existing Windows installation or user data was inspected, installed over, migrated, imported or deleted by the agent.

The [issue discussion](https://github.com/gzy31007/learnharness/issues/8)
records the earlier native-package inspection, security stop and limited Next
repair. The original detailed reports remain local acceptance evidence and are
not included in the source commit. Neither is evidence of Windows desktop
acceptance. No new external research was necessary to identify the approved build.

## Build identity

- Commit: `6c2b0b57f7d3177a777acab081411db539362416`.
- Branch: `acceptance/issue8-windows-20261020`.
- [Successful manual build](https://github.com/gzy31007/learnharness/actions/runs/39394818664).
- [Windows artifact](https://github.com/gzy31007/learnharness/actions/runs/39394818664/artifacts/12251417609), `learnharness-windows-x64`, expires 2026-10-27 16:43:25 Asia/Shanghai.
- Installer `LearnHarness-0.3.0-x64-setup-acceptance.exe`: 166,807,774 bytes, SHA-256 `803d75472238f95f239f535f74a9fdb76b012ba862dbcb6e9952210ecbeb5b20`. Unsigned per-user NSIS acceptance package, not a formal Release.
- Completed static checks: the archive SHA-256 `80bc118a4069daad42f10998a1fe54936ec8457b4e2a50cbbba7f33302b220fb` matches GitHub's digest; actual standalone Next is `16.3.8`, sharp is `0.35.5`; root `lhTestBuild` is boolean true. The two packaged shell sources match the commit after CRLF-to-LF normalization only. The executable and selected canvas/resvg native addons have AMD64 PE headers. No application or bundled server was executed.
- Acceptance packaging disables automatic updater activity through root `lhTestBuild: true`. This does not isolate installation identity or data from an older installation: the app ID and normal user-data directory are unchanged.
- Static inspection evidence and installer digest are recorded in the local collector's `provenance.json` and `inspection.json`, with exit 0. They are not committed artifacts. These are static checks only; the collector does not run a Windows executable or bundled server.

## Human-only checklist

Each step is reported as PASS, FAIL or NOT TESTED. Stop at a failure and return the step name plus the visible error, without secrets. Normal minimal model requests may consume subscription quota. No password, token, device authorization secret, complete callback URL or authorization file is needed in the report.

1. **Install and launch.** Close LearnHarness windows you have open, then run the downloaded acceptance installer and launch the app. Expect the home screen rather than a blank page or startup error. Record Windows version and any visible installer/startup error. The unsigned package may trigger Windows or organization policy; if blocked, report the message instead of disabling protection. No uninstall, data cleanup or migration is required by this checklist. Installing may replace the same application's existing installation.
2. **Cancel an authorization attempt, then sign in.** Open Settings > Subscription (or localized equivalent). If disconnected, start `Sign in with browser`, cancel in the application before approving at the provider, and verify it does not become connected. Then start a fresh attempt and finish provider sign-in yourself. If already connected, record the initial state and defer the cancel check until after step 7; do not claim a fresh sign-in was tested. Expect Connected and an account identity when the provider supplies one. A cancelled attempt must not later restore authorization. Use any complete callback URL only inside the application's designated field, never in the report.
3. **Explicit subscription request in desktop.** Record current model choices. Explicitly select the `openai-codex` subscription source and a model available to your account for the active chat/teacher role; do not change API keys to make this pass. Send one minimal prompt asking for `OK` only. Expect a completed answer, no API-key requirement, no silent source/model switch, and usage when available. Any displayed amount is an estimated model cost, not the subscription bill. Directory presence alone is not entitlement. If unavailable, report the exact model and error; do not silently substitute.
4. **Same-instance browser.** While the desktop app stays open, obtain its current `http://127.0.0.1:<port>` origin from the latest `server up:` line in `%APPDATA%\LearnHarness\logs\main.log`. Read only that address; do not send the whole log. Open it in the browser on the same Windows machine. This is not the WSL development URL. Expect the same learning session and subscription state without a second provider login. Send one further minimal `OK` request from the browser and verify completion with the explicitly selected subscription model.
5. **Restart persistence.** Fully quit the desktop app, then reopen it. Expect the saved session, subscription state and model selections to remain. Its port may change: reopen the current origin from the new log entry rather than reusing an old tab. Verify the same-instance browser agrees. Do not interpret Connected alone as proof of fresh provider entitlement or long-term refresh behavior.
6. **Recover from a short network failure.** With subscription explicitly selected, temporarily disconnect Windows networking and attempt one minimal message. Expect a visible network failure rather than success or silent switch to a paid API. Reconnect networking; wait briefly and verify the failed task does not replay by itself, then retry manually once if needed. This is a bounded UI observation, not proof of every retry or concurrency path. If the failure cannot be reproduced without disrupting important work, report NOT TESTED.
7. **Disconnect and preserve data.** In Settings > Subscription choose Disconnect and confirm. Refresh the same-instance browser; both must become disconnected. Attempt one message with the subscription selection unchanged: expect a sign-in requirement and no new model answer or source switch. Learning data, ordinary API-key configuration and model choices must remain. Quit and reopen once more; disconnected must persist. If step 2 began already connected, perform its start-and-cancel check now and verify disconnected remains. Local disconnect is not provider-side revocation; already issued requests may consume quota.
8. **Updater check.** If accessible in the app menu, select Check for Updates. Expect an acceptance-build disabled result rather than an update download or restart prompt. Report NOT TESTED if unavailable. Do not install an update during this acceptance run.

## Boundaries and remaining evidence

This is the minimum real Windows desktop/same-instance-browser acceptance, not a demand that the owner execute the entire automated behavior matrix manually. Automated evidence still needs to be reconciled against issue 8's full matrix before closure. Quota exhaustion, expiry, refresh races and malformed authorization are isolated-test scenarios; do not deliberately exhaust quota or edit authorization files. Device-code availability, manual callback fallback and ordinary API-key execution must not be marked passed unless actually exercised by an appropriate test; report untested coverage accurately. Other model-generation roles and full learning workflows are not proved by the minimal OK exchange.

Phone/cloud real tests remain deferred; no remote deployment, exposed listener, credential migration, additional dependency remediation, sibling-issue implementation, data deletion or formal release is included. The package is not represented as security-clean or provider-approved.

## Result template

Build: `6c2b0b5` / Windows version: ...

- Install/start: PASS | FAIL | NOT TESTED
- Cancel / fresh sign-in: ...
- Desktop explicit subscription model / answer: ...
- Same-instance browser model / answer: ...
- Restart persistence: ...
- Offline failure / manual recovery: ...
- Disconnect / data preservation / disconnected after restart: ...
- Updater disabled: ...
- Failed step + sanitized visible error: ...

## Acceptance received, 2026-10-20

The owner returned results for this installer. Installation/startup, authorization cancellation, desktop `gpt-6-luna low`, same-instance browser/state synchronization, restart, offline error/manual recovery, retained data and subscription disconnect all behaved as expected. No failing step was reported. Browser sign-in required clicking `Open the sign-in page`; automatic opening was not observed. The current start action only creates an attempt and then renders that link, so this is a non-blocking usability observation rather than a failed authorization path. The owner observed port changes after restart, consistent with dynamic loopback allocation.

No update-menu entry existed, so the manual updater check is **not tested**. Do not rewrite it as runtime updater verification. Actual packaged `lhTestBuild: true` plus existing isolated updater guards remain the separate disabled-policy evidence. The owner did not provide Windows OS version, a verbatim response, token counts or cost figures; none are invented.

The agent reconciled these owner-reported minimum real-client results with the frozen security-patched validation and fixed-base re-review. The previously recorded 1,925 tests, typegen/typecheck/lint/build and closed blocking findings were reviewed, not rerun. Automated lifecycle, SDK, race, source/role, HTTP and cost coverage is separate from real supplier behavior. See [implementation acceptance record](subscription-implementation.md).

The required minimum desktop/same-instance-browser acceptance is complete for this installer and supports closure of issue 8 in that agreed scope. Parent map 1 stays open for its other work. No automatic-browser-launch repair, new model request, data-file inspection, remote test, security remediation, merge or release is part of this receipt turn. Phone/cloud real tests remain deferred. Existing P3 findings and security map 10 are unchanged.
