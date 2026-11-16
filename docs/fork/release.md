# Fork releases

[日本語](release.ja.md)

## Fork version

The fork patch is the upstream patch multiplied by 100 plus a fork sequence number from 1 to 99. Calculate it with `npx tsx scripts/fork-version.ts <upstream> <n>`. Reset the sequence to 1 when incorporating a new upstream version. On `x.y.0`, start at `x.y.1`: for example, `0.5.0` with 1 gives `0.5.1`, and `0.6.1` with 1 gives `0.6.101`.

## Release

Before the first tag, enable Actions in the fork's Actions tab. Check Settings → Actions → General → Workflow permissions: the fork default is read, and the jobs request `permissions: contents: write` where needed. Run `release.yml` with `workflow_dispatch` once as a Windows rehearsal; it does not publish a release.

1. In the pull request, set the version in both package files with `npm version <version> --no-git-tag-version`, and commit the changes.
2. Merge the pull request into `main`. You do not create or push a tag yourself.
3. Actions runs decide → quality → draft → Windows package → verify (installer, blockmap, and `latest.yml`) → publish. The quality job first checks that the version follows the fork rule above, and the draft job creates the `v<version>` tag on the merged commit after the gates pass. A successful run publishes automatically.

A merge that does not change the version releases nothing: the decide job sees that `v<version>` is already published and skips the other jobs. If `v<version>` already exists on another commit without a published release, the run fails; bump the version, or abandon that tag and draft as described below. Pushing a matching `v<version>` tag by hand still starts a release, as before.

If a later gate fails, the draft remains unpublished. Inspect the run and draft. For a transient failure, rerun the workflow; it reuses the existing tag and draft, so remove stale or duplicate assets if needed. If the tagged code needs a fix, abandon the draft and tag, commit the fix, and create a new version and tag. To abandon them, delete the draft release in GitHub and delete the tag both remotely (`git push origin --delete v<version>`) and locally (`git tag -d v<version>`). A published release is refused by the draft job; do not treat it as a reusable draft.

## Local build

Build on Windows with `npm run desktop:dist:win`. The output is `dist/LearnHarness Fork-<version>-x64-setup.exe`; the name on Releases replaces spaces with hyphens. The installer is unsigned, so SmartScreen may warn.

## Auto-update

The fork updates only from [reeschan/learnharness Releases](https://github.com/reeschan/learnharness/releases). The repository must remain public for updates.

## Move data from upstream LearnHarness

The fork starts with empty data and does not move upstream data automatically.

1. Close both apps.
2. Copy `%APPDATA%\LearnHarness\data` to `%APPDATA%\LearnHarness Fork\data`. Existing fork data at the destination can be overwritten. For example, in Windows Command Prompt:

   ```bat
   robocopy "%APPDATA%\LearnHarness\data" "%APPDATA%\LearnHarness Fork\data" /E
   ```

3. Open the fork and check the copied data. Decide separately whether to copy credential files beside `data`: `auth.json` (API keys), `chatgpt-credentials.json`, `github-copilot-credentials.json`, and `xai-credentials.json`. These files contain sensitive credentials; keep them private. Do not copy `logs` or Electron's internal folders.
