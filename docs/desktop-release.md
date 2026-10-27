# Desktop builds and releases

## Platforms

| Platform | Build runner | Packages | In-app update |
|---|---|---|---|
| macOS, Apple Silicon | `macos-26` (arm64) | signed/notarized DMG + ZIP | ZIP via Squirrel.Mac |
| macOS, Intel | `macos-15-intel` (x64) | signed/notarized DMG + ZIP on tag releases | ZIP via Squirrel.Mac |
| Windows, x64 | `windows-2025` | unsigned per-user NSIS installer | NSIS |
| Linux, x64 | `ubuntu-24.04` | AppImage + `.deb` | AppImage replacement; `.deb` through dpkg/apt with elevation if needed |

Windows signing is deliberately disabled for this first release. SmartScreen may warn about an unknown publisher on initial installation. AppImage is the primary Linux download because it is self-contained and updates without administrator permission. The installed `electron-updater` 6.8.9 also supports `.deb` updates; an update may request an administrator password. Both use the same download/restart banner.

The custom app bar stays on all three platforms. macOS keeps its left-side traffic lights; Windows/Linux use Electron's native right-side Window Controls Overlay, with CSS space reserved from the overlay's actual geometry. Windows/Linux hide the native menu until Alt is pressed. macOS keeps its system menu.

Icons are architecture-specific on macOS. **Apple Silicon is unchanged:** `build/icon.icon` is compiled with actool into `Assets.car` for the layered Liquid Glass icon; `scripts/after-pack.cjs` replaces the low-resolution fallback with full-resolution `build/icon.icns`. This build requires **macOS 26+ and Xcode 26+**. **Intel uses the existing static `build/icon.icns`**, including on macOS 26, without Icon Composer or full Xcode. Windows embeds `build/icon.ico`; Linux uses `build/icon.png`. Both are generated from `build/icon-flat.svg` by `node scripts/make-icons.mjs`. Linux's desktop identity remains `learnharness.desktop`; support goes through [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues).

