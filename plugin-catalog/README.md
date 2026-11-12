# Community plugin catalog

LearnHarness displays this reviewed catalog in **Settings → Community plugins → Browse plugins**. The app fetches `catalog.json` from the `main` branch, so a merged listing can appear without a new app release. The catalog starts empty; Core plugins remain in their separate settings section.

## Submit a plugin

1. Publish source in a public GitHub repository and a prebuilt ZIP on that repository's GitHub Releases page. The ZIP must contain `dist/manifest.json` and its built sibling files under one top-level `dist/` folder. Do not include plugin data, dependencies, credentials or source-only packages.
2. Open a dedicated public issue in `amosblomqvist/learnharness` for discussion and recommendations. The issue's comments and 👍 reactions appear in the app. Treat issue content as public.
3. Add one entry to `catalog.json` in a pull request. Include the plugin ID, name, summary, feature tags, version, minimum app version, source repository URL, direct release ZIP URL, lowercase SHA-256 of the ZIP, and the issue number. The manifest ID, name, version and minimum app version must match the catalog entry. The plugin ID cannot be a reserved Core ID.
4. Explain how you tested the ZIP with the stated LearnHarness version and include any third-party licenses in the package.

The catalog is a reviewed directory, not a security sandbox or a guarantee that plugin code is safe. Reviewers should inspect source, build output, compatibility and provenance before merging. New installations remain disabled until the user enables them. Updates require disabling an enabled plugin and restarting LearnHarness after replacement. The installer replaces only `dist/`; it preserves sibling `data/`.

Example shape (replace every example value before submission):

```json
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "summary": "A short description of what the plugin does.",
  "features": ["Drawing"],
  "version": "1.0.0",
  "minAppVersion": "0.6.0",
  "sourceUrl": "https://github.com/example/example-plugin",
  "releaseUrl": "https://github.com/example/example-plugin/releases/download/v1.0.0/example-plugin.zip",
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "issueNumber": 123
}
```
