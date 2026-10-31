# Mobile web access

The same LearnHarness, from a phone, over an SSH tunnel, with real accounts.
Branch: `mobile-web` (2026-10-29).

## What changed

- **Accounts.** First visit creates the admin; the admin creates accounts or
  mints one-time invite links (Settings → Accounts). Passwords are scrypt
  hashes, sessions are signed httpOnly cookies (`lh_session`, 30 days).
- **Per-account data.** Chats, graph ledgers, jobs and settings live under
  `data/users/<accountId>/`. Provider keys stay machine-global (`auth.json`).
- **Desktop unchanged.** The Electron shell authenticates with its capability
  header and maps to the first admin — it never sees a login screen.
- **Mobile shell.** Below 768px the sidebar is an off-canvas drawer (with
  backdrop + scroll lock), the question/practice dock becomes a bottom sheet on
  the safe area, Settings goes full-screen, the top bar drops decorative chips,
  and keyboard hints disappear on touch devices.

## Run it

```bash
cd ~/learnharness
npm run build          # once per code change
npm run web            # serves 127.0.0.1:3000 with data/ as the data root
```

`npm run web` accepts `PORT` and `LH_DATA_DIR`. It refuses to start without a
build (`.next/BUILD_ID`).

As a service, this box uses `learnharness.service` (`next start -H 127.0.0.1
-p 3000`, `Restart=always`):

```bash
sudo systemctl restart learnharness   # after every build
tail -f ~/learnharness/lh-service.log
```

## Reach it from the phone

```bash
ssh -L 3000:127.0.0.1:3000 vitor@<host>     # keep this open
```

Then open `http://localhost:3000` on the phone. The origin stays `localhost`,
so cookies are same-site and no TLS is required. The server itself never
listens on a public interface — the tunnel is the door.

iOS: Share → Add to Home Screen (uses `public/manifest.webmanifest`).

## Data layout

```
data/
  users.json               accounts + invites (0600)
  session.key              cookie signing key (0600; delete to log everyone out)
  users/<accountId>/
    chats/  graph/  jobs/  prompts/  settings.json
```

The first admin adopts whatever was in `data/` before accounts existed
(chats/graph/settings are MOVED into their root at setup).

## Troubleshooting

- **App opens without asking for a login** → something is serving an old
  build. `ps -eo pid,lstart,cmd | grep next` and check the process start time
  against the last `npm run build`; restart the service.
- **"Too many redirects"** → the gate is bouncing a public page. Only `/login`,
  `/setup`, `/join`, `/api/auth/*` and static assets are public; anything else
  must resolve a session.
- **Chat 404 while the API works** → a server component read stores outside the
  account scope. Page reads must go through `withUserScope()`.
- **Session expired / account disabled** → any 401 sends the tab back to
  `/login` (SessionGuard).
- **Locked out of the only admin** → stop the service, then with it stopped:
  `node -e "…"` is not provided on purpose; reset by deleting the account's
  `passwordHash` is not supported. Restore `data/users.json` from a backup or
  ask another admin to reset the password (Accounts → Reset password).

## Verification

```bash
npm run typecheck && npm test && npm run build
node scripts/smoke-auth.mjs http://127.0.0.1:3000 /tmp/lh-auth-it   # throwaway instance
LH_COOKIE=$(node scripts/print-session.mjs you@example.com) \
  node scripts/mobile-shots.mjs http://127.0.0.1:3000 /tmp/lh-shots <chatId>
```

`smoke-auth.mjs` walks setup → session → per-account isolation → disable →
invite → logout. `mobile-shots.mjs` drives Chromium at 390×844 and asserts no
horizontal overflow on home, chat, drawer and settings.
