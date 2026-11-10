# LearnHarness plugin authoring skill

This is the **whole skill**, not just its `SKILL.md` instructions. The downloaded
`learnharness-plugins/` folder contains documentation, three no-build example plugins,
and the type-only public API SDK. No repository clone or internet connection is needed
to read the materials or try the Hello plugin. Model-using examples require your
configured connection and may incur cost when explicitly run.

## Give it to your coding agent

1. In LearnHarness, open **Settings → Community plugins → Download authoring skill**.
2. Extract the ZIP somewhere writable. Keep the entire `learnharness-plugins/` folder.
3. Give your coding agent the folder path and this instruction:

   > Read `/path/to/learnharness-plugins/SKILL.md`. Use the bundled documentation,
   > examples and API types to help me build a LearnHarness plugin. Ask me about
   > product behavior before implementing it.

Start with [the skill instructions](SKILL.md), then the authoring guide they link to.
To make the skill automatically discoverable, put the **whole folder** in your
coding agent's supported skills directory, following that agent's documentation.
Agents use different project/global locations and may require a reload or explicit
activation. LearnHarness does not choose a location or install/configure an agent.
If the agent has no skills feature, the explicit file-path instruction still works.
Copying only `SKILL.md` breaks access to its supporting materials.

The extracted examples are authoring material, not already-installed plugins.
Follow the guide to copy an example into the writable plugins directory; do not
install the entire skill folder as a LearnHarness plugin.

## Compatibility

Read `bundle.json` for the producing **app version**, **plugin API version** and
**SDK package version**. These are different version numbers. API v1 can gain
capabilities without changing its API number; use the documentation and types from
the app you are targeting, rather than assuming every API-v1 host has every feature.

The exported example manifests conservatively require at least the producing app
version. For your own plugin, choose an older `minAppVersion` only after checking
that the older app supplies every capability you use. After an app update, download
a fresh matching skill when you want to use new APIs. This bundle does not promise
forward compatibility or change the host's compatibility rules.

## What's included

- `SKILL.md`: coding-agent entry point and guardrails.
- `docs/`: the canonical authoring guide, feature contracts and host architecture.
- `tools/install-plugin-local.mjs`: a dependency-free helper for outside-workspace
  installation. The authoring guide documents the explicit-path npm command.
- `examples/plugins/`: Hello plugin, Managed agent and Teaching extension.
- `types/`: the local `learnharness-plugin-api` type-only package. It has no runtime
  exports; TypeScript projects must supply its declared peer dependencies during
  development. The app never installs dependencies for a plugin.
- `bundle.json`: version information for these exact materials.
- `LICENSE`: the existing LearnHarness AGPL license, including for the example code.

Keep these directories together. Bundlers and repository-only maintainer tests
are not included. Plugin builds, coding-agent setup and any paid/model work remain
separate actions under your control.
