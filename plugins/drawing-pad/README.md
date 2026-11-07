# Drawing Pad

A trusted-local LearnHarness plugin for drawing over read-only question references.
Requires the public session-view context API documented at `docs/plugin-view-context.md`
(host commit `1b4b470`) and scoped plugin action shortcuts (`b651ca6a`) on the
plugin-architecture branch. App version 0.4.1 alone does not imply these unreleased
host capabilities are present.

## Behavior

- **Draw** in teaching/practice top bars toggles the pad. **Draw (unsent)** means
  visible ink is eligible for the next learner content submission in that session.
  X/Escape closes without sending or discarding. The normal top-bar overflow applies.
- A revealed, available built-in question shows question/context/options in the host's
  actual order. A native practice problem shows its statement. Public `mountMarkdown`
  preserves the host's Markdown/math rendering. Unrevealed questions, custom question
  or problem tools, unavailable input, and ordinary input start blank. No answer keys,
  learner drafts/selections/confidence, custom payloads, or transcript are captured.
- The window is a viewport onto unrestricted drawing coordinates, not a fitted sheet.
  The reference uses the native composer's normal question-content width:
  `calc(42rem - 2px)` (670 CSS pixels at a 16px root), derived from the current 46rem
  dock column minus outer padding, shell borders, and question padding. It does not
  use the window width, even when first opened in a narrow window. Height includes
  the complete content. The reference center defines the world origin; the camera
  places it bottom-center with a 24px gap. Resizing retains that bottom-center anchor
  and the saved Hand-pan offset without scaling or rewrapping the reference or ink.
  Pen and Eraser work over the whole surface, including beyond the reference.
  Blank sheets retain their centered origin.
- **Hand** drags the view at fixed scale, moving reference and ink together. Camera
  position is retained with each held session sheet across closing/navigation/remounts.
  Off-screen ink remains eligible for export; camera movement is not a content edit
  or an Undo entry. Holding the **right mouse button** and dragging temporarily
  pans with any selected tool; release or cancellation ends that gesture without
  switching tools, drawing/erasing, or adding an Undo entry. Pointer capture keeps
  panning/release working outside the canvas. Stylus-eraser behavior is unchanged.
  No zoom or Redo.
- Pen, whole-stroke Eraser, Undo, and Clear reuse the
  handwriting contribution's pressure-sensitive pen/mouse mechanics. Touch is ignored.
  Pen, Eraser, Hand, and Undo are icon-only controls with accessible names and tooltips;
  Clear remains text. Controls form a compact top-left floating cluster, not a reserved
  toolbar row: the canvas fills the surface, and transparent gaps/padding pass pointer
  input through. Actual controls remain clickable above the ink. A held stylus eraser
  button temporarily selects Eraser while using Pen/Eraser; Hand gestures pan rather
  than drawing.
- Clear removes ink/undo history but keeps the displayed background. Closing/reopening
  an untouched or explicitly cleared sheet captures a fresh reference. An erased sheet
  with undo history retains its original background until cleared/reset.
- Existing work retains its frozen reference and geometry when reopened/resized.
  Export tightly crops the union of the complete reference and all visible (not erased)
  ink, including off-screen work, with 24 CSS pixels of padding. A blank reference
  contributes no artificial canvas rectangle. No toolbar or camera/viewport extent is
  included. Apply Image scale, then reduce further if needed to stay within the fixed
  **2000 × 2000 pixel cap**, preserving aspect ratio to integer-pixel rounding. Display
  canvases cover only the viewport; export canvases never exceed the cap. Original
  strokes are retained at full precision. An untouched/fully erased sheet sends no image.
- Drawings attach to the next learner content submission: ordinary message, practice
  thinking, built-in answer, custom-question answer, or custom-problem submission.
  Existing text, JSON, selections, confidence, and images remain unchanged. Native
  readiness/validation and model image capability rules still apply.
- Teaching: acknowledged acceptance clears only the captured unchanged revision.
  Newer edits survive. Failed/refused/cancelled attempts and lost acknowledgment retain
  work. Later model failure does not restore an already consumed drawing.
