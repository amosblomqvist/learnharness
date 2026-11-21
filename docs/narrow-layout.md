# Narrow viewports

How the browser build behaves below the desktop window floor, and the rules new UI follows.

## The breakpoint

`narrow` is **width < 40rem (640px)** — the Electron window floor (`electron/main.cjs`,
`minWidth: 640`). Electron can never reach it, so this is a browser-only layout; every
width at or above 640px stays the unchanged desktop layout.

The Tailwind custom variants live in `app/globals.css`:

```css
@custom-variant narrow (@media (width < 40rem));
@custom-variant coarse (@media (pointer: coarse));
```

Both are CSS-only: layout must not depend on a JS width listener. The single exception is
the sidebar, where JS chooses which DOM to mount; it reads the same query
(`NARROW_QUERY` in `components/sidebar.tsx`). `tests/narrow-breakpoint.test.ts` and
`tests/narrow-sidebar-query.test.ts` pin the spellings together.

`coarse` is about the pointer, not the width: a narrow desktop window keeps its keyboard
hints and dense targets.

## Platform plumbing

- `generateViewport` in `app/layout.tsx` sets `interactive-widget=resizes-content`
  (Android Chrome shrinks the layout viewport for the keyboard) and a `theme-color`
  matching the active theme. The viewport is read per request, like the first-paint
  theme.
- Safe-area tokens (`--lh-safe-*`) exist for edge-pinned surfaces. The app shell stays
  inside the browser's own insets: `viewport-fit=cover` is not adopted yet.

## Rules for new UI

1. Use the `narrow:` variant for layout, `coarse:` for input ergonomics. Do not add JS
   width listeners; extend the sidebar's single query only if the DOM itself must differ.
2. No fixed pixel width without a narrow cap (`narrow:max-w-full`, a stacked layout, or a
   sheet).
3. A keyboard-only affordance needs a visible touch path on the same surface.
4. Two-column surfaces (settings, side question) get a single-column narrow presentation,
   not a squeezed one.

## Status

- Breakpoint, variants, viewport and safe-area tokens: this change.
- Sidebar drawer below 640px: separate change.
- Session chrome (title, dock hints, dictation): separate change.

Settings, the side-question panel, the plan map and diagram overlays, and plugin UIs keep
their desktop geometry below 640px. The touch-target sweep (40px floor on coarse
pointers) and an installable web app manifest are also pending. Each is proposed as a
separate change in issue
[#732](https://github.com/amosblomqvist/learnharness/issues/732).

## Reaching the app from a phone

`npm run dev` and `npm start` listen on localhost only. Serve the browser build on the
LAN with `npm run dev -- -H 0.0.0.0` (or the production equivalent) and open
`http://<this machine's IP>:3000`. Browser mode has no login, so only do this on a
network you trust, and remember that dictation needs a secure context: plain
`http://<ip>` will not get microphone access. Use HTTPS (a reverse proxy or a tailnet)
when dictation matters.
