# Desktop session views

The desktop app uses one server and multiple windows. Each window has one or two session panes. Each session has one visible owner across all windows.

Use **File > New Window** (`Cmd+Shift+N` on macOS, `Ctrl+Shift+N` elsewhere) to open an empty pane. Use the session sidebar actions to open a session beside the active pane or in another window. A normal session selection replaces the active pane.

If a session is already open, its window receives focus. **Move to New Window** transfers the pane. It keeps the pane ID and session state. Closing a view does not abort a server turn.

The active pane has a visible border. Pane commands apply to that pane. Below 1288 CSS pixels of available session width, the pane switcher selects the visible pane. The other pane stays mounted.

## State ownership

`electron/workspace.cjs` owns the window IDs, pane IDs, session assignments, divider positions, and saved view state. `electron/main.cjs` creates the native windows and applies the same request and permission guards to each window's persistent Electron session partition.

The preload exposes `window.lh.workspace`. Its methods accept session IDs and validated state. They do not accept navigation URLs or filesystem paths. The main process checks the sender before each operation.

The versioned `workspace-v1.json` file lives in the app profile. The main process writes a temporary file and renames it. The file does not depend on the local server port. Question drafts include the pending question ID. The renderer restores a question draft only for that question.

An explicit Quit preserves the open layout. Closing a window removes it from the next layout. If no windows remain in the saved layout, the app opens one empty window. Invalid saved state also opens an empty window. The app constrains restored windows to an available display's work area.

## Verification

Run the normal checks:

```sh
npm ci
npm run typecheck
npm test
npm run lint
npm run build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs --electron
```

The workspace tests cover state validation, duplicate opens, pane transfers, closed windows, restoration, and display geometry. The native smoke test uses a temporary profile and synthetic data. Never point the smoke test at a real learner profile.

A synthetic test does not establish provider reliability, microphone operation, or placement on two physical displays. Verify those on the target hardware before making those claims.