The pinned Electron 44.9.3 declares macOS 13 (Ventura) or newer. Its Intel bundle has `LSMinimumSystemVersion=13.0`; the inspected x64 Skia/resvg binaries target 10.13, and sharp/libvips target 10.15. These are dependency minimums, **not a tested support matrix**. No new minimum is imposed by this contribution. Intel CI uses the [available `macos-15-intel` runner](https://github.com/actions/runner-images#available-images); local hardware verification and remaining release gates are recorded below.

## Build pipeline

Each OS **and CPU architecture** installs locked dependencies with Node 26 and builds its own Next standalone tree:

1. `npm ci`
2. Native PDF/SVG renderer tests for that OS, running in Electron's bundled Node (no display needed).
3. `npm run build` (`output: "standalone"`).
4. `node scripts/smoke-provider-runtime.mjs`, then `node scripts/build-server.mjs` — verify offline provider initialization, copy static assets, refuse leaked data/keys, remove known standalone-root build inputs (installers, development Electron, tests, tooling, artwork, build configuration), and check prompt assets. Runtime dependencies' own directories, native binaries, prompts, and licenses stay intact.
5. `node scripts/smoke-server.mjs --electron` — boot the standalone server in Electron's bundled Node, using empty temporary data/auth, then check the home route and GET-only APIs.
6. `npx electron-builder <platform flags> --publish <policy>`.

The shell/updater live in `app.asar`; the standalone server and native renderer binaries ship unpacked as `extraResources`. **Do not cross-build the server payload, including between Mac architectures.** Next traces the build machine's native binaries. `scripts/before-pack.cjs` rejects a macOS target that differs from either Node or the physical host architecture, including x64 Node under Rosetta. There is no Universal build.

### Local unsigned Intel build

On a native Intel Mac, with Node 26 and Command Line Tools:

```sh
npm ci
npm run desktop:dist:mac:x64:unsigned
```

This command cleans `dist/` and the old standalone tree, builds and smokes the native server, disables signing identity discovery and notarization, and explicitly uses `--publish never`. It requires no signing credentials. Outputs are `dist/mac/LearnHarness.app`, `dist/LearnHarness-<v>-x64.dmg`, `dist/LearnHarness-<v>-x64-mac.zip`, their two `.blockmap` files, and an **x64-only staging** `dist/latest-mac.yml`. That partial feed must never be uploaded as the public channel.

`electron-builder.mac-x64.yml` extends the production configuration, overriding only icon, native target, and names. Its single `default` target object is intentional: the pinned builder concatenates inherited target arrays; the object replaces the arm64 array, and Electron's default expands to ZIP + DMG. Signing/notarization stay enabled unless the unsigned command explicitly overrides them.

The unsigned artifacts are local rehearsals, not official releases or proof of Gatekeeper/notarization acceptance. Do not install over an existing app or test against its profile. The packaged shell derives child `LH_DATA_DIR`/`LH_AUTH_FILE` from Electron `userData`; those environment variables alone do **not** isolate it. Launch a disposable installed copy with an absolute `--user-data-dir=/path/to/disposable-profile`, a credential-free environment, and the existing `LH_UPDATE_FEED` seam pointing to a local feed. Confirm the logged data directory before interaction.

`npm run desktop:dist` remains the native arm64 local signing/notarization path using the `LH_NOTARY` keychain profile, with publishing explicitly disabled. Tag-release signing for both Mac architectures remains mandatory. For Windows/Linux, run steps 1–5 above, then:

```sh
# On Windows:
npx electron-builder --win --x64 --publish never

# On Linux:
npx electron-builder --linux --x64 --publish never
```

## CI vs release

`.github/workflows/ci.yml` runs on main pushes and pull requests:

- Typecheck, full deterministic test suite, and lint on Ubuntu.
- Native renderer tests plus standalone build/boot-smoke on macOS arm64 (`macos-15`), macOS x64 (`macos-15-intel`), Windows, and Linux. Only arm64 release packaging compiles Icon Composer and needs the newer runner.

`.github/workflows/release.yml` has two deliberately separate modes:

- **Manual / Run workflow:** unsigned rehearsal installers saved as workflow artifacts for 7 days. No signing secrets, no release creation, and no release uploads. Both Mac stages must pass packaged smokes and the combined-feed finalizer. These are not production macOS installers.
- **Push `v<package.json version>`:** quality gates, then one job prepares the tag's **single draft GitHub Release**. Four native packaging legs run; both Mac legs sign/notarize with `forceCodeSigning=true` but use `--publish never`. Windows/Linux retain their direct draft uploads. A published or ambiguous release fails preparation. Runs for the same ref are serialized, never cancelled mid-upload. Publishing remains a human action.

### One macOS feed, one publisher

`finalize-mac` waits for every packaging leg, including both Mac packaged smokes. It downloads `learnharness-mac-arm64` and `learnharness-mac-x64` into separate directories, then runs:

```sh
npx tsx scripts/finalize-mac-update.ts <arm64-stage> <x64-stage> <empty-output-dir>
```

Each stage must contain exactly its versioned DMG/ZIP, their two nonempty blockmaps, and `latest-mac.yml`. The local-only helper checks names, version, sizes, actual SHA512 hashes, complete architecture membership, legacy fields, and optional metadata agreement. Duplicate/conflicting entries, stale extras, unsafe references, symlinks, overlapping stages/output, or nonempty output fail closed. It never guesses repairs or makes network requests.

The combined feed contains both architectures' DMGs/ZIPs, preserving the arm64 ZIP as the first entry and backing the legacy top-level `path`/`sha512`. The actual pinned updater filters by architecture before choosing the ZIP. The finalizer is the **only macOS release uploader**: installers/blockmaps first, complete `latest-mac.yml` last. Rehearsals save the combined output only. Windows/Linux retain `latest.yml` / `latest-linux.yml`. **A partially populated draft is never fit to publish.** End-user update downloads are anonymous; do not embed a GitHub token.

### The verification job

`verify` runs only on tag pushes, after both `package` and `finalize-mac`; rehearsals create no draft and skip it. It checks out the tagged revision without persisting credentials and runs `scripts/verify-release.ts`. GitHub requires push access to list **draft** releases, so this job needs `contents: write` even though every API operation is GET-only. The token is exposed only to the release-list and feed-download steps, not dependency installation or the offline validator. The validator:

- finds the draft using the same tag matching as the draft job and electron-builder's publisher — `tag_name` equals `v<version>` **or** the bare `<version>`; zero matches, two matches, or an already-published match fail the run, and a draft matched only via the unprefixed form is flagged with a warning (a later run could create a second draft under the `v`-tag and split the assets — rename before publishing);
- fails unless the release holds **exactly** these 15 assets — nothing missing, extra, zero-size, or still in a non-`uploaded` state:

| Asset | Role |
|---|---|
| `LearnHarness-<v>-arm64.dmg` + `.blockmap` | Apple Silicon installer; existing name preserved |
| `LearnHarness-<v>-arm64-mac.zip` + `.blockmap` | Apple Silicon updater payload; existing name preserved |
| `LearnHarness-<v>-x64.dmg` + `.blockmap` | Intel installer |
| `LearnHarness-<v>-x64-mac.zip` + `.blockmap` | Intel updater payload |
| `LearnHarness-<v>-x64-setup.exe` + `.blockmap` | Windows NSIS installer |
| `LearnHarness-<v>-x86_64.AppImage` | Linux AppImage (no sidecar blockmap) |
| `LearnHarness-<v>-amd64.deb` | Linux deb (no sidecar blockmap) |
| `latest-mac.yml` / `latest.yml` / `latest-linux.yml` | updater feeds |

  (Linux names retain the builder's target-specific architecture expansion: `x86_64` for AppImage, `amd64` for deb. The verifier fails closed if the base configuration or x64 overlay changes the verified naming/target contract.);
- downloads all three feeds and checks their package version, exact asset membership, bare local names, API-reported sizes, plausible SHA512 values, and legacy-field agreement. The macOS feed must contain **both** architectures with the arm64 ZIP first. Actual macOS artifact hashes are checked before upload by the finalizer, not inferred from the release listing.

The job only reads (release list + asset downloads); it never creates, edits, publishes, or deletes anything.

## macOS CI secrets

Add these under repository **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application `.p12` backup, including its private key |
| `MAC_CSC_KEY_PASSWORD` | Password protecting that `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | `JS6XN22HY6` |

The workflow maps the certificate secrets to electron-builder's `CSC_LINK` / `CSC_KEY_PASSWORD`. GitHub's built-in `GITHUB_TOKEN` supplies `GH_TOKEN` with job-scoped `contents: write`; no separate GitHub token secret is required. Signing credentials are present only for the packaging step, not the Next build. Never commit certificates, passwords, or `.env.local`.

## First release runbook

1. With owner authorization, push the implementation and run CI plus the manual Desktop release rehearsal.
2. Exercise install/open, window controls, navigation, settings persistence, native PDF/SVG rendering, and the packaged demo helper on **both Mac architectures**, Windows, and Linux. Isolate profiles; authorize live-service keys/microphone use separately.
3. Configure macOS signing/notarization secrets. Rehearsal overrides must never be copied into tag-release steps.
4. Bump `package.json` and the lockfile to the agreed version, run local gates, and push the matching tag with authorization.
5. Wait for **all four packaging legs, Finalize macOS update feed, and Verify draft release**. The draft must have the exact 15-asset inventory and complete feeds. Fix failures before publication; do not bypass the final gate.
6. Verify both Mac signatures, notarization tickets, and Gatekeeper behavior. Exercise a real signed Intel version-to-version update with data preservation and confirm that existing arm64 clients still receive arm64 updates.
7. The maintainer updates the separate website/download labels to distinguish **Apple Silicon** and **Intel**, then decides whether to publish the complete draft. Repository changes do not update that publication surface.

### Acceptance gates

- **Locally verified implementation:** native Intel DMG-installed launch/relaunch, isolated data, native rendering/helpers, generated-feed selection, payload audit, and applicable local checks pass.
- **CI/review readiness:** additionally requires authorized Intel/arm64/Windows/Linux CI and non-publishing packaging rehearsal evidence. Local code reviewability alone does not pass this gate.
- **Official release readiness:** additionally requires maintainer signing/notarization/Gatekeeper checks, the actual complete draft, signed update/data-preservation checks on both Mac architectures, and publication-label handoff.

Offline provider initialization is not a live model/Tavily/dictation test. Feed-selection evidence is not an end-to-end upgrade. A pass on one Intel Mac is not a claim about every dependency-supported macOS version.

### Intel contribution verification record

For issue [#168](https://github.com/amosblomqvist/learnharness/issues/168), the local unsigned `0.3.8` build was exercised on **Intel x86_64, macOS 26.7.1 (25G241)**, using Node 26.12.1 and pinned Electron 44.9.3 (bundled Node 24.22.0). This is one tested host, not a broader macOS support claim.

- Mounted the generated DMG read-only, copied the app into a disposable install directory, and launched that copy three times. Verified packaged `userData` and child data/auth paths before interaction; each launch used its own loopback server. Home, practice navigation, Settings, and the automatic-update setting persisted across quit/relaunch. No provider keys were entered.
- Exercised native minimize/restore, zoom, fullscreen enter/leave, and close through the actual Electron window. After switching the local tiling manager to floating mode, verified stable 1440×900 dimensions, zoom to 2560×1410, and restoration to the original bounds. Native-window screenshots include macOS traffic lights. App quits exited cleanly and left no server/helper process; the server child had no separate Dock entry. No application window code was changed.
- All 18 Mach-O files in the installed bundle were x86_64, including the PDF/SVG native modules. Actual packaged PDF/SVG rendering and the browser demo helper passed. The static Intel icon matched `build/icon.icns`; no `Assets.car` was included. Payload/archive audits found no forbidden data/credential/build roots, external symlinks, or references to the protected installation.
- Finalized a local combined-feed rehearsal from the generated x64 artifacts and the published `0.3.8` arm64 artifacts. The real pinned updater selected the respective x64/arm64 ZIPs; its selection/resolver sources matched the released arm64 client's sources byte-for-byte. This was offline selection evidence, **not an installed signed update**.
- Typecheck, lint, workflow syntax validation, 105 focused regressions, 18 native Electron regressions, production/provider/server/demo smokes, and offline web-subscription smokes passed. With `TZ=UTC`, the full suite passed **2372/2372**. In the host's `America/Toronto` timezone it passed **2371/2372**: unchanged `tests/render-sidebar.test.tsx:86` assumes a UTC calendar date for `2026-01-02T01:00:00Z`, whereas the existing formatter uses local dates. That unrelated failure was isolated and left unchanged; the default-timezone suite is not all-green. Four existing Next whole-project tracing warnings remain.

Local artifacts/evidence are retained under `dist/`, including `verification/`, the packaged screenshot, checksums, and a local PR-description draft. These are disposable build outputs, not committed release assets. The unsigned bundle is intentionally not code-signed or notarized. Cross-platform CI/rehearsal, maintainer signing/Gatekeeper checks, a complete real release draft, signed version-to-version updates, and website labels remain pending their respective authorization/platform/credential prerequisites. Live provider/Tavily calls and microphone dictation were not authorized or exercised.

A human platform pass is required for changes to `electron/`, native modules, packaging/updater configuration, or Electron itself. Content-only changes can use the deterministic suite and native build/boot-smoke matrix.
