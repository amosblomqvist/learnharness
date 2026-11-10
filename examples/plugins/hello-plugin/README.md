# Hello plugin

Copy this directory into the plugins directory shown in **Settings → Community plugins**,
keeping the `hello-plugin/` folder and its required `dist/manifest.json`. No build is
needed. Refresh and enable **Hello plugin**. Edit runtime files in `dist/` and restart
LearnHarness after changing loaded code. Persistent data, if added, belongs in sibling
`hello-plugin/data/`, never `dist/data/`; preserve it when replacing `dist/`.
Nothing is installed or enabled automatically.

This minimal frontend-only example registers a `hello` view and a separate `open`
action. Explicit placements expose the action in the sidebar, graph, and teaching /
practice session top bars. Registering a view or action alone adds no chrome.

Open the view and click **Say hello** to see a host-owned button and standard dialog
with plugin-owned DOM content. All widgets receive the view's `{ signal }`, so closing
the view or disabling the plugin tears them down. The custom settings mount is just
explanatory text: there are no invented schema settings, backend, or model requests.