- Practice: retain the board/undo history across submissions, conclusion, dismissal,
  and generation abort. Send an image only when the current visible drawing differs
  from the last acknowledged image. Undo back to that image does not resend it. Color
  changes count. Only an **accepted new problem pose** resets the board; if open, the
  old pad closes. Reopen Draw for the fresh host-selected reference. Failed/dangling
  poses, conclusions, dismissals, and model prose do not reset it.
- Automatic continuations, retries, silent dismissals and control-only Next do not run
  learner-content interception. Image-only pending ordinary input is content, not a
  control-only Next. Accepted image bytes are handled/stored by the host.
- Each session's sheet lives only in this app window's memory across navigation.
  Reload/restart/disable loses unsent work. No editable draft persistence.

## Keyboard shortcuts

Settings → Keyboard → Drawing Pad lists all four actions, including when the pad
is closed. They use the host's shared action/shortcut registry, so Rebind, Clear,
and Reset work without reloading.

| Action | Default |
| --- | --- |
| Draw (toggle open/closed) | Cmd/Ctrl+Shift+D |
| Undo drawing | Cmd/Ctrl+Z |
| Toggle pen/eraser | Cmd/Ctrl+Shift+E |
| Hand (select, not toggle) | Cmd/Ctrl+Shift+H |

These shortcuts are scoped to teaching/practice pages. Undo and tool switching
additionally require a ready, open pad with drawing focus and no active gesture.
They do not steal Undo from inputs, textareas, contenteditable areas, or other
focused editors. Switching from Hand selects Pen; switching tools never edits ink.
The Hand shortcut selects Hand just like its toolbar button; pressing it again
keeps Hand selected. Cmd/Ctrl+Shift+E returns from Hand to Pen. Native Cmd+H (Hide)
and Cmd+E are not overridden.
The host blocks shortcuts behind dialogs, menus, or foreign-plugin surfaces and
ignores held-key repeats/IME input. There is no separate hard-coded Undo listener.

## Settings

Settings → Drawing Pad:

- **Ink color**: default `#facc15`; enter exactly six hex digits prefixed with `#`.
  Case-insensitive input is saved lowercase. Successful saves recolor held ink,
  including retained practice sheets; submitted images never change.
- **Image scale**: default **50%**; a numeric percentage greater than 0 and at most 100.
  Scales the uncapped export raster (including its captured device-pixel density)
  **before** applying the fixed 2000 × 2000 cap. At 50%, a 1000 × 600 raster becomes
  500 × 300; a 6000 × 4000 raster becomes about 2000 × 1333 after the cap. This never
  scales the drawing surface, changes original strokes, or triggers unchanged practice
  resends. Each submission attempt freezes its scale. Very small scales that produce
  no visible ink refuse export and retain the drawing rather than sending a blank PNG.

The backend stores only `{revision, inkColor, imageScale}` in its own
`data/settings.json`. Existing color-only preferences read as 50% without an eager
rewrite. Invalid/write-failed values are not published as saved settings.

## Public-API boundary

Reference content comes solely from click-time `context.view.input`. Full history,
solutions, custom payloads and unsent learner drafts are not used to build references.
The backend's read-only `get-session-poses` operation returns **only accepted pose
occurrence identifiers** from public native acknowledgment records. Existing
`turn-settled`/`record-changed` notifications and resync reads detect new poses, including
while the pad is closed. It does not reconstruct active-question state, interpret
conclusion/dismissal, or duplicate host option projection/shuffling. Submission context
also reconciles pose identity before image capture; missing lifecycle reads fail closed.

Capture observes only plugin-owned DOM, generic ARIA busy state, fonts, and images.
Font embedding reads browser-parsed stylesheet rules (including nested imports and
active grouping rules), resolves font resources against their owning stylesheet,
and supplies detached font CSS to the capture library. It does not fetch imported
stylesheets as text or insert rules into live page stylesheets. HTML/failed font
responses fail background preparation rather than silently dropping fonts; font
fetches honor surface cancellation. This prevents relative-import 404 pages from
injecting their error-page styles into the session.
Background failures are shown on the surface; export/host preparation failures preserve
work. Async work honors cancellation and cannot reopen a disposed surface. Host-managed
image processing/limits and text-only-model refusals remain authoritative.

