# Mobile web access — plan (branch `mobile-web`)

Goal: the same app, usable from a phone over an SSH tunnel, with per-user login
and per-user data isolation. Desktop (Electron) keeps working unchanged.

Decisions taken by the owner (2026-10-29):

- Data isolation per account; **provider keys stay global** (one `auth.json` on the machine).
- Bootstrap: first visit creates the admin; the admin creates/invites the other accounts in-app.
- Primary transport: `ssh -L` port forward (no public port, no TLS).
- Mobile navigation: sidebar becomes a sliding drawer; docks become bottom sheets.

## Wave 1 — auth + isolation (server)

1. **Users store** `src/store/users.ts` → `data/users.json` (0600, atomic writes, hand-editable).
   Shape: `{ version, users: [{ id, name, email, role: "admin"|"user", passwordHash, createdAt, disabled }], invites: [{ code, createdBy, role, expiresAt, usedBy }] }`.
2. **Passwords** `src/server/auth/password.ts` — `scrypt` (N=2^15, r=8, p=1, 16B salt),
   stored as `scrypt$N$r$p$salt$hash`; `timingSafeEqual` verify. No new dependency.
3. **Sessions** `src/server/auth/session.ts` — signed JWT (HS256, `jose` is already a dep),
   cookie `lh_session`, httpOnly, sameSite=lax, `secure` only when the request is https,
   30 days. Secret at `data/session.key` (0600, generated once).
4. **Request context** `src/server/auth/context.ts` — `AsyncLocalStorage<{ user, dataRoot }>`;
   `requireUser()` (cookie → verify → load user), `currentUser()`, `runAsUser()`.
5. **Route guard** `proxy.ts` — public: `/login`, `/setup`, `/join`, `/api/auth/*`, static assets,
   manifest/icons. Everything else: session required → 302 to `/login` (pages) / 401 JSON (api).
   Desktop bypass stays: `LH_DESKTOP_SERVER=1` + secret header ⇒ allowed and mapped to the admin
   account, so the Electron shell never sees a login screen.
6. **Data isolation** — `PATHS` becomes request-scoped: with a user context it resolves to
   `data/users/<id>/` (`chats/`, `graph/`, `jobs/`, `settings.json`, render settings, prompt
   overrides); without one (scripts, CLI) it keeps today's `data/`. Global and unchanged:
   `auth.json` (provider keys), `.env*`, read-only prompt assets.
   Route handlers gain a `withUser()` wrapper (32 routes, mechanical) so services, turn runs and
   sub-agent jobs inherit the context.
7. **First-run migration** — when the admin is created and `data/chats` is non-empty, move the
   existing chats/graph/settings into `data/users/<adminId>/`. Nothing is deleted; the old paths
   are left empty.
8. **Auth UI** — `/setup` (name, email, password ≥10), `/login`, `/join?code=…` (invitee sets
   name + password), sign-out in the sidebar, and a new **Accounts** section in Settings
   (admin only): list users, invite (one-time code + link), disable, reset password.

## Wave 2 — web run mode + tunnel

9. `npm run web` → `scripts/web-serve.mjs`: build once, then run `.next/standalone/server.js`
   on `HOSTNAME=127.0.0.1 PORT=${PORT:-3000}` with `LH_DATA_DIR` set. Loopback only — the
   tunnel is what exposes it.
10. `docs/mobile.md`: `ssh -L 3000:127.0.0.1:3000 user@host`, then `http://localhost:3000` on the
    phone (keeps the origin same-site, so no TLS/cookie workarounds), plus the login/setup flow.

## Wave 3 — mobile shell (full parity, drawer + bottom sheets)

11. `app/layout.tsx`: `viewport` export (`width=device-width`, `viewportFit: cover`, theme color),
    `manifest.webmanifest` + apple meta/icons → installable on the home screen.
12. `app/globals.css`: safe-area insets, `dvh` sizing, `touch-action`, 44px minimum targets,
    no hover-only affordances on coarse pointers, `overscroll-behavior`.
13. Sidebar (`components/sidebar.tsx`): below 768px it renders as an off-canvas drawer
    (`translate-x`, backdrop, body scroll lock, closes on navigation, Escape); hamburger in the
    chat top bar and on home. Desktop layout untouched.
14. Docks (question / practice / activity) → shared `components/ui/bottom-sheet.tsx`: drag handle,
    snap heights, safe-area bottom padding. Desktop keeps the current dock.
15. `chat.tsx`: single column, sticky composer driven by `visualViewport` (keyboard), tap-friendly
    message actions, scroll/focus behavior preserved on desktop.
16. `settings-dialog.tsx`: full-screen sheet with a back button on mobile; keyboard-shortcuts
    section hidden on coarse pointers.
17. Graph (`graph-view.tsx`): pinch/tap pan-zoom (`touch-action: none`, d3-zoom touch already
    present), selection on tap, chain table horizontally scrollable on mobile.
18. Prose/tables/mermaid/demos: `overflow-x-auto` wrappers, smaller title scale; no horizontal
    page scroll at 360px.

## Wave 4 — verification gates

- `npm run typecheck`, `npm test`, `npm run build` green after each wave.
- Integration script against the standalone server: setup → login cookie → create chat → second
  account sees an empty list (isolation) → admin disables a user → login refused.
- Visual: headless Chromium at 390×844 (drawer, sheets, chat, graph, settings) — requires
  installing `chromium` via pacman (≈150 MB) on this box.
- Desktop regression: `npm run desktop:dev` boots and a session round-trips (no login screen).

## Out of scope (unless asked)

Provider-key management per user, public exposure without tunnel, OAuth/SSO, offline PWA caching.
