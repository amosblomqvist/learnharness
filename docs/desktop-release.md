# Desktop builds and releases

## Platforms

| Platform | Build runner | Packages | In-app update |
|---|---|---|---|
| macOS, Apple Silicon | `macos-26` (arm64) | signed/notarized DMG + ZIP | ZIP via Squirrel.Mac |
| Windows, x64 | `windows-2025` | unsigned per-user NSIS installer | NSIS |
| Linux, x64 | `ubuntu-24.04` | AppImage + `.deb` | AppImage replacement; `.deb` through dpkg/apt with elevation if needed |

Windows signing is deliberately disabled for this first release. SmartScreen may warn about an unknown publisher on initial installation. AppImage is the primary Linux download because it is self-contained and updates without administrator permission. The installed `electron-updater` 6.8.9 also supports `.deb` updates; an update may request an administrator password. Both use the same download/restart banner.

The AppImage uses the static type2 runtime (`toolsets.appimage: "1.0.3"` in `electron-builder.yml`), so it starts without `libfuse.so.2`. electron-builder's default `"0.0.0"` toolset embeds the legacy AppImageKit runtime, which loads libfuse2 at startup and exits on hosts that don't ship it, such as Fedora and Ubuntu 22.04+ ([#84](https://github.com/amosblomqvist/learnharness/issues/84)). Mounting still needs a setuid `fusermount3` or `fusermount` on `PATH`; without one, the AppImage can run with `--appimage-extract-and-run`.

The custom app bar stays on all three platforms. macOS keeps its left-side traffic lights; Windows/Linux use Electron's native right-side Window Controls Overlay, with CSS space reserved from the overlay's actual geometry. Windows/Linux hide the native menu until Alt is pressed. macOS keeps its system menu.

Icons are per-platform (2026-10-13): macOS compiles the Icon Composer document `build/icon.icon` via actool into `Assets.car` (macOS 26 Liquid Glass) plus a fallback icns that `scripts/after-pack.cjs` replaces with the hand-packed full-res `build/icon.icns` (actool's caps at 256px); Windows embeds `build/icon.ico` and Linux uses `build/icon.png`, both generated from the flat design (`build/icon-flat.svg`) by `node scripts/make-icons.mjs`. Building the mac icon needs **macOS 26+ and Xcode 26+** (`actool`): Xcode 26's asset compiler crashes on macOS 15 because its host frameworks lack required symbols. `desktop:dist` injects `DEVELOPER_DIR` locally; release packaging uses `macos-26` and selects Xcode via setup-xcode. The older-OS fallback icon remains included. Linux's desktop identity is `learnharness.desktop`. Public package-maintainer metadata uses the owner's GitHub no-reply address; support goes through [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues).

## Build pipeline

Each OS installs its own dependencies and builds its own Next standalone tree:

1. `npm ci`
2. Native PDF/SVG renderer tests for that OS, running in Electron's bundled Node (no display needed).
3. `npm run build` (`output: "standalone"`).
4. `node scripts/build-server.mjs` — copy static assets, refuse leaked data/keys, remove only standalone-root `dist/` and `node_modules/electron/` (old installers and the development runtime), check prompt assets. Runtime dependencies' own `dist/` directories and native renderer binaries stay intact.
5. `node scripts/smoke-server.mjs --electron` — boot the standalone server in Electron's bundled Node, using empty temporary data/auth, then check the home route and GET-only APIs.
6. `npx electron-builder <platform flags> --publish <policy>`.

The shell/updater live in `app.asar`; the standalone server and native renderer binaries ship unpacked as `extraResources`. **Do not cross-build the server payload.** Next traces the build machine's native binaries, so a macOS-built standalone tree is not a Windows/Linux payload.

`npm run desktop:dist` remains the local macOS signing path, using the `LH_NOTARY` keychain profile. For a local Windows/Linux build, run steps 1–5 above, then:

```sh
# On Windows:
npx electron-builder --win --x64 --publish never

# On Linux:
npx electron-builder --linux --x64 --publish never
```

## CI vs release

`.github/workflows/ci.yml` runs on main pushes and pull requests:

- Typecheck, full deterministic test suite, and lint on Ubuntu.
- Native renderer tests plus standalone build/boot-smoke on macOS (`macos-15`), Windows, and Linux. This macOS job does not compile the Icon Composer asset; only release packaging needs the newer runner.

`.github/workflows/release.yml` has two deliberately separate modes:

- **Manual / Run workflow:** unsigned rehearsal installers saved as workflow artifacts for 7 days. No signing secrets needed, no release created, and nothing published. macOS notarization is skipped. Use the Windows/Linux artifacts for the first human smoke pass. These are not production macOS installers.
- **Push `v<package.json version>`:** gates first, then one job creates or reuses a **single draft GitHub Release** before the three OS jobs package/upload their artifacts and update metadata in parallel. This avoids competing draft creation. A published or ambiguous existing release fails the preparation step instead of being modified. Separate runs for the same ref are serialized, never cancelled mid-upload. The tag must match the package version. macOS must sign and notarize successfully; missing secrets fail loudly. The workflow never publishes the draft. After all three packaging jobs succeed, a final read-only **Verify draft release** job (below) fails the run unless that draft is complete and self-consistent.

The three jobs upload distinct updater feeds: `latest-mac.yml`, `latest.yml`, `latest-linux.yml`, with the matching ZIP/NSIS/AppImage/deb assets and blockmaps. **A partially populated draft is never fit to publish — and the final job enforces it mechanically.** The app uses the baked GitHub feed without a token: **the repository must be public before end users can download updates.** Making the repository public and publishing the release remain the owner's actions.

### The verification job

`verify` runs only on tag pushes (`needs: package`, so after **all three** packaging legs; manual rehearsals upload nothing and skip it). It checks out the tagged revision without persisting credentials and runs `scripts/verify-release.ts`. GitHub requires push access to list **draft** releases, so this job needs `contents: write` even though every API operation is GET-only. The token is exposed only to the release-list and feed-download steps, not dependency installation or the offline validator. The validator:

- finds the draft using the same tag matching as the draft job and electron-builder's publisher — `tag_name` equals `v<version>` **or** the bare `<version>`; zero matches, two matches, or an already-published match fail the run, and a draft matched only via the unprefixed form is flagged with a warning (a later run could create a second draft under the `v`-tag and split the assets — rename before publishing);
- fails unless the release holds **exactly** these 11 assets — nothing missing, nothing extra (a stale name from an older run is an error), nothing zero-size, nothing still in a non-`uploaded` state:

| Asset | Role |
|---|---|
| `LearnHarness-<v>-arm64.dmg` + `.blockmap` | macOS installer |
| `LearnHarness-<v>-arm64-mac.zip` + `.blockmap` | macOS updater payload (Squirrel.Mac installs from the ZIP) |
| `LearnHarness-<v>-x64-setup.exe` + `.blockmap` | Windows NSIS installer |
| `LearnHarness-<v>-x86_64.AppImage` | Linux AppImage (no sidecar blockmap) |
| `LearnHarness-<v>-amd64.deb` | Linux deb (no sidecar blockmap) |
| `latest-mac.yml` / `latest.yml` / `latest-linux.yml` | updater feeds |

  (The Linux names are deliberate: the user-set `linux.artifactName` applies to both Linux targets, and `${arch}` expands per target — `x86_64` inside the AppImage, `amd64` in the deb — exactly what the installed app-builder-lib 26.15.3 emits. The script's expectations fail closed if `electron-builder.yml` drifts from these shapes.);
- downloads the three feeds from the draft and fails unless each parses, carries the `package.json` version, and references **exactly** the uploaded assets — by bare file name only (no paths, traversal, or URLs), with sizes matching the API-reported asset sizes, the ZIP first in `latest-mac.yml`, and the legacy top-level `path`/`sha512` backed by that first entry.

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

1. Push the implementation; run the manual Desktop release workflow.
2. Human smoke on Windows/Linux: install/open, window buttons and dragging, sidebar at narrow widths, zoom, setup/keys, session/resume, native PDF/SVG verification and demo helper. macOS remains signed/notarized through the production path.
3. Add macOS signing/notarization secrets.
4. Bump `package.json` and the lockfile to the agreed release version; run local gates and push a matching `v...` tag.
5. Wait for **all three** packaging jobs **and the final Verify draft release job** — the gate mechanically checks the draft's 11 assets and the three update feeds (single draft, right names/version/sizes/upload state, feeds referencing only what the release actually holds). If it fails, fix the cause and re-run the workflow before publishing; electron-builder replaces same-named assets on re-upload, and the gate rejects leftovers.
6. Owner makes the repository public, publishes the complete draft, then checks the real GitHub update path using a prior installed version.

A full human pass is required before the first three-platform release. Subsequent content-only updates rely on the deterministic suite plus the per-OS build/boot-smoke matrix. Changes to `electron/`, native modules, packaging/updater configuration, or Electron itself call for another platform smoke pass.
