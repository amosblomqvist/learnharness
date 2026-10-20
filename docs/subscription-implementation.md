# Instance Codex subscription implementation

Implementation record for [issue 8](https://github.com/gzy31007/learnharness/issues/8).
The implementation was authorized after review of the
[implementation plan](subscription-implementation-plan.md).
Historical automated verification and browser-only acceptance are recorded below.
The final section records user-reported Windows desktop and same-instance browser
acceptance of the identified installer. Earlier pending statements describe their
own checkpoints. No result establishes supplier permission, a clean security
audit, or every possible real-world model and deployment workflow.

## Implemented boundaries

- Each data root has an independent, versioned subscription credential store.
  The API-key file remains separate. No credentials are imported from another
  application. OAuth credentials remain server-side, in owner-restricted
  plaintext files; browser DTOs contain no access or refresh tokens.
- Browser PKCE uses the fixed loopback listener and a state-checked full callback
  URL fallback. Device-code authorization is a separate flow. Attempts have
  identities, expiry, ownership and cancellation. Account replacement requires
  local disconnect first.
- A cross-process store transaction serializes refresh, credential persistence,
  tombstones and final send admission. A separate durable refresh journal
  quarantines uncertain rotation or persistence outcomes across restart.
  Final generation validation and invoking the underlying fetch occur under
  the same lock, but awaiting response/SSE does not hold that lock.
- Generation provenance follows turns, jobs, extraction and compaction. An old
  callback, queued job or engine cannot silently acquire a later account.
  Disconnect blocks future sends and best-effort aborts local in-flight work;
  it does not claim provider-side revocation.
- The legacy `openai-codex` source is explicit. Catalog visibility is not account
  entitlement. Model pins survive disconnected status. Structured failure
  classification never selects an API-key provider, changes the model, retries
  the whole task or falls back to paid billing.
- Subscription settings and protected HTTP routes are separate from API-key
  settings. UI authorization gates resolve the CONVERSATION's own provider
  (per-chat override over the strong slot), not the global strong pin, and
  treat provider keys and the subscription as independent sources with no
  cross-source fallback. A pending first subscription read blocks creation
  rather than creating an orphan draft; a connected status retained through
  a refresh does not block. Deployment boundaries, storage recovery and proxy
  configuration are described in [the deployment notes](subscription-deployment.md).

## Usage and Estimated model cost

Captured usage keeps the actual provider/model and each reported token field.
A field-presence marker distinguishes provider-reported zero from SDK-initialized
zero. Missing fields remain absent through teacher, subagent, extraction and
compaction capture. SDK fresh input is converted to total input once; pricing
subtracts cached input and cache writes once.

Dollar figures are read-time **Estimated model cost**, not a subscription bill,
remaining quota or reset prediction. Aggregation keeps known subtotals and
marks missing calls/stages as partial; entirely unknown figures render absent.
An explicitly reported complete zero remains zero. If the price table bills
cache writes but the supplier does not report their count, that call's estimate
is unknown; reported tokens are still retained. This conservative rule can make
real Codex estimates absent with the current catalog even when input and output
counts are available.

Existing learning records are not rewritten. Older captures can contain SDK
fresh input despite the existing contract naming that field total input; those
records cannot be distinguished reliably without additional historical
provenance. Their estimates may remain understated. The new capture path fixes
future records, not that historical ambiguity.

## Verification record, 2026-10-19

The final isolated gate ran 1,868 tests with 1,868 passing, zero failures and
zero skipped tests. It excluded `tests/read-tool.test.ts`: an earlier run showed
that its home-relative fixture tries to write outside the workspace and fails
with `EACCES` under this session's sandbox. This is not a claim that the
unmodified full test command passed.

`npm run typecheck` and `npm run build` passed. ESLint passed with `.scratch/**`
and `.drafts/**` excluded. Unqualified `npm run lint` also traverses the existing
research checkout under `.scratch` and fails on ten third-party
`@next/next/no-assign-module-variable` violations; those files were not changed.
The production build still reports dynamic-filesystem tracing warnings in
existing headless/PDF code. Electron packaging was not tested.

Final gate logs are local artifacts in
`.scratch/issue8-closed-gates-QMplS5/`. The independently rerun store/race subset
passed 30 tests using real temporary files and child processes. Independent
Standards and Spec reviews were followed by bounded rechecks of the fixes.
They are static reviews, not real-account acceptance.

A production-build Next server was started only on loopback with an empty,
isolated data root. In the actual browser, opening Settings > Subscription and
refreshing displayed `NOT CONNECTED`. The status request returned HTTP 200 with
`Cache-Control: no-store`; a same-origin disconnect returned 200; an invalid
guard returned 403. No sign-in button was activated. The temporary server was
stopped afterward. The local screenshot is
`.scratch/issue8-ui-3rh3PJ/after-loopback-fix.png`.

This check found and fixed Next's loopback hostname normalization mismatch.
A further independent review found a public HTTPS/internal HTTP default-port
collision. Its regression test first failed with 403 instead of 200, then the
full HTTP subset passed 28 tests after the fix. Proxy origin is an explicit
startup configuration, `LH_SUBSCRIPTION_ORIGIN`; forwarded headers do not grant
trust. A real remote HTTPS proxy was not deployed or tested.

## Acceptance boundary

Automated tests use temporary data roots and synthetic credentials, controlled
network responses, the actual pinned pi SDK, real files and child processes.
Business orchestration tests use the separate faux-engine seam and are not
presented as OAuth proof. At the automated verification stage, no real provider
login, refresh, inference, quota exhaustion or other application's credentials
were used.

### Real browser login-only acceptance, 2026-10-19

The user separately authorized sign-in, status inspection, restart recovery and
local disconnect, but not inference. A production Next server ran on loopback
with a fresh, private, git-ignored data root. pi-ai and pi-agent-core remained at
1.0.2. No credentials from another application were read or imported.

The initial automated-browser attempt expired after the user reported that
Google rejected that browser as unsafe. The user then completed browser PKCE
sign-in in their normal Edge browser. At 14:43:00 UTC the same instance's
sanitized status endpoint returned HTTP 200 and `connected`. The settings and
empty session-list response hashes still matched the pre-login baseline.

The service process was stopped and restarted with the same data root and
loopback origin. At 14:43:40 UTC its status again returned HTTP 200 and
`connected`, with the settings and session-list hashes unchanged. The user
also confirmed that refreshing Edge still showed Connected.

The user clicked Disconnect and confirmed that Edge showed Not connected.
At 14:58:01 UTC an independent sanitized status request returned HTTP 200 and
`disconnected`, without an account or active attempt. The session-list hash
remained unchanged. The model-settings hash had changed since the empty
baseline; the user explicitly confirmed manually selecting the strong, cheap
and vision models during acceptance. Those selected pins were present after
disconnect. This is not a claim that all settings hashes remained identical,
nor a test of preservation of pre-existing nonempty learning records.

No model request was initiated during this acceptance. Device-code support for
this account, refresh rotation and real inference were not tested. No credential
file contents, callback URLs, authorization codes or tokens were read or
recorded. Non-secret observations are retained privately in the git-ignored
acceptance data directory. The temporary service was stopped after disconnect.
Local disconnect is not provider-side revocation.

The Electron runtime was unavailable and was not installed. Real desktop
sign-in and desktop/browser shared-state acceptance remain untested. A minimal
explicit subscription-model call still requires separate authorization.
Phone/cloud real-device acceptance is deferred, not removed from implementation
scope. Windows ACL behavior and Electron packaging are not established by Linux
unit tests. Issue 8 must remain open until the required real acceptance exists.

### Composer authorization repair before real inference

The user reported that a selected subscription model was blocked by "Add a
provider key". Composer access now checks the selected provider's own source,
including a conversation model override instead of only the global strong pin.
Subscription authorization does not unlock API-key providers, and API keys do
not unlock subscription models. Disconnected subscriptions open Subscription
settings. An initial pending status blocks draft creation without claiming that
an API key is missing. Subscription changes and focus return refresh the live
status; stale reads cannot restore Connected after local disconnect.

Regressions were observed failing before the corresponding fixes, including
premature draft creation, both directions of conversation-provider overrides,
and a delayed focus read overwriting a completed disconnect. The final focused
suite passed 64 tests. Type checking, source lint excluding research/draft
copies, and production build each exited 0. Independent static review closed
the three follow-up findings; it did not independently execute these checks.

The rebuilt loopback browser showed Connect subscription for the disconnected
selected Codex model. Clicking it opened Subscription settings, not the API-key
setup. A guarded status read returned HTTP 200 and disconnected. No real model
request had been sent at this checkpoint. Real inference awaits the user's
fresh sign-in in normal Edge; its report must distinguish a single application
engine request from the potentially multi-request chat/prober/tool workflow.

### First authorized real inference attempt, 2026-10-20 Asia/Shanghai

The user completed a fresh sign-in in normal Edge and reported Connected. At
2026-10-19T16:26:02Z the same instance's sanitized status returned HTTP 200 and
connected, with strong explicitly pinned to `openai-codex:gpt-6-luna`.

An operator-invoked private probe used the real application's scoped subscription
engine and current strong pin, without a chat agent, tools or background work.
It allowed at most one model fetch and one refresh fetch, disallowed redirects
and fallback, and applied one 60-second engine/network deadline. This was not
a hard deadline for preliminary storage checks, nor full chat acceptance.

The attempt ran from 16:26:18Z to 16:26:28Z. It invoked the underlying model fetch
once with wire model `gpt-6-luna`, performed zero refresh requests, and returned
`subscription_network`. No HTTP response status, model reply or usage was
obtained. A fetch invocation does not prove that the supplier received the
request. Every token field and Estimated model cost remained unknown, not zero.
The process exited 1. It did not retry, switch model/provider or use an API key.
No credentials or arbitrary supplier diagnostics were read or recorded manually.
The sanitized report is retained privately under the git-ignored acceptance root.

At 16:27:43Z the same browser instance remained connected. Its new-session
composer showed `gpt-6-luna`, without either an Add a provider key pill or a
subscription-blocking pill. Thus the reported UI obstruction is repaired, but
real inference has not passed. The error alone cannot establish an account,
model-entitlement or quota failure, or locate the network failure. Further
network diagnosis or another real request is a separate next step; no automatic
retry was started. Desktop and full chat/tool-loop acceptance remain outstanding.

### User-reported Windows acceptance, 2026-10-20

The owner completed the human-only checklist for commit
`6c2b0b57f7d3177a777acab081411db539362416`, using the unsigned Windows x64
acceptance installer with SHA-256
`803d75472238f95f239f535f74a9fdb76b012ba862dbcb6e9952210ecbeb5b20`.
The [manual build](https://github.com/gzy31007/learnharness/actions/runs/39394818664)
and [handoff record](subscription-windows-acceptance.md)
identify the artifact. Actual package inspection confirmed Next 16.3.8,
sharp 0.35.5, root `lhTestBuild: true`, and selected AMD64 binaries. Windows OS
version was not supplied. These are owner-reported UI results, not an independent
agent reproduction, packet trace or inspection of Windows data files.

- Installation and startup passed.
- Cancelling authorization behaved normally. Starting browser sign-in did not
  automatically launch a browser window, but `Open the sign-in page` completed
  the path. Source inspection shows that starting only creates the attempt and
  the subsequent link opens the supplier page. Record this as a non-blocking
  usability observation, not automatic-launch success or a new repair.
- The desktop model was reported as `gpt-6-luna low` and worked normally.
  The same-machine browser behaved identically and shared the desktop state.
  The report does not include a verbatim model answer, token counts or prices;
  none are inferred.
- Restart recovery passed. The owner observed a changed port. This is consistent
  with the shell allocating a free loopback port per launch, not lost data.
- Disconnecting the network returned the expected error. Recovery and manual
  retry behaved as the checklist described. This bounded observation does not
  independently prove every possible retry or fallback path.
- Subscription disconnect behaved as expected, with data fully retained per the
  owner's report. The checklist's post-disconnect and restart behavior was
  accepted by the owner; no filesystem-level retention audit was performed.
- No update-menu entry was available. Runtime manual-update observation is
  **not tested**, not passed. Existing isolated updater guards and actual packaged
  acceptance metadata remain the separate evidence for the disabled policy.
- The owner reported no failing step or sanitized error.

#### Reconciled automated evidence and closure scope

The security-patched frozen source previously passed all 1,925 tests in 139 files,
with no failures, skips or exclusions, plus type generation, type checking, lint
and production build. This turn read the existing results; it did not rerun them.
The [issue discussion](https://github.com/gzy31007/learnharness/issues/8)
records the frozen validation and gate results. Raw validation logs remain local
acceptance evidence and are not included in the source commit.
The test log covers controlled browser/manual callback and device flows,
real-SDK lifecycle and single-send error classification, late results after
cancel/disconnect, durable journal and subprocess races, independent stores,
source-aware catalog and role gates, background/extraction provenance, API-key
regressions, protected HTTP and usage/cost handling. Faux-engine orchestration
results remain distinct from actual-SDK controlled-network contracts.
The issue discussion also records the previous fixed-base review, the approved
repair and closure of both blocking findings. The two
previously accepted P3 observations remain non-blocking and were not repaired.

With the owner's successful minimum real-client report, the required desktop and
same-instance browser acceptance is complete for this installer. This supports
closing issue 8 within its agreed minimum real-acceptance scope. It does not
assert real refresh rotation/expiry/quota exhaustion, account device-code
availability, manual-callback use on the owner's machine, a real API-key call,
every model-generation role, or a full learning/tool workflow. Those real-world
scenarios were not established by this report; their controlled automated
coverage must not be described as supplier or desktop execution.

Phone/cloud real testing remains explicitly deferred. Supplier permission is
unestablished. Remaining dependency findings stay with security map 10, unchanged
and not represented as fixed. No new execution, installation, credential access,
model request, dependency change, deployment, tag, Release or merge occurred in
this receipt-and-record turn. Branch publication and feature acceptance do not
imply that main already contains the implementation.
