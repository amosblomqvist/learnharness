# Upstream 0.3.2 desktop and subscription impact

<!-- archive-note:start -->
> Archived on 2026-10-23 under [workspace task 26](https://github.com/gzy31007/learnharness/issues/26). The original report follows unchanged except for mechanical local-link routing.
>
> Research cutoff: 2026-10-22, Asia/Shanghai. Historical input: local ef38592db11d68bae3b22c175aaefc57966b039e versus upstream 1c5024c8c280be127c0c316b3f57a3783fce471d, common ancestor 32febaaae7fea9fdf8ea59fe62d345d37298d399.
>
> Later status, checked against the archive baseline: This is the pre-integration assessment. PR 25 later integrated upstream 0.3.2 and recorded its own verification boundaries. Statements that the fork lacks those fixes describe the old baseline, not the archive baseline. This archive does not repeat Windows, browser, product, or release verification. [Owning record](https://github.com/gzy31007/learnharness/pull/25).
>
> Read the [archive guide](README.md) and [local evidence register](local-evidence.md) before reusing any present-tense statement, line number, or acceptance result. Archive publication is not a new test run, distribution approval, or general risk acceptance.
<!-- archive-note:end -->

Research date: 2026-10-22, Asia/Shanghai.

## Scope and evidence

This is a static source review, not an integration or compatibility test. It covers the three upstream demo/browser fixes, their packaging checks, and their relationship to the fork's completed subscription work and Windows acceptance. Practice behavior, math repair, DOMPurify and KaTeX are outside this note.

The fixed comparison is:

- Local HEAD: `ef38592db11d68bae3b22c175aaefc57966b039e`.
- Upstream snapshot: `1c5024c8c280be127c0c316b3f57a3783fce471d`, package version `0.3.2`.
- Common ancestor: `32febaaae7fea9fdf8ea59fe62d345d37298d399`, package version `0.3.0`.
- Divergence: four local-only commits and eight upstream-only commits. The fork is not simply eight commits behind a linear history.

These facts came from local Git objects through `git log`, `git show` and `git diff`. The objects were already available in the authorized `refs/remotes/upstream-check/main` snapshot. No remote was added and no fetch was performed in this review. The fixed GitHub links below identify the source objects actually read locally; they do not imply a new live GitHub retrieval or verification of current upstream HEAD.

**Fact** means code or an archived acceptance statement actually read. **Inference** means a consequence reasoned from that evidence. **Unverified** means behavior not established by this review. Commands were limited to read-only source investigation. No merge, installation, build, test, CI run, Windows execution, browser, model request, commit or push was performed. Real data, authorization files and environment files were not read. The only authored file is this note; pre-existing dirty files and other untracked material were left alone.

## Main finding

The upstream fixes address a different failure chain from subscription authentication:

1. The packaged standalone dependency graph can omit Puppeteer's runtime imports.
2. The Electron helper can announce its port before CDP is ready.
3. The helper's parent-owned lifetime needs IPC rather than stdin.

They are relevant to a subscription-funded demo job because that job still needs a working local browser after model generation. They do not replace the fork's subscription OAuth, source selection, credentials, cancellation or stream-safety implementation. Successful subscription sign-in and a short teacher answer cannot establish that demo verification works. This is a static dependency finding, not a reproduced failure in the accepted installer. Sources: [upstream tracing include](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/next.config.ts#L56-L74), [upstream helper](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/electron/main.cjs#L59-L103), [local demo verification call](local-evidence.md#local-109), and [accepted scope](local-evidence.md#local-047).

## What each upstream fix changes

### Packaged runtime completeness, b39d5cd

[Commit and diff](https://github.com/amosblomqvist/learnharness/commit/b39d5cd6abbb006be6e879cffc3de5e407b2dcbe).

**Fact.** The fix adds `node_modules/@puppeteer/browsers/lib/browser-data/**/*.js` to standalone tracing. The upstream comment says the directory was missing in 0.3.0 and Puppeteer import failed before browser startup. The fork's [current tracing list](local-evidence.md#local-061) does not contain that include. A base-to-local comparison confirms that the fork did not change this configuration. Source: [fixed upstream lines](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/next.config.ts#L56-L74).

**Fact.** The new payload probe resolves and imports `puppeteer-core` relative to the standalone server, checks real file paths remain inside the payload, and installs module-resolution hooks to reject imports that escape it. It rejects a successful resolution into checkout dependencies rather than treating that as a valid packaged import. Source: [payload confinement](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/scripts/smoke-demo-runtime.mjs#L67-L99).

**Fact.** The existing server smoke previously only proved HTTP boot and GET responses for graph, models and settings. Upstream calls `verifyDemoRuntime` before server startup and replaces the broadly inherited environment with `probeEnv`. The probe uses scratch home/data/auth paths and filters credential-like environment names. Sources: [server-smoke diff](https://github.com/amosblomqvist/learnharness/commit/b39d5cd6abbb006be6e879cffc3de5e407b2dcbe), [probe environment and entry](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/scripts/smoke-demo-runtime.mjs#L17-L65), and [local HTTP-only smoke](local-evidence.md#local-108).

**Inference.** This fills a real gap in the old validation design. Both the helper path and system-Chrome fallback import Puppeteer, so a missing transitive import is not solved merely by having Chrome installed. The current helper starts with `await import("puppeteer-core")` before its later CDP failure handling; the fallback also imports it. Source: [local helper import](local-evidence.md#local-111) and [local fallback](local-evidence.md#local-114).

**Unverified.** The upstream comment and source change do not establish that the fork's specific Next 16.3.8 Windows installer contains the same omission. This task did not inspect its installed payload or execute it. The new include is a targeted upstream repair, not a blanket diagnosis of every local artifact.

### CDP readiness, 3d70e0d

[Commit and diff](https://github.com/amosblomqvist/learnharness/commit/3d70e0da86f1ee2b3792d0f44cb5f2fcb5a46aeb).

**Fact.** The fork prints `BROWSER_SERVICE_CDP <port>` immediately after the hidden window loads `about:blank`. The parent then fetches `/json/version`; a fetch/connect failure returns null and can lead to system-Chrome fallback. Sources: [local announcement](local-evidence.md#local-058) and [local connection/fallback](local-evidence.md#local-113).

**Fact.** Upstream requires the new readiness module before announcing. `waitForBrowserService` requires HTTP 200 at `127.0.0.1:<port>/json/version`, parses JSON, and requires an exact `ws://127.0.0.1:<port>/devtools/browser/<id>` endpoint without credentials, query or fragment. Defaults are a 5,000 ms total deadline, 500 ms per request, 50 ms retry and a 16 KiB response cap. Abort destroys active requests and clears timers. Sources: [helper barrier](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/electron/main.cjs#L71-L101) and [readiness implementation](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/electron/browser-service-readiness.cjs#L10-L90).

**Inference.** Window readiness and CDP readiness are separate barriers. This fix can prevent a transient helper startup race from becoming a browser fallback or job failure. It does not change OAuth callback readiness: the fork's subscription callback is a separate HTTP listener on `127.0.0.1:1455`, not this dynamically allocated CDP port. Source: [local OAuth listener constants](local-evidence.md#local-117) and [listener startup](local-evidence.md#local-116).

### Parent lifetime through IPC, 94b63c6

[Commit and diff](https://github.com/amosblomqvist/learnharness/commit/94b63c6ba72e0be5219531bbe6afa2d0030fe4ce).

**Fact.** The fork spawns the helper with three pipes and observes stdin end/close to quit. Upstream changes the parent to `stdio: ["ignore", "pipe", "pipe", "ipc"]`, requires both `process.channel` and `process.connected` in the child, and registers a one-shot disconnect handler before waiting for app readiness. Disconnect aborts the readiness wait and asks Electron to quit. Sources: [local parent](local-evidence.md#local-112), [local child lifetime](local-evidence.md#local-059), [upstream parent diff](https://github.com/amosblomqvist/learnharness/commit/94b63c6ba72e0be5219531bbe6afa2d0030fe4ce), and [upstream child](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/electron/main.cjs#L71-L103).

The upstream comment attributes the Windows failure to full Electron replacing stdin with synthetic EOF. Its added unit fixture models Windows synthetic EOF and checks that the real helper entry ignores stdin, fails without IPC, and aborts on disconnect. That is the author's documented rationale plus fixture coverage, not independent Windows runtime verification in this review. Source: [lifetime fixture and assertions](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/tests/browser-service-lifetime.test.ts#L18-L122).

**Inference.** These are paired protocol changes. Taking only the new child branch leaves the old parent without IPC and produces `browser-service requires connected parent IPC`; the helper exits before announcing. Taking only the new parent leaves the old child using stdin as its lifetime signal. The new readiness module must also ship with the modified helper. This is a concrete integration constraint, even though no merge simulation was run.

## Static overlap with the fork

The committed base-to-local and base-to-upstream changed-file lists intersect in four files. This is a source comparison, not a claim that Git would emit four conflicts.

| File or concern | Actual overlap | Static assessment |
| --- | --- | --- |
| [Electron shell](local-evidence.md#local-057) | Upstream changes the top-level browser-service branch. Local changes are in updater installation, packaged acceptance metadata detection and updater setup at [lines 425-472](local-evidence.md#local-054). | Same file, disjoint edited regions. No identified competing edit in the helper block. Do not replace the entire shell with upstream and lose the acceptance guards. |
| [Release workflow](local-evidence.md#local-001) | Local edits add the acceptance configuration to the macOS and Windows/Linux rehearsal commands. Upstream inserts its packaged-demo step immediately after those commands and before artifact upload. | Adjacent changes in the same packaging section, not contradictory changes to the same command. A combined file must retain the local configuration flags and insert the new step. Actual textual merge outcome remains unverified. |
| [Manifest at local HEAD](https://github.com/gzy31007/learnharness/blob/ef38592db11d68bae3b22c175aaefc57966b039e/package.json#L49-L59) | Upstream changes root version `0.3.0` to `0.3.2`; the fork pins Next to `16.3.8`. | Different manifest fields, not an upstream dependency upgrade. Replacing the entire file would discard the local pin. Current uncommitted manifest edits are outside this committed comparison and must remain intact. |
| [Lockfile at local HEAD](https://github.com/gzy31007/learnharness/blob/ef38592db11d68bae3b22c175aaefc57966b039e/package-lock.json) | Upstream changes only the top-level and root-package versions. The fork has dependency-lock changes. | Both touch the root package metadata area, but the upstream change is version metadata, not a new dependency resolution. There is no basis to regenerate or overwrite the lockfile during this review, especially with additional dirty security work present. |

The fork has no committed changes since the common ancestor in [headless implementation](local-evidence.md#local-110), [Next configuration](local-evidence.md#local-060), [payload curation](local-evidence.md#local-105) or [server smoke](local-evidence.md#local-107). The upstream-only readiness module, smoke script and dedicated new tests therefore do not compete with a local committed edit at those paths. This does not establish runtime compatibility with the fork's dependency state.

### Shared runtime, separate subscription contracts

The subscription adapter does not use Puppeteer or the hidden demo window. It creates a loopback listener, notifies the UI of the authorization URL, races manual callback input against the callback and cancellation, then closes the listener in `finally`. Sources: [local login flow](local-evidence.md#local-118) and [fixed callback contract](local-evidence.md#local-119).

The semantic overlap is the demo job execution path. The local runner selects an engine and enforces subscription generation/source preflight before executing a job. The demo builder subsequently calls `headless.runDemo` to verify HTML. Upstream changes that browser's availability and lifetime, not the job's source policy. Sources: [local source-aware runner](local-evidence.md#local-115) and [local verification](local-evidence.md#local-109). No upstream-only changed file is one of the fork's subscription server/store/API modules.

**Inference.** A browser fix can make a subscription demo work or fail independently of whether subscription model access succeeds. Conversely, passing a browser smoke cannot prove subscription authentication, refresh, entitlement, stream handling or refusal of silent model fallback. The prior report that clicking `Open the sign-in page` was required is not fixed by these commits; they do not change the subscription UI or authorization URL action. Source: [archived human observation](local-evidence.md#local-048).

## Packaging and verification boundaries

**Fact.** The shell package allow-list includes `electron/**/*`, so it already matches the new readiness module's path without an upstream builder-configuration change. The standalone payload is copied separately through `extraResources`. Existing curation removes only standalone-root build artifacts and the development Electron runtime; it does not add missing Puppeteer files. Sources: [shell allow-list](local-evidence.md#local-051), [standalone copy](local-evidence.md#local-052), and [curation](local-evidence.md#local-106). Whether a new concrete artifact includes the file remains unverified.

**Fact.** The new workflow step drives the packaged executable on macOS, Windows and Linux, with Xvfb on Linux. It follows packaging and precedes Actions artifact upload. It has no event-specific condition, so it applies to the release and rehearsal paths when preceding steps succeed. The signed/release packaging commands still use `--publish always` before this gate, so this is not a guarantee that a bad asset cannot reach an upstream draft. Source: [fixed workflow](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/.github/workflows/release.yml#L158-L191).

**Fact.** The browser probe uses the bundled executable directly, never system Chrome. It connects through CDP, opens a local HTML button demo, verifies `0` changes to `1`, checks console/page/network errors, clears the page, disconnects IPC, and requires an observed clean exit. Unexpected early exit or forced cleanup fails the check. Sources: [probe body](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/scripts/smoke-demo-runtime.mjs#L141-L211) and [shutdown observation](https://github.com/amosblomqvist/learnharness/blob/1c5024c8c280be127c0c316b3f57a3783fce471d/scripts/smoke-demo-runtime.mjs#L101-L139).

**Boundary.** This probe does not start the application server or run the production demo-builder/`runDemo` path. It manually spawns the helper and uses a dependency-free local HTML file. It therefore does not establish concurrent job correctness, repeated production job reuse, external CDN behavior, model-generated demo quality, subscription state or updater-disabled behavior. It checks page state reset on one page, not every event-listener lifetime across real jobs. Its unit tests are source evidence only here; no pass result was collected.

### Acceptance configuration must survive any later integration

The fork's [acceptance configuration](local-evidence.md#local-049) sets root `lhTestBuild: true` and acceptance artifact names. The [shell guard](local-evidence.md#local-055) skips updater setup for that marker, and [install guard](local-evidence.md#local-053) does not kill the server when no updater exists. Upstream's helper patch does not replace those contracts.

The inherited production configuration still names the original author's GitHub release feed. Sources: [feed](local-evidence.md#local-050) and [updater behavior](local-evidence.md#local-056). Losing the local acceptance build configuration or guards would therefore be a meaningful regression, not a cosmetic merge loss. This review does not claim the new browser smoke would detect it; the helper branch bypasses normal application boot.

## What the old Windows acceptance does and does not prove

The archived acceptance is tied to commit `6c2b0b57f7d3177a777acab081411db539362416`, the Next 16.3.8 installer, and SHA-256 `803d75472238f95f239f535f74a9fdb76b012ba862dbcb6e9952210ecbeb5b20`. It is not a test of upstream 0.3.2 or a future integrated fork. Source: [build identity](local-evidence.md#local-046).

The owner reported successful installation/start, cancellation, desktop subscription response, same-instance browser synchronization, restart persistence, offline failure/manual recovery and disconnect/data preservation. Those remain valid historical results for that installer. No updater menu entry existed, so updater runtime behavior was explicitly not tested. Sources: [owner receipt](local-evidence.md#local-048).

The accepted minimal `OK` exchange does not exercise these newly exposed boundaries:

- standalone Puppeteer import without checkout dependency fallback;
- bundled Chromium without system Chrome fallback;
- actual CDP readiness before the handshake;
- helper survival under Windows stdin behavior;
- disconnect during startup, parent death and observed helper cleanup;
- subscription demo generation followed by real browser verification.

These are missing coverage claims, not a finding that the owner misreported acceptance. The acceptance document itself excludes proof of other model-generation roles and full learning workflows. Source: [recorded limitations](local-evidence.md#local-047). Existing results should not be rewritten as failed, nor carried forward as a pass for different binaries.

## Conclusion and unresolved questions

**Research judgment.** The three browser fixes merit evaluation together if a later integration is authorized. They add missing standalone import and helper lifecycle checks that the minimum subscription acceptance did not cover. They do not require discarding the subscription implementation, and this static review found no competing edit in its OAuth/store/API code. Keep the IPC parent and child, readiness module, tracing include and related packaging checks coherent.

**Still unverified:** the exact missing-file state of the accepted Windows payload, behavior with the fork's pinned Next and current dirty dependency changes, the textual result of a real merge, packaged updater-disabled behavior after integration, production subscription demo end-to-end behavior, and the new upstream workflow's actual pass status. No CI status, test count or runtime-compatibility claim is inferred from test source files.

No execution or integration is authorized by this note. The next decision belongs to the owner or parent agent: whether to request a separate integration plan and bounded validation. This report does not perform that work.
