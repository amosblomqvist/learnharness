# Community plugin catalog v1

Edit `community-plugins.json` **here**, in the app repository. The website keeps an exact deployment mirror, not a second list. The desktop Browse panel and `/plugins/` read the same public feed at `https://learnharness.ai/community-plugins.json`.

```sh
./node_modules/.bin/tsx scripts/sync-community-catalog.ts <website-checkout>
./node_modules/.bin/tsx scripts/sync-community-catalog.ts --check <website-checkout>
```

The sync command also generates `plugins/catalog-contract.js` from the desktop parser and Core ID list. Check in both outputs; `--check` verifies both byte-for-byte. Use the existing website deployment path after separately authorized publication. Catalog changes are independent of desktop releases. For initial rollout, deploy and verify the website feed before distributing the app feature. Create the `community-plugin` label in the app repository before launch so listing reports can be labeled. GitHub may require sufficient permissions to apply labels to a new issue; the issue still carries the ID and source in its body.

## Listing format

The public UTF-8 JSON object has `schemaVersion: 1` and a `plugins` array. Each item has `id`, `name`, `author`, `description`, `repository` (`owner/name` on GitHub), and `releases`. Use existing manifest display fields where available and credit the repository author when the manifest omits `author`. Core IDs are reserved. Seeded from the [awesome list by RA!DEN (tn-lorenz)](https://github.com/tn-lorenz/awesome-learnharness); thanks to the plugin authors.

For each verified package, record `version`, `apiVersion`, `minAppVersion`, UTC `publishedAt` (`YYYY-MM-DDTHH:mm:ssZ`), GitHub release `tag` (version with optional `v`), exact uploaded ZIP `asset` filename, and `sha256` (64 lowercase hex digits for the exact public download). Record only public stable GitHub Releases whose uploaded asset, digest, manifest, compatibility and built entry files have been verified. Do not list GitHub-generated source archives. A listing is not a code review or a safety endorsement. `releases: []` shows a source link but no Install; this is initially true of Meme Plugin (no package) and Activity heatmap (nonportable backslash archive paths).

The supported archive has built files at ZIP root or inside the exact `<id>/dist/` prefix. `manifest.json` identifies the plugin, version, minimum app and plugin API. Only built root files and the `assets/` tree are installed, not package wrappers, plugin data, or nested documentation. Use portable slash-separated paths and ordinary stored/deflated ZIP files (no links, encryption, ZIP64, or conflicting names). Compressed downloads are capped at 16 MiB; expanded entries are capped at 48 MiB total and 16 MiB per file. Use the application’s existing `dist/` build convention; there is no npm install or source build on the user's machine.

## Install, update, and removal

The desktop picks the highest compatible version, fetches the current catalog again when the user initiates installation, and downloads the pinned asset directly from GitHub. Install leaves the plugin off. Updates require a disabled, unchanged catalog installation from the same repo, replace only `dist/`, and require restart and explicit Enable. The host preserves its existing plugin-code lifetime model: turning community plugins off disables host registrations and invokes cleanup. It is not a sandbox and cannot undo side effects or stop arbitrary third-party code that ignores cleanup. If in doubt, turn community plugins off and restart.

Publication is serialized within a single host, not across processes or editors sharing the same profile. Do not modify plugin files or run a second host against the same data root during an update. Validation and rename are not a filesystem compare-and-swap. A caught publication failure attempts rollback, but a crash between local renames can leave `.catalog-stage-*/old-dist` in the plugins directory, potentially with no live `dist/`. Before any manual recovery, close all hosts for that profile; preserve both the staging directory and plugin data until the installed build and state are understood. Staging dirs are never loaded as plugins.

Delist by removing the item or unsupported release from this file and syncing/deploying the mirror. The desktop has no offline install fallback: a delisting takes effect for subsequent catalog installs after the new feed is served. It does not disable, revoke, or erase any existing local copy. Ordinary plugin bugs belong to the author; listing errors go to the LearnHarness issue link; suspected malicious plugins or security problems go through [private reporting](../SECURITY.md).