No runtime host imports, native DOM scraping, global key hook, polling, inference,
core-record writes, app replacement, or installer are included. Keyboard bindings
are declared on public plugin actions; the host owns dispatch and Escape.

## Development (plugin only)

```sh
npm run sdk
npm install
npm run typecheck
npm test
npm run test:browser
npm run build
# Exercise the actual distributable, not just the source module:
npm run test:browser -- --built
# Optional disposable fixture for manual browser inspection; Ctrl+C stops it:
npm run test:browser -- --built --serve
```

The build writes `dist/` directly and refuses symlinked output or `dist/data`. It bundles
all runtime dependencies and includes notices. `data/` is never distributed or removed
by the build. No host app build is part of these commands. Tests use disposable data
and a browser fixture, never a real learning profile or paid provider. Fixture proof
is not installed-app, real-tablet, microphone, or provider verification.

Installation, when separately authorized: built files belong in
`<learning-data>/plugins/drawing-pad/dist/`, with persistent preferences beside that at
`drawing-pad/data/`. Copying/updating a plugin does not authorize replacing the app.

## Verification boundary

Local verification includes strict SDK-consumer TypeScript (`skipLibCheck: false`),
81 unit tests, a plugin-only bundle build, targeted ESLint, and 50 browser assertion
groups. Browser capture uses the **actual host `HostMarkdown` pipeline**, including
KaTeX and asynchronous Mermaid, in a disposable loopback fixture. Shortcuts use the
actual host action manager, dispatcher, conflict resolver, interaction-layer controller,
and Keyboard settings component. A test-only React context adapter supplies that
manager without mounting Next's router/SSE providers. The surface shell, plugin
preference fields, submission acceptance and event transport remain fixture adapters,
not a running/installed LearnHarness app. Assertions inspect real canvas
pixels and decoded composite PNGs, unchanged practice-image suppression, pressure-pen
and held eraser events, reset/export races, cancellation, resync and cleanup. Remount
regressions cover initial mount/abort/remount with delayed cleanup registration,
retained background/ink/Undo, and flushing an active stroke during remount. Font
regressions verify nested relative imports, embedded used-font bytes, unchanged live
stylesheets/dark body/top-bar colors, HTML font response refusal, and fetch cancellation.
World-coordinate regressions cover fixed native content width even for fresh narrow-window
captures, narrowing/widening without scaling, the 24px bottom-center anchor with retained
Hand-pan offsets, remote ink erasing/Undo, camera-independent PNG bytes,
minimal blank-sheet crops, full-surface top-strip drawing behind compact controls,
transparent toolbar padding and clickable buttons, retina density, the 2000-pixel cap, and scale preferences
without content edits or unwanted practice resends. Shortcut regressions cover all
four default bindings, Hand selection/repeated selection and Hand → Pen, visible
Keyboard settings rows and Rebind/Clear/Reset, native text Undo, gesture/closed-pad
guards, and foreground blockers. Right-drag regressions cover all selected tools,
unchanged PNG bytes and Undo history, outside-canvas release, releasing Right with
Left still held, pointer cancellation/lost capture, remounts, and pending acceptance.
Headless Chrome's native text Undo command is attached to a real key event and remains
subject to preventDefault. `--built` runs the same proof against `dist/main.js` and
checks shortcut registrations up front, detecting stale distributions.
No provider/API requests or off-origin traffic are allowed. No real-tablet hardware,
installed-app integration, real model transport, microphone, or cross-OS proof is claimed.

These checks do not rebuild or replace the host app, submit real learner answers, or
call a model. The host pins installed plugin bundles for its process lifetime: after
updating an installed bundle, restart the host to load it. A browser refresh alone
still uses the pinned bundle. Build before copying `dist/`: source edits and successful
source-mode tests do not regenerate distributable files.
