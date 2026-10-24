# Codex subscription access

Open Settings → Connections → Connect Codex. Open the sign-in link in your browser and follow the flow offered by the pinned Pi SDK. It supports browser callback, manual callback input and device-code login where available. After connecting, explicitly choose a Codex subscription model for the strong, cheap and vision slots. Nothing selects a model or signs in automatically.

The same model engine serves teaching, practice, background jobs, graph extraction and compaction. Subscription credentials are separate from API keys. A missing, expired or rejected subscription does not switch to paid API access. Refresh is handled by the pinned SDK using the app-owned credential store.

Disconnect removes the local credential without deleting learning records, API keys or model selections. It does not revoke access on the provider side; an already admitted request may finish. Closing Connections cancels a pending login on a best-effort basis; abandoned attempts expire after ten minutes.

Credentials live in `data/connections/provider-credentials.json` (or the corresponding `LH_DATA_DIR`), with atomic replacement and a shared filesystem lock. Credentials are plaintext with POSIX file permissions, not an OS keychain. Protect the data directory with Windows ACLs. Credentials from Codex, Pi or other applications are never imported.

Connection-management routes require loopback hostnames and reject cross-site browser mutations. These checks are not user authentication and do not secure the application's older routes. Do not expose the server publicly.

The pinned SDK labels this Codex route legacy. Its availability and account entitlement depend on the provider; an SDK adapter does not establish provider approval for a third-party client. Official Codex authentication reference: https://learn.chatgpt.com/docs/auth . Automated fixtures cannot establish real-account login or real refresh-token rotation. Real-account checks are recorded below separately from automated fixtures.

## Attribution

The connection service, credential store, route guards, subscription UI and related tests are adapted from 0xCUB3's PR #13, commit `75842fe8a6d3ef5480de5e134b7730fd6b876dcb`: https://github.com/amosblomqvist/learnharness/pull/13 . This branch narrows that work to Codex; Claude, Grok and custom endpoints are excluded. Original author: 0xCUB3 <skula@mit.edu>. The original author is credited in this document and the adaptation's commit trailer.

## Verification (2026-10-24, Windows / Node 24)

TypeScript, ESLint and the production build passed. The standalone output contains the Codex OAuth adapter, browser callback, device-code, PKCE and callback-page modules.

The nine focused connection test files pass 75 tests; one POSIX file-symlink test is skipped on Windows because it needs developer mode or elevated symlink privileges. A separate Windows directory-junction refusal test passes. Native Codex HTTP requests, tool calls, continuation with signed reasoning, provider rejection, disconnect, refresh races and React connection controls use synthetic credentials and stubbed transport. No real account or live model call was used in those automated tests.

The full suite reports 1,965 passed, 9 failed and 1 skipped (1,975 tests). All nine failures were reproduced against a separate unmodified main snapshot with the same installed dependencies: auth-store POSIX permissions, data-dir-seam Windows path handling, schema-stamps legacy fixture check, and six verify-release CLI cases. They are not resolved by this feature.

The contributor reported successful real-account sign-in and lesson generation in the local development browser, then confirmed persistence after restarting the development server and disconnect behavior. These are contributor-reported manual results, separate from automated fixtures. A packaged desktop installer, real refresh-token rotation, device-code login, quota exhaustion and every background role were not manually verified.

Compared with the source PR, this branch fixes Windows lock contention (EPERM for an existing lock directory) and preserves native Codex reasoning/tool identities when replaying subscription-labelled history.
