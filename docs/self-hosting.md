# Self-hosting LearnHarness

Run one LearnHarness server and use it from every device — laptop, phone,
tablet — through the browser. All data (chats, knowledge graph, practice
sets, settings, provider keys) lives on the server, so every device sees the
same state. Open windows update live: the server pushes change notifications
over `/api/events` (SSE) and each window refetches, so an answer typed on
your phone shows up on your laptop without a reload.

## Quick start (Docker)

```bash
cp .env.server.example .env.server   # then edit: set LH_SERVER_PASSWORD and LH_SESSION_SECRET
docker compose up -d --build
```

Open `http://<server>:3000`, sign in with the password, then add your
provider key and models in Settings as usual.

## Desktop app (macOS DMG)

The desktop app can open your server instead of running its own:
**LearnHarness menu → Connect to Server…**, enter the address (for example
`http://my-server:3000` or your Tailscale name), and press Connect. The app
checks it is a LearnHarness server, restarts, and shows the sign-in page.
You stay signed in for 30 days.

- **LearnHarness → Use This Mac Instead** switches back to the bundled local
  server and your local data (it is untouched while connected).
- **LearnHarness → Sign Out of Server** clears this Mac's session.
- If the server can't be reached at launch, the app offers Try Again,
  Change Server…, or Use This Mac.
- The choice is stored in `~/Library/Application Support/LearnHarness/server.json`.
- Subscription sign-in (ChatGPT/Copilot) only works in local mode.

Build an unsigned DMG for your own Mac (no Apple developer account needed):

```bash
npm ci && npx next build && node scripts/build-server.mjs
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 \
  -c.mac.identity=- -c.mac.notarize=false -c.mac.hardenedRuntime=false --publish never
```

The DMG lands in `dist/`. Auto-updates check this fork's GitHub releases
(`electron-builder.yml` → `publish`), so upstream releases never replace it.

## iPhone app

A native iPhone app lives in `ios/`. Build and install it with Xcode:
[ios.md](ios.md).

## Server mode

`LH_SERVER_PASSWORD` turns server mode on. With it set:

- every page redirects to `/login` until you sign in;
- every `/api/*` route answers `401` without a valid session;
- a sign-in lasts 30 days per device (HttpOnly, SameSite=Lax cookie);
- 10 wrong passwords from one address lock that address out for 15 minutes;
- `Authorization: Bearer <LH_API_TOKEN>` works for non-browser clients.

Sign a device out with `POST /api/auth/logout`. Sign **every** device out by
rotating `LH_SESSION_SECRET` (or the password, if no secret is set).

**Apps only.** `LH_APPS_ONLY=1` makes the server refuse everything except
the LearnHarness desktop and iPhone apps — a browser gets "This server only
works in the LearnHarness apps", even with the password. The apps add
`LearnHarnessDesktop/<version>` or `LearnHarnessiOS/<version>` to their
User-Agent. That tag is not a secret (it can be faked), so the password is
still what protects the server. Requests with `LH_API_TOKEN` are exempt.

Setting, changing or looking up the password, step by step:
[server-password.md](server-password.md).

Without `LH_SERVER_PASSWORD` nothing changes: desktop and `npm run dev`
behave exactly as before.

## HTTPS and reaching it from outside your home

Don't expose port 3000 to the internet over plain HTTP — the password and
cookie would travel unencrypted. Pick one:

- **Tailscale (simplest):** install it on the server and your devices, then
  open `http://<tailscale-name>:3000`. Traffic is encrypted and only your
  devices can reach it. `tailscale serve --bg 3000` adds HTTPS.
- **Reverse proxy:** Caddy (`your.domain { reverse_proxy localhost:3000 }`)
  gets a certificate automatically. Keep SSE unbuffered (Caddy does this by
  default; for nginx set `proxy_buffering off` on `/api/`).

## Data and backups

Everything lives in the `learnharness-data` Docker volume (`/data` in the
container): `chats/`, `graph/`, `practice/`, `jobs/`, `settings.json`,
`auth.json` (provider keys — treat as secret). Back up by copying the volume:

```bash
docker run --rm -v learnharness_learnharness-data:/data -v "$PWD":/out alpine tar czf /out/lh-backup.tgz -C /data .
```

To move existing desktop data to the server, copy the *contents* of the
desktop app's data folder (macOS: `~/Library/Application Support/LearnHarness/data/`)
into the volume, plus `LearnHarness/auth.json` if you want your keys there too.

## Without Docker

```bash
npm ci && npx next build && node scripts/build-server.mjs
LH_SERVER_PASSWORD=... LH_DATA_DIR=/srv/learnharness LH_AUTH_FILE=/srv/learnharness/auth.json \
  HOSTNAME=0.0.0.0 PORT=3000 node .next/standalone/server.js
```

## Limits

- One server process; the stores assume a single writer. Don't run replicas.
- Desktop-only features don't apply in the browser: signing in with a
  ChatGPT/Copilot subscription window, the local Claude Code CLI, and
  dropping file paths from your computer. Use API keys on the server instead.
- The agent's PDF tool reads paths on the **server's** filesystem.
