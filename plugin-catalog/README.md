# Community plugin catalog v1

Edit `community-plugins.json` **here**, in the app repository. The website keeps an exact deployment mirror, not a second list. Browse (in the desktop Settings) and `/plugins/` read the same public feed at `https://learnharness.ai/community-plugins.json`.

```sh
./node_modules/.bin/tsx scripts/sync-community-catalog.ts <website-checkout>
./node_modules/.bin/tsx scripts/sync-community-catalog.ts --check <website-checkout>
```

The sync command also generates `plugins/catalog-contract.js` from the desktop parser and Core ID list, and copies each `details/<id>.json` to `community-plugins/<id>.json`. Check in all outputs; `--check` verifies them byte-for-byte. Sync fails if the feed's featured flags differ from `featured.json`, or if `details/` doesn't hold exactly one file per listing. Use the existing website deployment path after separately authorized publication. Catalog changes are independent of desktop releases. For initial rollout, deploy and verify the website feed before distributing the app feature. Create the `community-plugin` label in the app repository before launch so listing reports can be labeled. GitHub may require sufficient permissions to apply labels to a new issue; the issue still carries the ID and source in its body.

## Listing format

The public UTF-8 JSON object has `schemaVersion: 1` and a `plugins` array. Each item has `id`, `name`, `author`, `description`, `repository` (`owner/name` on GitHub), `downloads`, `listedAt`, and `releases`. `downloads` is the sum of the GitHub `download_count` of each listed release ZIP when the feed was built. `listedAt` is the UTC time the plugin first entered the feed (same format as `publishedAt`), and it never changes afterwards; the first nine listings were backfilled with their oldest GitHub release date. Browse sorts Most downloaded by `downloads` and Newest by `listedAt`. Use existing manifest display fields where available and credit the repository author when the manifest omits `author`. Core IDs are reserved. Seeded from the [awesome list by RA!DEN (tn-lorenz)](https://github.com/tn-lorenz/awesome-learnharness); thanks to the plugin authors.

For each verified package, record `version`, `apiVersion`, `minAppVersion`, UTC `publishedAt` (`YYYY-MM-DDTHH:mm:ssZ`), GitHub release `tag` (version with optional `v`), exact uploaded ZIP `asset` filename, and `sha256` (64 lowercase hex digits for the exact public download). A release may carry `featured: true`. It is copied from `featured.json` and nothing else sets it.

Record only public stable GitHub Releases whose uploaded asset, digest, manifest, compatibility and built entry files have been verified. Do not list GitHub-generated source archives. A listing is not a code review or a safety endorsement. `releases: []` shows a source link but no Install; this is initially true of Meme Plugin (no package) and Activity heatmap (nonportable backslash archive paths).

The supported archive has built files at ZIP root or inside the exact `<id>/dist/` prefix. `manifest.json` identifies the plugin, version, minimum app and plugin API. Only built root files and the `assets/` tree are installed, not package wrappers, plugin data, or nested documentation. Use portable slash-separated paths and ordinary stored/deflated ZIP files (no links, encryption, ZIP64, or conflicting names). Compressed downloads are capped at 16 MiB; expanded entries are capped at 48 MiB total and 16 MiB per file. Use the application’s existing `dist/` build convention; there is no npm install or source build on the user's machine.

## Checks

`npm run catalog:check` runs on every pull request that touches this folder (`.github/workflows/plugin-catalog.yml`) and can be run locally. For every listed release it downloads the pinned asset, verifies it exactly as Install does (sha256, archive, manifest, entry files), and scans the files Install would write. It fails on:

- `release-invalid`: the download, checksum, archive or manifest does not verify;
- `native-binary`: native or executable files, by signature (ELF, PE, Mach-O, WebAssembly) or type (`.node .exe .dll .so .dylib .wasm .jar .msi .sh .bash .bat .cmd .ps1`);
- `obfuscation`: in scripts, `eval(…)`, `new Function(…)`, `Function("…")` or string timers, 20+ javascript-obfuscator `_0x…` names, or a 4096+ character base64/hex blob that is not an image or font `data:` URI (ordinary minified bundles pass);
- `secret`: provider keys and tokens (Anthropic, OpenAI, OpenRouter, Groq, xAI, Google, Hugging Face, Tavily, Firecrawl, Deepgram, GitHub, AWS, Slack), private-key blocks, or a hard-coded `*_API_KEY`/`*_TOKEN` value; reports show only the first 4 characters;
- `malicious-dependency`: a package in the repository's `package-lock.json` at the release tag (dev dependencies included) has an OSV malware advisory (`MAL-…`); ordinary CVEs do not fail;
- `missing-lockfile`: the repository has a `package.json` but no `package-lock.json` at the tag. A repository with no `package.json` has no npm dependencies to check.

These checks gate a listing; they are not a review and do not make plugin code safe. A maintainer can approve a specific hit in `check-exceptions.json` with `id`, `version`, `rule`, optional `file`, and a written `reason`. An exception excuses only that release, so a new version is checked afresh, and an exception that no longer matches anything fails the run until it is removed.

## Discovery

Listings are found automatically. `npm run catalog:discover` (`.github/workflows/plugin-catalog-discovery.yml`, daily and on demand) looks at every repository with the GitHub topic `learnharness-plugin` and every repository already listed here. For each one it takes the newest stable GitHub Release (not a draft or prerelease) and lists it only if:

- the release has exactly one uploaded `.zip` asset, whose download matches GitHub's digest;
- the tag is the manifest version, with or without a leading `v`;
- the package verifies as Install does and passes every check above, or a maintainer excused the hit in `check-exceptions.json`.

A new listing takes `name` from the manifest, `author` from the manifest or else the repository owner, and `description` from the manifest or else the GitHub repository description. An id that is a Core id, already listed for another repository, or claimed by two new repositories in the same run is skipped until a maintainer edits this file. Existing listings keep their name, author and description; discovery only adds a release, newest first, and keeps at most 24 by dropping the lowest version. Discovery never removes anything: a listed repository or release that is gone, archived or changed is reported under "Needs attention", and delisting stays manual.

The workflow keeps one rolling pull request from `bot/community-catalog-discovery` whose body is the run's report (added, failed checks, needs attention, skipped). A maintainer merges it; merging lists the releases and is not a code review. The job that parses plugin archives has a read-only token; a second job opens the pull request. A repository admin must turn on Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests". Pull requests opened with the built-in token do not trigger `plugin-catalog.yml`, so the checks run in the discovery job, again on every push to main, and on demand on the bot branch with Run workflow. Run discovery locally with `GITHUB_TOKEN` set for higher API limits; it rewrites `community-plugins.json` in place and `--report <file>` writes the report.

## Featured

`featured.json` (`{ "schemaVersion": 1, "featured": [{ "id", "sha256" }] }`) lists the releases a maintainer has reviewed. Only maintainers edit it, and auto-discovery never writes it. Featured is the only human-reviewed, endorsed tier. Browse shows the Featured mark only when the release it would install is a reviewed one. A newer, unreviewed release drops the mark, and its detail page names the older version that was reviewed. Add the new release's `sha256` after reviewing it.

## Details

`details/<id>.json` is a snapshot of the plugin's README at the newest listed release tag, plus the GitHub release notes for each listed version:

```json
{ "schemaVersion": 1, "id": "<id>", "readme": { "tag": "v1.0.0", "markdown": "…" }, "releases": [{ "version": "1.0.0", "notes": "…" }] }
```

`readme` is `null` when there is no release or no README. The tag and versions must exist in the listing. Each file is capped at 256 KiB, a README at 128 KiB, and each release's notes at 16 KiB. The desktop fetches a file only when someone opens a plugin's detail page in Browse. README images are never loaded: each one is shown as a link with its alt text, and relative links point at the repository at the snapshot tag.

## Install, update, and removal

The desktop picks the highest compatible version, fetches the current catalog again when the user initiates installation, and downloads the pinned asset directly from GitHub. Install leaves the plugin off. Updates require a disabled, unchanged catalog installation from the same repo, replace only `dist/`, and require restart and explicit Enable. The host preserves its existing plugin-code lifetime model: turning community plugins off disables host registrations and invokes cleanup. It is not a sandbox and cannot undo side effects or stop arbitrary third-party code that ignores cleanup. If in doubt, turn community plugins off and restart.

Publication is serialized within a single host, not across processes or editors sharing the same profile. Do not modify plugin files or run a second host against the same data root during an update. Validation and rename are not a filesystem compare-and-swap. A caught publication failure attempts rollback, but a crash between local renames can leave `.catalog-stage-*/old-dist` in the plugins directory, potentially with no live `dist/`. Before any manual recovery, close all hosts for that profile; preserve both the staging directory and plugin data until the installed build and state are understood. Staging dirs are never loaded as plugins.

Delist by removing the item or unsupported release from this file and syncing/deploying the mirror. The desktop has no offline install fallback: a delisting takes effect for subsequent catalog installs after the new feed is served. It does not disable, revoke, or erase any existing local copy. Ordinary plugin bugs belong to the author; listing errors go to the LearnHarness issue link; suspected malicious plugins or security problems go through [private reporting](../SECURITY.md).
