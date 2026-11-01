# Hello plugin

Copy this directory into the plugins directory shown in **Settings → Plugins**,
refresh, and enable **Hello plugin**. Nothing is installed or enabled automatically.

This minimal frontend-only example registers a `hello` view and a separate `open`
action. Explicit placements expose the action in the sidebar, graph, and teaching /
practice session top bars. Registering a view or action alone adds no chrome.

Open the view and click **Say hello** to see a host-owned button and standard dialog
with plugin-owned DOM content. All widgets receive the view's `{ signal }`, so closing
the view or disabling the plugin tears them down. The custom settings mount is just
explanatory text: there are no invented schema settings, backend, or model requests.
