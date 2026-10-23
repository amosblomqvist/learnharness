# Undici advisory coverage for issue 13

<!-- archive-note:start -->
> Archived on 2026-10-23 under [workspace task 26](https://github.com/gzy31007/learnharness/issues/26). The original report follows unchanged except for mechanical local-link routing.
>
> Research cutoff: 2026-10-20, Asia/Shanghai. Historical input: ef38592db11d68bae3b22c175aaefc57966b039e plus the report's separately recorded working-tree patch and isolated snapshot.
>
> Later status, checked against the archive baseline: The report already includes implementation and isolated acceptance. The archive baseline locks npm undici 7.30.1. This does not update Node/Electron embedded networking code or prove that the live installation and shipped artifacts match. [Owning record](https://github.com/gzy31007/learnharness/issues/13).
>
> Read the [archive guide](README.md) and [local evidence register](local-evidence.md) before reusing any present-tense statement, line number, or acceptance result. Archive publication is not a new test run, distribution approval, or general risk acceptance.
<!-- archive-note:end -->

Research and source-access date: 2026-10-20, Asia/Shanghai.

## Result and scope

The supplied audit's ten advisories all include npm undici 7.29.0 and all first name **7.29.1** as patched on the 7.x line. The official [7.29.1 release][release7291] explicitly lists all ten fixes. This supports 7.29.1 for that historical set, but **does not support 7.29.1 as the current complete advisory-remediation target**.

The maintainer's public advisory API also contains eight newer advisories affecting both 7.29.0 and 7.29.1. All first name **7.30.1** as patched. The official [7.30.1 release][release7301] lists all eight fixes. Therefore **7.30.1 is the smallest common patched 7.x version for the original ten plus the eight newer applicable advisories found at this cutoff**. A ninth newer advisory affects only 8.11.0 and 8.11.1, not 7.x. These are version-coverage facts, not proof of application exploitability, runtime compatibility, or authorization to install anything.

The [7.30.1 tagged manifest][package7301] and [npm version record][registry7301] both retain `engines.node: ">=20.18.1"`. The existing OpenAI optional peer `>=5 <9` and Electron downloader optional dependency `^7.24.4` admit 7.30.1. Those constraints do not require a parent upgrade, override, or new direct dependency solely to resolve the root npm copy to this version.

This note supplements the earlier [Windows advisory triage](local-evidence.md#local-027). That note researched only the two undici high-severity findings and explicitly excluded the remaining lower-severity notices. Its loading observations are reused below, with fresh source checks. This is not a general review of all HTTP, TLS, proxy, model-provider, Electron, or application security.

## Baseline, evidence and method

- The supplied [audit-before JSON](local-evidence.md#local-007) contains exactly ten undici `via` records, root path `node_modules/undici`, effect `openai`, and `fixAvailable: false`. It does not contain the eight newer applicable advisories below. That boolean is an audit solver result, not evidence that no patched package exists.
- The installed [undici manifest](local-evidence.md#local-090) reports 7.29.0. During this research the separately edited [root lock entry](local-evidence.md#local-097) reported 7.29.1. The parent confirmed that it had tentatively edited the lock without installing and was pausing further changes. This researcher did not make that edit. Do not conflate the audit baseline, installed bytes, and concurrent working-tree lock. Recheck the lock at implementation time.
- Observed HEAD was `ef38592db11d68bae3b22c175aaefc57966b039e`. Existing modified and untracked files were left untouched. This report and the explicitly authorized source-response files listed below are this researcher's only writes.
- Read the full descriptions and version metadata of the ten individual GitHub reviewed API records. Then read the maintainer advisory inventory, including the full descriptions of all nine October entries, and the official 7.29.1 and 7.30.1 release bodies. No search summaries or community reports support the findings.
- The maintainer [repository advisory inventory][repo-inventory] returned 55 public entries, fewer than the requested page size of 100. The npm-filtered [GitHub reviewed inventory][reviewed-inventory] returned 46 entries. Comparing the returned identifiers shows that the nine October repository advisories are absent from that reviewed inventory. The supplied npm audit also omits the eight applicable October entries. This establishes an observed disclosure/indexing coverage gap; it does not establish why npm's backend or that snapshot omitted them.
- Before every GitHub request, ran `curl -sI -m10 -x http://127.0.0.1:7897 https://github.com` and required its final HTTP status to be 200. Set `http_proxy`, `https_proxy`, `HTTP_PROXY`, and `HTTPS_PROXY` to that proxy and unset `all_proxy` and `ALL_PROXY`. Public requests were unauthenticated.
- No install, dependency/configuration/source edit, branch, commit, issue mutation, server start, exploit, model request, login, credential read, or user-data access occurred. No further agent was delegated. The explicit research-subagent instruction superseded the skill's generic delegation step.

## The ten advisories in the supplied audit

Ranges below are the exact 7.x intervals from the individual reviewed API records. Each linked identifier points to the full record actually read. GitHub's `medium` corresponds to npm's `moderate`; the audit has two high, five moderate, and three low notices. **Every row's first patched 7.x version is 7.29.1**, independently corroborated by the [official release][release7291].

| Advisory and severity | Affected 7.x interval | First patched 7.x | Published prerequisites and impact |
| --- | --- | --- | --- |
| [GHSA-3wwx-pv8p-q78v][a-3wwx], medium | `>=7.28.0 <7.29.1` | `7.29.1` | Undici WebSocket, including a matching vulnerable Node bundled `globalThis.WebSocket`, connects to a malicious or compromised peer. A permessage-deflate message crosses the decompressed-payload size limit and then contains malformed DEFLATE data. Cleanup removes the internal inflater's error listener but leaves it running; a later `Z_DATA_ERROR` terminates the process. Public WebSocket error/close handlers cannot catch this internal stream error. The advisory states no workaround. |
| [GHSA-pmjh-fq2x-6v4x][a-pmjh], medium | `>=7.11.0 <7.29.1` | `7.29.1` | `RetryHandler` retries a truncated response and then receives a non-retryable response. The application's original response body never settles, so reads hang and repeated requests accumulate promises/streams. `bodyTimeout` does not fire. The documented workaround requires an independent deadline and destroying the body at expiry. An SDK's own retry loop is not automatically this Undici handler. |
| [GHSA-r53p-7pc4-xj5r][a-r53p], low | `>=7.0.0 <7.29.1` | `7.29.1` | Requires `interceptors.retry()`, an attacker-controlled or faulty upstream, partial response delivery followed by resumption, and a downstream proxy/gateway forwarding the original status and headers without recalculating framing. Appended resumed bytes can exceed the original `Content-Length` and become a subsequent downstream response. Workarounds disable that interceptor or retries, or remove/recalculate downstream `Content-Length`. Ordinary consumption without that forwarding condition is not the published splitting chain. |
| [GHSA-rfgv-xxqx-mfg5][a-rfgv], high | `>=7.0.0 <7.29.1` | `7.29.1` | A malicious/compromised WebSocket server, or interception of plaintext `ws://`, returns a `101` handshake with an unrequested `Sec-WebSocket-Protocol`. Default `new WebSocket(url)` with no requested subprotocol is affected. An uncaught microtask `TypeError` terminates Node. No application authentication is required by the advisory; it states no workaround. |
| [GHSA-3xpg-4rpp-hhhm][a-3xpg], medium | `>=7.15.0 <7.29.1` | `7.29.1` | Requires `interceptors.decompress()` processing a compressed response from an untrusted, compromised, or faulty upstream. The five-layer cap does not bound decompressed bytes, so a small compression bomb exhausts memory. The patch adds `maxSize`, default 64 MiB, and rejects excessive output. Avoid that interceptor for untrusted upstreams or enforce a custom decoded-size limit before upgrading. This finding is not a blanket claim about every use of fetch's automatic decompression. |
| [GHSA-2jfj-6hjv-fm6j][a-2jfj], medium | `>=7.0.0 <7.29.1` | `7.29.1` | Requires `interceptors.cache()` in default/shared mode, a cacheable response carrying `Set-Cookie`, and another caller hitting the same key. Stored cookies can cross users or be injected by an untrusted upstream. `type: 'private'` is explicitly excluded. The patch excludes these responses from shared storage/replay, including old entries and revalidation. Documented workarounds use private caches or avoid caching/strip `Set-Cookie`. |
| [GHSA-2gqq-gqf2-x968][a-2gqq], low | `>=7.1.0 <7.29.1` | `7.29.1` | Requires `interceptors.dump()` and a chunked response without `Content-Length` exceeding configured `maxSize`. Instead of a clean size abort, early completion and a caught internal assertion yield a misleading success status with an empty/truncated body and connection teardown. The patch aborts with `RequestAbortedError`. The advisory lists no workaround and says to avoid this interceptor for untrusted upstreams pending upgrade. |
| [GHSA-w293-vg96-wgc3][a-w293], high | `>=7.24.1 <7.29.1` | `7.29.1` | Requires `BalancedPool` with function-valued `connect`/`tls`, such as `checkServerIdentity` or a connector. JSON cloning drops the function. A certificate that passes Node's default hostname/chain checks but should fail the custom policy can be accepted. It is not an unconditional acceptance of every invalid certificate. This advisory excludes `Client`, `Pool`, `Agent`, and `RoundRobinPool` from this specific BalancedPool bug; it suggests other client/pool types as a workaround. See the separate, newer Agent bug below before generalizing that exclusion. |
| [GHSA-8436-99hf-9mmv][a-8436], low | `>=7.0.0 <7.29.1` | `7.29.1` | Requires `interceptors.cache()` and an unsafe method such as POST/PUT/PATCH/DELETE. An upstream response eligible for caching, for example a 404 with explicit `max-age`, can be stored and replayed so a repeated state-changing request never reaches the origin. Default `methods: ['GET']` does not prevent this implementation bug. The patch restricts reads/writes to safe methods while retaining unsafe-request invalidation. The advisory lists no workaround. |
| [GHSA-rx4f-c7p8-82vq][a-rx4f], medium | `>=7.0.0 <7.29.1` | `7.29.1` | Requires the **WebSocketStream API**, a held writable-stream writer lock, and abrupt connection closure without the close handshake. The internal handler discards the rejected promise from aborting a locked stream, causing an unhandled rejection and process termination under Node's default policy. A TCP reset, proxy teardown, or invalid frame can trigger it. This is not interchangeable with ordinary WebSocket. The advisory states no workaround. |

A version match alone does not prove any particular application path constructs these APIs or receives the triggering input. Conversely, absence of an application-level direct import does not establish that a dependency or runtime cannot reach them.

## Newer public advisories missing from the audit

These eight maintainer advisories were published on 2026-10-15. All are non-withdrawn in the retrieved inventory and all include **both 7.29.0 and 7.29.1**. Sources are the full maintainer API descriptions, not the reviewed database, which had not listed these entries at this cutoff. The [official 7.30.1 release][release7301] independently lists each fix.

| Advisory and severity | Affected 7.x interval | First patched 7.x | Published prerequisites and impact |
| --- | --- | --- | --- |
| [GHSA-qrxm-fqhp-jwvm][n-qrxm], high | `>=7.0.0 <7.30.1` | `7.30.1` | A malicious/compromised HTTPS peer performs TLS 1.2 renegotiation after connection establishment, replacing the initial matching certificate with another CA-trusted certificate whose hostname does not match. Node emits `ERR_TLS_CERT_ALTNAME_INVALID`; Undici's established-socket assertion terminates the process. HTTP/1.1 and HTTP/2 are affected, including a matching vulnerable global fetch implementation. TLS 1.3 cannot renegotiate and is excluded. No CA compromise is needed. The documented workaround restricts outbound connections to TLS 1.3 where supported. |
| [GHSA-2m5v-pch6-74hx][n-2m5v], high | `>=7.0.0 <7.30.1` | `7.30.1` | `Agent` receives a function-valued **`tls`** option, such as custom certificate/public-key verification. JSON cloning drops the callback, accepting a certificate that passes default checks but violates the custom policy. `EnvHttpProxyAgent` direct/NO_PROXY routes also delegate to an affected Agent. Passing these options through **`connect` is explicitly not affected**. Agent being a default dispatcher does not remove the custom-tls prerequisite. This is a separate bug from the original BalancedPool advisory. |
| [GHSA-4w7w-5xrc-9h26][n-4w7w], high | `>=7.0.0 <7.30.1` | `7.30.1` | Requires an originless Agent, a shared MemoryCacheStore or SqliteCacheStore, and exact composition `compose(redirect(), cache())`. A cross-origin redirected response can be stored under the original URL, permitting persistent poisoning or replay of private user-specific data. Origin-bound Client/Pool and reverse `compose(cache(), redirect())` are excluded. The patch checks response origin and preserves redirect-hop cache policy. |
| [GHSA-xjj6-f33q-929c][n-xjj6], high | `>=7.18.0 <7.30.1` | `7.30.1` | Undici `fetch()` receives more than five content codings and the server closes before sending the body. Although fetch rejects the excessive encoding chain, an already-created internal response stream is orphaned; its later content-length error is unhandled and terminates Node. Correctly catching fetch's rejection does not prevent it. This is a fetch-path bug, not the optional decompress-interceptor finding. No workaround is documented. |
| [GHSA-55wc-3pg8-jfw6][n-55wc], medium | `>=7.15.0 <7.30.1` | `7.30.1` | `decompress` is composed with `dump` or another response handler that throws. A small compressed body can cross a decoded-size limit, and the handler's exception escapes from an asynchronous zlib callback as an uncaught exception. A global uncaught-exception handler can instead leave the request hanging until body timeout. Workaround avoids that composition; the patch converts downstream exceptions into per-request failures. |
| [GHSA-f72v-6w45-q472][n-f72v], medium | `>=7.15.0 <7.30.1` | `7.30.1` | `fetch()` has valid uppercase or mixed-case SRI algorithm tokens, such as `SHA256-...`, but no recognized lowercase token remains. The token is wrongly skipped and a mismatching response body is accepted. The attacker controls the body, not necessarily the integrity metadata. Lowercase tokens are the documented workaround. The patch normalizes tokens before validation and strongest-algorithm selection. |
| [GHSA-4qv8-2p9j-2685][n-4qv8], medium | `>=7.0.0 <7.30.1` | `7.30.1` | An **EventSource client** stays connected to an untrusted SSE peer that sends many tiny completed `data:` fields without an event separator, or an unfinished line split across many chunks. Retained field/chunk state grows despite byte limits; compressed input further evades the pre-decompression response-byte cap. The patch bounds parser state independently. This is not evidence that an arbitrary SDK SSE parser uses Undici EventSource. No workaround is documented. |
| [GHSA-9fm3-97px-rjf6][n-9fm3], medium | `>=7.0.0 <7.30.1` | `7.30.1` | Undici WebSocket, including a matching vulnerable Node bundled global WebSocket, receives a PING flood from a server that does not read automatic PONGs. Ignored socket backpressure lets the outbound queue grow until memory exhaustion. An ordinary WebSocket connection is sufficient; no application send loop is necessary. The patch pauses frame parsing on PONG backpressure and resumes on drain. No workaround is documented. |

The ninth newer item, [GHSA-qq8j-7v2v-3rwp][n-qq8j], was published on 2026-10-14 and affects **`>=8.11.0 <8.11.2` only**, first patched `8.11.2`. Failed HTTP/2 WebSocket handshake validation followed by peer teardown leaves an orphaned ClientHttp2Stream and crashes Node. It does not raise the 7.x minimum. No other later-published repository entries appeared in the retrieved public inventory as of this access.

**Coverage calculation.** For the historical ten, every 7.x range ends before 7.29.1 and names 7.29.1 as first patched. For the eight newer applicable entries, every 7.x range ends before 7.30.1 and names 7.30.1 as first patched. Thus 7.29.1 covers the first set but remains inside every newer range; 7.30.1 is outside all eighteen affected 7.x intervals. This is a bounded current-public-advisory result, not a guarantee against unpublished or future vulnerabilities.

## Loading boundary: npm package versus runtime globals

### What the dependency graph establishes

OpenAI 7.19.0 declares an optional undici peer `>=5 <9`, [locked metadata](local-evidence.md#local-096), corroborated by the [installed manifest](local-evidence.md#local-087). The Electron downloader, `@electron/get` 5.1.0, is a development dependency with optional undici `^7.24.4`, [lock evidence](local-evidence.md#local-100). Both admit 7.30.1 without widening their declarations.

The tree also has a separate development copy under node-gyp, locked to 6.29.1, [node-gyp edge](local-evidence.md#local-094) and [nested undici entry](local-evidence.md#local-095). It is not the root 7.x copy. Do not silently replace it with 7.x, or assume patching the root changes nested or embedded implementations. The present task's supplied audit entry identifies only the root copy.

### What the inspected call sites establish

- OpenAI's default client selects `options.fetch ?? Shims.getDefaultFetch()`, [client](local-evidence.md#local-082). The shim returns the existing global fetch, [shim](local-evidence.md#local-086). Therefore the optional npm peer is not automatically the implementation of every OpenAI/model HTTP request. OpenAI's `maxRetries` option in the same client is not proof of Undici `RetryHandler` or `interceptors.retry()` use.
- OpenAI's X.509 transport does explicitly `require('undici')`, [module import](local-evidence.md#local-084), and validates Agent or ProxyAgent rather than BalancedPool, [dispatcher check](local-evidence.md#local-083). This excludes that constructor path from the original BalancedPool prerequisite only. It does not establish whether a caller has supplied the newer Agent bug's function-valued `tls` options, or that this transport is active. The transport also has explicit npm `undici.fetch` calls, [source](local-evidence.md#local-085).
- pi-ai's inspected Codex WebSocket constructor selects `globalThis.WebSocket` outside its Bun-specific branch, [constructor](local-evidence.md#local-062). A helper named `processWebSocketStream` in that file is not evidence of constructing the distinct Undici `WebSocketStream` API.
- Literal searches in app, components, src, lib, and electron found no direct undici import, BalancedPool, RetryHandler/RetryAgent, `WebSocketStream` API construction, named retry/decompress/cache/dump interceptor composition, or `setGlobalDispatcher`. The one component comment mentioning undici is not an import. A search of pi-ai's distributed JavaScript found no undici import or named interceptor use. These are bounded static findings, not a complete inventory of every dependency's dynamically selected implementation.

The version-tagged [Undici README][readme7301], lines 50-72 and 208-216, states that built-in fetch uses the version bundled with Node, identifiable through `process.versions.undici`. Installing a newer npm package alone does not replace those embedded bytes. Lines 186-203 and 286-320 document explicit `install()` replacement of globals, including fetch and WebSocket; lines 615-620 separately document a shared compatible global dispatcher. Sharing a dispatcher is not the same as replacing fetch/WebSocket code or all internal parsers. No global replacement or dispatcher mutation was performed in this research.

**Assessment.** A root npm patch can repair consumers actually loading that package. It cannot by itself attest that Node's or Electron's bundled fetch/WebSocket is patched. The WebSocket advisories explicitly discuss Node bundled globals, and the newer TLS-renegotiation and excessive-content-encoding findings can concern matching vulnerable fetch implementations without an optional interceptor. Actual built-in versions and vendor backports must be checked independently for each execution process, including packaged server versus renderer contexts. Browser/Chromium WebSocket is not automatically the npm undici implementation. No packaged Electron/Windows runtime was inspected or executed here.

## Candidate identity and compatibility limits

The [npm 7.30.1 record][registry7301] reports:

| Field | Observed value |
| --- | --- |
| Version | `7.30.1` |
| Node engine | `>=20.18.1` |
| gitHead | `7507102a675b082a71437f0a00681e537875556c` |
| dist.tarball | `https://registry.npmjs.org/undici/-/undici-7.30.1.tgz` |
| dist.integrity | `sha512-03KrMbjIFDWQR5RNPrSw3bd1r12JpyFQl9/yxjUbJtqkjmllqC5lFjZh6ujeuJCKr8EOQvRW872Oy/az+nLYxg==` |

These metadata observations and parent-range compatibility are not an installed-tarball verification, signature/provenance validation, build result, or behavioral regression test. The official 7.29.1 and 7.30.1 releases also include non-security changes, so version numbering alone is not a compatibility test. A future authorized implementation should preserve parent versions/ranges, inspect the narrow resolution diff, verify the installed graph, and evaluate npm and runtime-global inventories separately. This report does not select a parent upgrade or override policy, and the parent has paused changes pending user confirmation.

## Evidence conflicts and remaining limits

- Maintainer publication and reviewed ingestion dates differ. The 7.29.1 release and repository entries are dated September 4, while the individual reviewed entries are dated September 28/29. Matching patch metadata and the release's explicit ten-item security list agree. Do not rewrite these distinct dates into one supposed disclosure time.
- Some older maintainer structured range strings combine release branches with semicolons and inconsistent comparator syntax. The ten individual reviewed records normalize them into separate intervals. This report uses those reviewed 7.x intervals, corroborated by the maintainer patch fields and release notes. The eight newer maintainer entries have separate, explicit 7.x intervals as reported above.
- The older BalancedPool advisory's Agent exclusion is specific to that bug. The newer Agent advisory concerns `tls`, explicitly not `connect`. They are different prerequisites, not evidence that either advisory can be ignored.
- The audit and even the current reviewed list lag the newer public maintainer records. A clean audit after changing to 7.29.1 would not prove current advisory coverage. The reason for that indexing lag was not independently investigated.
- No exploit or synthetic regression was executed. No request reached a model endpoint. Endpoint control, compression negotiation, custom TLS callbacks, actual interceptor composition, downstream forwarding, cache sharing, and effective runtime globals remain conditions to establish for an application-specific exploit verdict.
- No Node/Electron upgrade target, vendor backport mapping, production bundle, Windows archive, installed candidate, or full transitive/embedded-copy inventory was validated. This note must not be used as Windows acceptance, risk acceptance, or a claim that npm 7.30.1 repairs the runtime's embedded implementation.
- The full public inventory and release sources were checked at this cutoff, not continuously monitored. Private/unpublished advisories and future disclosures are outside the evidence.

## Implementation and isolated acceptance

The preceding sections record the pre-implementation research, including the pause for user approval. The user subsequently approved the 7.30.1 plan on 2026-10-20. The final workspace patch changes only `version`, `resolved`, and `integrity` in the root [undici lock entry](local-evidence.md#local-097), plus the new [SDK regression tests](local-evidence.md#local-120). The manifest, parent SDK versions, dependency ranges, optional status, and nested development undici 6.29.1 were not changed. No override or new direct dependency was added.

Acceptance ran in `/root/learnharness/.scratch/issue13-undici-20261020/source`, not the live workspace installation. The [installed graph](local-evidence.md#local-010) reports root npm undici 7.30.1, OpenAI 7.19.0, and both pi packages 1.0.2. The [verified input hashes](local-evidence.md#local-023) match the workspace manifest, lock, and new test. A broader [snapshot comparison](local-evidence.md#local-013) also matches all 452 selected implementation, test, and configuration files. Validation used local Node 22.23.3, whose bundled Undici reports 6.28.1; this was not the repository's Node 26 CI matrix. The live workspace's existing `node_modules` was deliberately not updated. No commit, push, CI run, release, Windows package execution, or real model request occurred.

- Full `npm ci --no-audit --no-fund` succeeded, exit 0, with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`. The [first attempt](local-evidence.md#local-012) failed with `ECONNRESET`; proxy probes returned 200, and the [retry with four connections](local-evidence.md#local-011) installed 1,061 packages. This was a download failure, not a lock or package compatibility failure.
- [Command results](local-evidence.md#local-022) record exit 0 for type generation, typecheck, lint, the five new SDK tests, all 1,930 tests, and production build. Test summaries report no failures or skips. Each command used an explicit credential-free environment and a [validation-only network guard](local-evidence.md#local-029) denying non-loopback network access. The SDK harness independently uses `MockAgent.disableNetConnect()` and synthetic credentials.
- The regression exercises the real pi/OpenAI SDK with explicit npm `undici.fetch`, exact source/model/auth wiring, single send, no unmatched fetch retry or WebSocket fallback, HTTP 429/500 classification, both 200 SSE failure shapes, immediate and retained partial-event redaction, and the ordinary API-key success path. It does not prove production normally selects npm fetch, reproduce the advisories, or repair embedded runtime globals.
- The [build log](local-evidence.md#local-009) retains four dynamic-filesystem tracing warnings, the isolated-home/root-discovery warning, and a cold-cache notice. The [test log](local-evidence.md#local-014) also records an Electron binary download attempt denied by the guard. Passing Node tests does not establish a working Electron binary, native-renderer acceptance, Windows desktop acceptance, or real-account end-to-end behavior.
- The validation runner initially completed all six commands successfully but its final artifact check failed because the research note was not copied into the source snapshot. The artifact check was corrected to compare only implementation inputs, then separately passed with `--verify-inputs`, exit 0. This tooling failure does not change the individual command exit codes; it must not be reported as an initially clean aggregate run.

Independent Standards and Spec reviews found no blocking defect. Standards noted only optional fixture-lifecycle deduplication, which was left unchanged to avoid unrelated refactoring. The [independent acceptance report](local-evidence.md#local-024) records another isolated SDK run, 5/5 passed with exit 0, exact installed-version and input-hash checks, and a structured audit comparison. That verifier inspected the full-suite/build artifacts rather than rerunning those commands. Its PASS has the same npm-only and non-desktop boundaries.

### Audit comparison and database drift

All audit commands used `npm audit --omit=dev --package-lock-only --ignore-scripts --json` and returned exit 1 for remaining findings, not a transport error. Raw records and the [same-window comparison](local-evidence.md#local-008) preserve these distinct baselines:

| Record | Affected package entries | Low | Moderate | High | Critical |
| --- | --- | --- | --- | --- | --- |
| [Supplied historical before](local-evidence.md#local-006) | 18 | 9 | 3 | 6 | 0 |
| [Refreshed original lock](local-evidence.md#local-005) | 13 | 9 | 0 | 4 | 0 |
| [Patched lock after](local-evidence.md#local-004) | 12 | 9 | 0 | 3 | 0 |

The refreshed original lock was taken directly from immutable commit `ef38592db11d68bae3b22c175aaefc57966b039e`, with undici still 7.29.0, and audited without installation. Only **undici** disappears between that refreshed baseline and the patched lock. No new high/critical package/advisory identity appears. The other historical differences, including Next/postcss and propagated pi/OpenAI entries, already disappear when re-auditing the unchanged original lock. They must not be credited to this patch; their upstream audit-index change was not investigated.

Remaining high package entries are ansi-to-react, linkify-it, and source-map-js, covered by sibling issues 11 and 14. The nine low entries also remain. This ticket does not accept those risks or resolve the other tickets. In particular, npm's audit omission of the eight newer applicable Undici advisories remains a coverage limit: the 7.30.1 decision relies on the primary advisory and release evidence above, not an empty undici audit entry alone.

## Preserved primary evidence

The parent authorized these dedicated raw-response files under its evidence directory. No existing evidence file was overwritten.

- [Maintainer advisory inventory, full descriptions and metadata](local-evidence.md#local-020), from [repository API][repo-inventory].
- [Reviewed npm advisory inventory, full records](local-evidence.md#local-021), from [reviewed API][reviewed-inventory].
- [7.29.1 release API response](local-evidence.md#local-018), from [release API][release-api7291].
- [7.30.1 release API response](local-evidence.md#local-019), from [release API][release-api7301].
- [Tagged 7.30.1 manifest](local-evidence.md#local-015) and [tagged README](local-evidence.md#local-016), from [upstream manifest][package7301] and [upstream README][readme7301].
- [npm 7.30.1 response](local-evidence.md#local-017), from [npm registry][registry7301].

[repo-inventory]: https://api.github.com/repos/nodejs/undici/security-advisories?per_page=100
[reviewed-inventory]: https://api.github.com/advisories?ecosystem=npm&affects=undici&per_page=100&sort=published&direction=desc
[release7291]: https://github.com/nodejs/undici/releases/tag/v7.29.1
[release7301]: https://github.com/nodejs/undici/releases/tag/v7.30.1
[release-api7291]: https://api.github.com/repos/nodejs/undici/releases/tags/v7.29.1
[release-api7301]: https://api.github.com/repos/nodejs/undici/releases/tags/v7.30.1
[package7301]: https://raw.githubusercontent.com/nodejs/undici/v7.30.1/package.json
[readme7301]: https://raw.githubusercontent.com/nodejs/undici/v7.30.1/README.md
[registry7301]: https://registry.npmjs.org/undici/7.30.1
[a-3wwx]: https://api.github.com/advisories/GHSA-3wwx-pv8p-q78v
[a-pmjh]: https://api.github.com/advisories/GHSA-pmjh-fq2x-6v4x
[a-r53p]: https://api.github.com/advisories/GHSA-r53p-7pc4-xj5r
[a-rfgv]: https://api.github.com/advisories/GHSA-rfgv-xxqx-mfg5
[a-3xpg]: https://api.github.com/advisories/GHSA-3xpg-4rpp-hhhm
[a-2jfj]: https://api.github.com/advisories/GHSA-2jfj-6hjv-fm6j
[a-2gqq]: https://api.github.com/advisories/GHSA-2gqq-gqf2-x968
[a-w293]: https://api.github.com/advisories/GHSA-w293-vg96-wgc3
[a-8436]: https://api.github.com/advisories/GHSA-8436-99hf-9mmv
[a-rx4f]: https://api.github.com/advisories/GHSA-rx4f-c7p8-82vq
[n-qrxm]: https://api.github.com/repos/nodejs/undici/security-advisories/GHSA-qrxm-fqhp-jwvm
[n-2m5v]: https://api.github.com/repos/nodejs/undici/security-advisories/GHSA-2m5v-pch6-74hx
[n-4w7w]: https://api.github.com/repos/nodejs/undici/security-advisories/GHSA-4w7w-5xrc-9h26
[n-xjj6]: https://api.github.com/repos/nodejs/undici/security-advisories/GHSA-xjj6-f33q-929c
[n-55wc]: https://api.github.com/repos/nodejs/undici/security-advisories/GHSA-55wc-3pg8-jfw6
[n-f72v]: https://api.github.com/repos/nodejs/undici/security-advisories/GHSA-f72v-6w45-q472
[n-4qv8]: https://api.github.com/repos/nodejs/undici/security-advisories/GHSA-4qv8-2p9j-2685
[n-9fm3]: https://api.github.com/repos/nodejs/undici/security-advisories/GHSA-9fm3-97px-rjf6
[n-qq8j]: https://api.github.com/repos/nodejs/undici/security-advisories/GHSA-qq8j-7v2v-3rwp
