# Instance-owned legacy Codex authorization: implementation plan

Planning deliverable for [issue #8](https://github.com/gzy31007/learnharness/issues/8), under [map #1](https://github.com/gzy31007/learnharness/issues/1). Date: 2026-10-19, Asia/Shanghai. Source baseline: `32febaaae7fea9fdf8ea59fe62d345d37298d399`; pi-ai and pi-agent-core remain `1.0.2`.

## Archived planning checkpoint

This is the approved 2026-10-19 planning snapshot, archived without changing its
historical authorization boundary. Implementation and acceptance subsequently
completed. See the [implementation record](subscription-implementation.md) and
[Windows acceptance record](subscription-windows-acceptance.md) for later results.
References to a planning-only round below are historical, not current task state.

## Authorization and delivery boundary

The user explicitly selected **planning only** for this round. This document proposes implementation; it does not report implemented behavior. No product edits, product tests, dependency installation/upgrade, credential access, sign-in, inference, or deployment are authorized by this planning round. Existing unrelated working-tree changes must remain untouched. Issue #8 stays open.

Preserve the approved decisions: provider `openai-codex`, legacy `https://chatgpt.com/backend-api/codex/responses`, one independently authorized subscription per LearnHarness instance, explicit source/model selection, existing API keys, all compatible model uses, no source/model fallback, no task replay after failure, and Estimated model cost. Do not replace this with SIWC, the public Responses API, another tool's credentials, Claude subscription, or a whole CLI agent.

The exact-version research recorded in the [issue discussion](https://github.com/gzy31007/learnharness/issues/8) separates SDK feasibility from supplier permission. Legacy use is not established as an approved third-party route. Keep that warning in settings and deployment notes; a successful future request would not establish permission.

Desktop and same-machine browser real acceptance require separate authorization during implementation. Phone-to-PC and self-hosted-cloud real acceptance are deferred, not their functionality or isolated tests. No subscription allowance, reset countdown, or actual bill is inferred.

## Current evidence and mandatory integration points

| Surface | Verified current behavior | Consequence |
| --- | --- | --- |
| `src/agent/models.ts:38-54,88-110` | Module-local `createModels()` with no credential options; every production engine uses its collection. | Inject a durable store and protected stream seam, without agent-to-store imports. |
| `src/server/keys.ts:202-205`; `src/core/auth-keys.ts:78-86` | Unknown plain-key providers pass `providerKeyPresent`; Codex has no key row. | Absence of an API-key mapping cannot mean subscription authorization. |
| `src/server/model-catalog.ts:119-136,165-195,209-249` | Picker and context limits use keyed providers; settings writes accept all built-in providers. | Unify structural validity, auth availability, capabilities, picker, and execution without deleting saved pins. |
| `src/store/auth.ts:22-46`; `src/core/ports.ts:203-221` | Flat string map, atomic rename, no cross-process lock; nonstrings are discarded. | Keep key storage unchanged; OAuth needs its own durable adapter. |
| `src/server/stores.ts:15-20` | Storage composition root; auth keys are separately wired today. | Compose authorization here, not inside agent modules. |
| `src/server/jobs.ts:47-55` | Recovery can re-spawn tasks; Next dev route modules may have separate module state. | A module-local Map is insufficient; background work needs session provenance and recovery checks. |
| `src/agent/subagents/visual-maker.ts:329`; `src/agent/subagents/pdf-reader.ts:407` | Each supplies `process.env.OPENROUTER_API_KEY` to every provider's stream. | Remove these unconditional overrides. Codex's OAuth-only resolver ignores API-key overrides today, but the wrong key is still passed and breaks the provider-neutral contract. |
| `src/server/chat-handler.ts:204-236,523-543` | Main preflight checks key presence; settle compaction has no corresponding gate. | Apply the same source/session rule to both compaction paths. |
| `src/core/prices.ts:639-647`; `src/core/cost-summary.ts:118-167` | Codex already has model prices; some mixed totals count only known parts without complete coverage metadata. | Preserve price lookup; propagate explicit estimate completeness to every aggregate. |

The published 1.0.2 source is available under `.scratch/wayfinder-pi-auth-20261019/.research-scratch/pi-auth/source/ai/`. Its `auth/types.ts:50-94` specifies serialized `CredentialStore.modify` and `delete`; returning `undefined` from `modify` means **no change**, not deletion. `auth/resolve.ts:102-161` refreshes within the store transaction, rechecks expiry, persists rotation, and uses a 15-second refresh timeout. `models.login` writes after the provider flow completes, so application-owned cancellation alone cannot prevent a late login write. `/oauth` is type-only; use public collection/provider auth APIs, not nonexistent runtime helpers.

Two additional exact-version constraints must be covered before UI implementation:

- `auth/oauth/openai-codex.ts:359-395` accepts manual input without a state when none is supplied. The application must require a complete expected callback URL and matching attempt state before answering that SDK prompt. Do not expose the SDK's raw-code shortcut as an application feature.
- `api/openai-codex-responses.ts:385-459` retries by default. Codex execution must explicitly use `maxRetries: 0` and a single SSE transport, avoiding WebSocket reconnect/SSE fallback as hidden additional inference attempts. Verify the public option shape against the installed 1.0.2 declarations before coding; no dependency upgrade is implied.

## Proposed module boundary

Keep OAuth secrets and persistence behind a server-owned **subscription authorization service**. Its app-facing operations are start, interact, status, cancel, disconnect, and acquire/release a request lease. Callers do not receive credentials, locks, refresh helpers, or raw SDK objects.

Proposed locations (names may adjust during implementation without expanding scope):

- `src/core/subscription.ts`: browser-safe DTOs, status/error codes, source metadata and pure classifiers/presentation contracts; re-export through `src/core/index.ts`.
- `src/store/subscription-credentials.ts`: versioned durable store, lock, strict validation, permissions, atomic writes, session fencing. Expose its port via `src/core/ports.ts`; the SDK adapter can structurally implement pi's credential interface in the legal composition layer.
- `src/server/subscription.ts`: lifecycle orchestration, attempt/prompt broker, request leases, safe errors and same-origin route guards.
- `src/server/stores.ts` plus a server engine factory: compose the durable service with `createModels({ credentials })` and inject collection/stream dependencies into `src/agent/models.ts`. All production engine callers resolve through this composition. Keep an explicit isolated factory for tests; do not add an import from agent to server/store or a second hidden production collection.
- `app/api/subscription/**`: thin transport using the server/core barrels. Route and UI files must follow the installed Next guide before implementation.
- `components/settings/subscription-section.tsx`: account state and actual login/cancel/disconnect events; connect to the existing settings surface and shared UI-language contract from #7.

Use one `globalThis` runtime registry per canonical instance data path inside a process, following the existing jobs precedent. This avoids route-entry duplication but **does not substitute for cross-process locking or durable state**. Instances with distinct data roots never share authorization, controllers, attempts, or credentials. Two servers deliberately using the same data root are competing owners of one instance, not independent installations.

## Durable state and concurrency protocol

### Storage

Add a dedicated server credential file under the instance `LH_DATA_DIR`, provisionally `subscription-auth.json`. Do not repurpose the existing `LH_AUTH_FILE` string map, scan home directories, read pi/DSH/Codex auth files, or copy a refresh token between instances. Tests redirect the data root before the first config import.

Persist a versioned envelope with an opaque authorization generation, optional validated Codex OAuth credential (`type`, `access`, `refresh`, finite expiry, nonempty `accountId`), and lifecycle information necessary to fence commits. Attempt/session identifiers contain no tokens. Generation survives logout as a tombstone so deletion cannot reset the fence. Single account only; connected state refuses a replacement login until disconnect completes.

Owner-only directory/file access (0700/0600 on POSIX); apply/test the platform-equivalent protection on supported desktop platforms and document inherited account ACL limitations. Plaintext-at-rest remains an explicitly accepted risk, not encryption. Reject symlinked targets and unsafe file types; validate schema/version and do not overwrite malformed/newer records with an empty map. Report unreadable/corrupt/store failures without treating them as a successful disconnect or connection. Atomic same-directory replacement, unique temporary file, durable write where supported, cleanup, and permission checks apply to every credential/tombstone update. No token-bearing backup or diagnostic files.

### Locking and refresh

All read-modify-write, delete and authorization commits use one cross-process lock for this store; reads requiring an authoritative request decision must observe the same serialization boundary. Hold the credential transaction through the SDK's refresh callback and persistence, then release. Re-read inside the lock: simultaneous expiry checks must produce one refresh and subsequent requests must use the rotated credential.

No new dependency is assumed. Implement a small cross-platform atomic lock-directory adapter with an owner nonce and local-process identity, bounded cancellable acquisition, and fail-closed contention. Do not reclaim an active owner's lock by age alone; do not let a paused old owner write after a takeover. A crash-stale lock may only be reclaimed with demonstrable owner death on the same host and ownership checks; uncertain ownership requires a documented stopped-service recovery, not blind unlink. Treat shared network filesystems/multi-host access to one data directory as unsupported. Characterize crash, PID-reuse ambiguity, and interrupted rename in tests before proceeding. If these guarantees cannot be achieved with the current dependencies, stop and request an explicit implementation/dependency decision rather than weakening the lock.

The file adapter rejects persistence failure; it must not silently return an in-memory success. Before invoking a callback that may rotate a remote refresh token, durably record a refresh-in-progress marker for that generation under the same lock; failure to save that marker means zero network. Keep this marker in an independent owner-only journal so credential replacement cannot erase it prematurely. Persist the rotated credential with its refresh-operation ID and verify file/directory durability before clearing the journal under the lock. If credential commit or its durability check fails, leave the journal even when rename already made the candidate visible. If the process crashes, the remote outcome is uncertain, or credential persistence fails, the marker remains: every process, including after restart, must block refresh/inference and present an uncertain/recovery-required state, not connected. Journal cleanup is permitted only after credential durability has succeeded; uncertainty during cleanup is a separate storage error and cannot expose the old refresh token as usable. The journal contains only nonsecret generation/operation identity, not another credential copy. A durable disconnect tombstone invalidates that generation before removing its journal; an interrupted cleanup cannot reactivate it. Clear an uncommitted marker automatically only when a characterized outcome proves no rotation occurred; otherwise use explicit stopped-service recovery or disconnect/re-authorization. Retain the old credential only as blocked data, never as permission to retry. This is not evidence that the account was revoked. A crash after remote rotation but before durable commit can require reauthorization; atomic local files cannot roll back the provider.

### Attempts, logout and request leases

Each attempt has an unpredictable ID, a captured generation, a fixed 15-minute maximum lifetime, a selected login method, a prompt ID, and an AbortController. Only one active attempt per instance. Persist nonsecret attempt identity, generation, owner process/boot identity and expiry under the store lock; start/cancel/expiry/final-commit arbitration updates that record under the same lock. An empty local Map in another process is not permission to start or expire an attempt. Browser refresh may rediscover sanitized state; ephemeral prompts/PKCE remain with the owning process. A nonowner rejects an interaction it cannot route safely, without creating a replacement or reporting success. Owner death/restart expires only that owner's attempt after the same ownership/death checks, not every attempt whenever another process starts. Document single-service-process authorization routing; arbitrary load-balanced multiworker prompt routing is not implied. Never resurrect PKCE material from disk.

Reuse `Models.login` with an **attempt-bound credential-store view** whose final `modify` checks the current durable generation and attempt under the lock before committing. A dedicated login collection may share the same provider factory but not an unguarded default store. Cancel, replacement attempt, disconnect and restart invalidate the old attempt; a late SDK completion cannot save. Merely checking `signal.aborted` before calling an unguarded `Models.login` is insufficient. Do not return `Models.login`'s credential to the route response.

A Codex execution acquires a lease bound to the current generation; combine its AbortSignal with request/job cancellation. Check at tool/continuation/recovery boundaries and after auth refresh. The final transport wrapper must acquire the same cross-process store lock, recheck generation, disconnect/fault state and cancellation, then invoke the one underlying fetch while still holding that lock. That invocation is the send linearization point. Capture its response promise without awaiting the network or SSE lifetime inside the lock; release only after invocation, then await/stream outside. A bare check followed by releasing the lock before calling fetch is invalid. Therefore disconnect either follows an already-issued send or precedes and rejects it. Keep controllers registered until stream completion; refresh responses may update only their original session, never a later account. Ordinary API-key requests do not acquire subscription leases.

Disconnect marks the local admission gate closing immediately, aborts attempts/leases best-effort, serializes deletion and generation advancement against refresh, clears sensitive runtime state, then returns success only after durable deletion. If refresh holds the lock, abort it and wait within a bounded operation; serialize its last write before deletion or reject it through the fence. Cross-process requests arriving before the durable disconnect linearization may already be in flight; after successful disconnect no new Codex send may pass the durable generation check. Other processes must validate durable state at every send; cross-process abort notification is best-effort and not a guarantee that an already issued request was recalled. Lock/persistence failure returns a safe failure and keeps admission blocked rather than claiming successful sign-out.

Retain model pins, keys and learning data. Disconnect is local only, not provider revocation. Explain that already-issued requests can still consume quota. Valid usage/results from an already-issued call may be recorded as historical output, but cannot restore credentials or trigger a new subscription call. Tag subscription work with nonsecret generation provenance, including queued jobs, extraction stages, wake markers and recovery. Old-session work must stop, not silently continue with a newly connected account. Existing automatic job recovery must suppress subscription task replay after an auth/network/model/limit failure or session change; user retry creates fresh work. Do not change unrelated API-key recovery behavior.

## Protected interaction API and UI

Proposed routes:

| Operation | Proposed transport | Rule |
| --- | --- | --- |
| Status | `GET /api/subscription` | Sanitized status, method, masked/minimal account identity, attempt/prompt identifiers and required short-lived interaction only; `Cache-Control: no-store`. No provider refresh/live ping merely to render status. |
| Start | `POST /api/subscription/attempts` | Explicit browser/device method, single attempt, reject connected state. Return 202 and safe attempt state. |
| Reply | `POST /api/subscription/attempts/:id/input` | Match current generation, attempt and single-use prompt; bounded body, expiry and state checks. |
| Cancel | `DELETE /api/subscription/attempts/:id` | Abort and invalidate; wrong/stale identifiers cannot cancel a newer attempt. |
| Disconnect | `DELETE /api/subscription` | Idempotent local deletion with the durable semantics above. |

All interaction/status responses are noncacheable. Mutations require exact allowed Origin/Host and a same-origin request token/custom-header guard; do not derive allowed origins from arbitrary forwarded headers or browser-controlled strings. Body validation and reasonable per-instance request limits apply. Secrets must never enter URL query parameters of these app routes, access logs, client telemetry, console logs, exception serialization, chat history, or learning records. Redact supplier error bodies before any existing `console.error` path. Prompt/attempt identifiers are not substitutes for remote service authentication.

Same-machine browser login: the SDK owns PKCE and its loopback listener at `localhost:1455/auth/callback`; maintain loopback-only binding even if `PI_OAUTH_CALLBACK_HOST` is externally set (use a narrowly scoped provider adapter if necessary, not process-wide env mutation). Do not open the listener on public interfaces. Display/open only allowlisted HTTPS supplier authorization links through the existing external-browser mechanism. Port conflict must produce clear manual/device alternatives, not a claim that a callback listener started.

Remote: explicitly offer device-code login and show the supplier verification URI and short-lived user code only in the protected authorization page. Do not expose `deviceAuthId`, code verifier or tokens. Cancellation, expiry and disabled-device-code responses remain failures. SDK polling is part of that explicit authorization attempt, not task retry.

Manual fallback is an explicit browser-flow attempt, not a continuation of a failed device exchange. Require the complete callback URL for the configured loopback origin/path, with exactly one nonempty code and state matching the current authorization URL; reject bare codes, missing/duplicate/mismatched state, stale prompts and cross-attempt replies before calling the SDK prompt resolver. Keep the input in ephemeral component memory only and clear after submit/cancel/unmount; no localStorage, IndexedDB, clipboard capture, form autocomplete or support transcript. Supplier-owned callback query handling must also avoid request logging.

UI states separate disconnected, authorizing, stored/connected, reconnect-required and storage/temporary error. A stored token means a saved session, not proof of entitlement or a successful live refresh. Show attempt cancellation, logout progress/failure, plaintext-file risk, local-only logout boundary, and legacy permission warning. Implement actual control events and test them. Preserve the #7 interface-language/learning-content separation without making its implementation a new blocking dependency. Keep supplier/model identifiers unchanged; application strings belong to the shared UI-language mechanism.

Remote deployment documentation must require VPN/SSH tunneling or authenticated HTTPS protection over the **entire service**, including API, streams, assets containing learning data and credential operations. No built-in registration/multiuser system and no public unauthenticated mode. Keep Electron's default loopback binding and guards. `electron/main.cjs:47-48` already separates userData auth and data paths; use the data-path seam rather than putting credentials in the app bundle. Desktop and browser share a subscription only when they actually connect to the same server/data root.

## Source-aware selection and complete execution coverage

Provider coordinates continue to identify source: `openai-codex` means this instance's subscription; `openai` and other existing providers retain their ordinary key behavior. Do not add a global `hasKey || hasSubscription` switch. Do not place subscription tokens into process.env or the flat key map.

Introduce a shared provider-authorization descriptor consumed by the catalog, preflight and engine composition. API-key rows remain compatible; Codex gets explicit subscription availability rather than a fictitious env-var name. Picker entries can expose known Codex candidates with availability/required-login state; existing disconnected pins remain visible and unchanged. Structural settings writes validate provider/model/capability, not a live account grant. Preflight/send requires the selected source's authorization. This intentional distinction lets a saved model survive disconnect while remaining unusable until reauthorized.

Use pi's actual `input` capabilities for vision choices and execution validation, retaining text-compatible choices for other slots and role overrides. Do not claim static catalog membership proves account entitlement. Context-window lookup must include the chosen Codex model consistently with picker metadata without pretending its account is entitled. Reject unavailable/unknown models; never substitute a nearby model. Preserve thinking-level clamp semantics and role override → slot/conversation precedence.

Maintain this implementation checklist and add every newly discovered generation entry before completion:

| Current model use | Highest relevant boundary | Required coverage |
| --- | --- | --- |
| Probe/teacher and conversational practice | `src/server/chat-handler.ts:187-219`, `src/agent/teacher-agent.ts` | Source-specific refusal, selected engine, tool/continuation generation checks, usage stamps. |
| Research/demo/visual/PDF jobs | `src/server/chat-handler.ts:79-91,132-135`; `src/agent/subagents/runner.ts:171-179,243-259` | Role/slot resolution, refusal, stream lease, status error, job usage; remove both OpenRouter overrides. |
| Extractor/auditor, chat and notes front doors | `src/agent/subagents/extraction.ts:779-806,997-1020,1099,1295` | Both stage engines, no paid alternate if either stage refuses; stage usage/partial failure and old-session checks. |
| Foreground and settle compaction | `src/server/chat-handler.ts:219-236,523-543`; `src/server/compaction.ts:60-87,230-252` | Own conversation model, guarded kick, no silent reauth/fallback, partial usage and safe diagnostic. |
| Background result wake and recovery | `src/server/jobs.ts` and chat handler | A result may persist, but cannot cause automatic failed-task replay or cross-generation learning calls. |
| Shared leaf stream seam | `src/agent/subagents/submit-agent.ts` and `src/agent/models.ts:88-110` | Last-send enforcement catches paths missed by route preflight; use real SDK auth. |

At this baseline, title creation (`src/core/contracts/graph.ts:363`) and graph naming (`src/core/graph.ts:558`) are deterministic, not model calls. Separate practice-set partition/generate/grade routes described in `docs/architecture.md` are absent from the inspected tree. Do not invent them to satisfy a stale document. Reconcile the entry inventory against the implementation checkout; if such features exist there, include their highest business entrances and grading/plan generation in the same rules. Any still-present deterministic path gets an explicit not-applicable entry rather than fake test coverage.

## Errors and SDK transport

Keep machine codes and UI interpretation aligned across preflight JSON, streamed chat errors, jobs and extraction. Use safe application codes for needs-login, subscription-limit, model-unavailable, network and unknown; storage/cancel states remain distinct lifecycle errors. A 401/403/429 alone is insufficient for a definitive supplier diagnosis. Recognized supplier code/body semantics plus operation context may justify classification; ambiguous failures stay unknown. Preserve a safe allowlist of status/code/request-ID and retry guidance, never arbitrary bodies/headers.

For Codex inference, use the public per-call `fetch` option to inspect a cloned non-OK response, normalize a bounded allowlisted diagnostic, and then return the original response to pi. Preserve SDK stream behavior; do not globally replace production fetch. Enforce SSE and `maxRetries: 0` after caller options so callers cannot re-enable retries or override subscription credentials. Derive the request generation from the job/turn lease, not from whichever account is latest at send time. Any caller-supplied apiKey/auth headers/base URL for Codex must be rejected or removed at the source boundary. Safe application diagnostics must survive pi's stringified errors and the current generic chat `onError`; never rely on brittle matching of friendly prose for certainty.

OAuth login/refresh uses internal fetch rather than that stream fetch option. Inspect `ModelsError.cause` and exact-version token-endpoint failures inside a narrow adapter; only a validated recognized machine error in a known response envelope establishes terminal invalidation. Do not expose raw SDK exception strings, which can contain provider response/token data. Unexpected response formats stay unknown. Use isolated-process network substitution for automated OAuth contracts, never a global production monkeypatch.

On confirmed invalid refresh, invalidate only the original session/generation and require reconnect. Definite nonrotating network failures preserve durable credentials for explicit retry; an uncertain refresh outcome follows the durable quarantine protocol above, without falsely claiming revocation. No automatic task restart, source change, paid-key fallback or model change. A request rejected by the subscription path must make zero requests to the other configured providers even when valid API keys exist.

## Usage and Estimated model cost

Continue stamping actual `provider:model`, preserving each obtained token field and computing model-equivalent dollars at read time from `PRICES`. Existing Codex price rows remain included. Do not persist supplier bills, invent allowances, or set subscription calls to zero.

Audit `src/core/prices.ts`, `src/core/cost-summary.ts`, observability aggregation, per-message/turn/job displays, stats bars, graph cost panels, model price tooltips and mixed-source totals. All dollar labels/tooltips must make **Estimated model cost** clear for API-only, subscription-only and mixed views.

Add completeness metadata to pure folds: known estimated subtotal plus missing usage fields/unpriced contributing calls or stages. A known subtotal is not a complete total; render a partial indicator, and render entirely unknown estimates as absent, never zero. Preserve legitimate explicitly reported zero. Existing helpers that sum `undefined` as zero may remain arithmetic internals only if coverage metadata survives to every aggregate/render path. Graph stage/run totals must flag even one unknown constituent, not only runs where every stage is unpriced. Capture partial usage on failed/aborted calls when the SDK actually reports it, without claiming unreported usage is zero.

Adding completeness fields/DTOs must preserve existing record reads and schema-version rules. Prefer deriving them from existing usage logs; do not rewrite old learning records merely to attach a billing flag. Search/voice prices and authorization remain independent; Codex login does not grant either service.

## Implementation sequence and checkpoints

1. **Freeze contracts and make SDK characterization executable.** Recheck installed 1.0.2 public options; map every current generation/cost surface; read relevant installed Next guides. Add isolated failing tests for attempts, storage invariants, manual state, explicit one-send transport and error normalization. Do not start UI on an assumed SDK contract.
2. **Build durable authorization and lifecycle first.** Store validation, locking, atomic replacement, tombstones, attempt-bound commit, restart behavior, local disconnect and request leases. Prove lock/refresh/logout races with real temporary files and subprocesses; fail this checkpoint rather than shipping in-memory-only persistence.
3. **Compose real SDK and unify source/capability gates.** Inject the collection legally, update catalog/provider DTOs and settings validation, all model entrances and background recovery, remove hardcoded key overrides, enforce last-send fencing and no retries/fallback. Prove with real pi controlled-network contracts, not only fake engines.
4. **Implement protected API, settings events and deployment guidance.** Same-origin guards/no-store, browser and device flows, strict manual fallback, cancellation and local-only disconnect; UI language integration and preserved Electron binding. Test events, not just component text.
5. **Complete usage/estimate semantics.** Add coverage-aware pure folds and consistent labels across all discovered displays. Regression-test API-only and mixed-source history with known/unknown usage/prices.
6. **Run authorized isolated gates and independent review.** Future implementation runs targeted tests, then `npm run lint`, `npm run typecheck`, `npm test` and relevant build/package smoke tests, with credentials/data paths isolated before import. Current planning does not run these commands. Review Standards and Spec separately, fix findings and rerun affected checks; no automatic deployment or dependency install.
7. **Request narrow real acceptance permission.** With separately approved login/minimal-call access and available desktop environment, verify desktop and same-machine browser status, sign-in, restart, selected subscription call, usage and disconnect. Record actual versions, origins/data roots and supported login methods. Phone/cloud remain explicitly unverified. Missing environment/permission means not accepted and #8 remains open.

Each implementation checkpoint produces its own reviewable change and evidence. Do not create a second map or duplicate implementation tickets merely to represent these steps.

## Acceptance matrix for the future implementation

| Layer | Must exercise | Required observable evidence |
| --- | --- | --- |
| Business entrances | Existing chat Request/Response entrances with faux engines; jobs/extraction at their highest existing seam | Explicit provider/model/role choice, safe refusals, persisted learning/usage, no implicit model or source change. Fake engine success is not OAuth proof. |
| Lifecycle | Real service/adapter with supplier network and time controlled | Browser/device/manual success and failure; cancellation, expiry, mismatch, duplicate input, port conflict/device-disabled; no token leaks and no false connected state. |
| Persistence/process | Real isolated files, fresh subprocesses and simultaneous clients | Restart recovery, instance separation/shared-instance visibility, exactly one refresh, rotated token used; remote rotation followed by save failure/crash leaves a durable marker and blocks process B even after stale-lock recovery; failure to persist the marker causes zero network. Permissions/corruption/future schema/symlink/write failure fail safely. |
| Races | Barriers at refresh, login commit, inside the locked check/send section and late completion | Pause after final check before fetch: another process cannot complete disconnect until this send is issued or rejected; the inverse order rejects send. Cover logout during refresh/login, cancellation, replacement attempt, account switch, duplicate route/process starts and nonowner interaction, old job/wake/recovery; no resurrection/cross-account continuation. |
| Real SDK | Unmodified pi-ai 1.0.2 collection/provider/engine with isolated credentials and controlled HTTP responses | Legacy endpoint, selected model, bearer/account headers derived from this instance; updated refresh token persisted and used; no OpenRouter override, no extra send on 429/5xx/network errors, no alternative provider. |
| Error handling | Recognized terminal refresh, quota/model errors, ambiguous 401/403/429, malformed bodies, network and stream failures | Correct safe codes or unknown, preserved transient session, no raw secrets, no replay, zero paid-provider requests despite configured valid key. |
| Selection/capabilities | strong/cheap/vision, role overrides, chat settings, picker and execution | Connected/disconnected pins persist; no unsupported vision choice; catalog is not an entitlement promise; original API paths still work. |
| Accounting | Known tokens/prices, missing fields, missing price, failures, mixed sources and stages | Real zeros distinct from unknown, partial subtotal marked partial, all money described as estimated, correct original API calculations. |
| UI/security | Actual start/reply/cancel/logout events, multiple clients, origin/host rejection, cache/storage inspection | Same-instance state, no persistent browser secrets, cross-origin rejection, protected remote instructions and unchanged loopback default. |
| Real desktop/local browser | Separate future permission, minimal real sign-in/call/restart/disconnect | Actual recorded results; local sign-out not remote revocation; phone/cloud explicitly deferred. |

Tests use existing flat `tests/` conventions: candidates include `subscription-lifecycle.test.ts`, `subscription-store.test.ts`, `subscription-sdk.test.ts`, a settings event `.test.tsx`, and extensions to existing catalog/settings/refusal/usage/cost/chat/jobs/extraction tests. No test reads an actual auth file or imports config before path isolation. Existing `buildAgent` only replaces conversation construction: it does not prove compaction/jobs/extraction or SDK authentication. Production `NODE_ENV=test` compaction short-circuits must be bypassed through the existing explicit summarizer seam or separate isolated contract process, not mistaken for coverage.

## Planning review record

Independent read-only adversarial review on 2026-10-19 found two P2 protocol gaps. The main agent accepted both. The revised plan makes final generation/fault checking and transport invocation one locked send operation, and adds a separate durable refresh journal that survives credential replacement or a failed durability check. It also specifies durable attempt ownership and nonowner handling. The acceptance matrix now includes the corresponding cross-process barriers and persistence-failure cases.

The reviewer re-read the changes, including the rename-before-failed-durability case, and closed both findings at the plan level with no new conflict found. This is static plan review, not evidence that code, OAuth, locking or tests work. No product code, product tests, real credentials, sign-in, inference, dependency installation/upgrade or deployment were used in this planning round.

## Planning completion and handoff

Planning handoff requires an issue progress/comment linking the plan and clearly distinguishing proposed work from completed functionality. The GitHub comment must carry enough plan content to be useful without this unpushed local path. No implementation resolution gist or issue closure is appropriate.

Next authorized action after this round: the owner may authorize implementation of this reviewed plan. Real sign-in/calls, dependency changes and deployment retain their separate permission boundaries. The first implementation task is the SDK/store characterization checkpoint, not a login-button-only patch.
