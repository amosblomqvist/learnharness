# Windows launcher shortcuts

[日本語](windows-launcher.ja.md)

These shortcuts run the latest `main` without building an installer. Every launch follows `origin/main` and rebuilds only when the commit changed.

- **LearnHarness Fork** opens a lightweight window (WebView2) built with [Pake](https://github.com/tw93/Pake). Closing the window also stops the server.
- **LearnHarness Fork (Web)** opens the default browser. The server runs in a minimized console, and closing that console stops it.

Both use the same server (`http://127.0.0.1:3010`). While one of them runs the server, the other opens it without updating. Only the launcher that started the server stops it.

## Requirements

- Node.js and git
- Rust 1.85 or later and Visual Studio Build Tools ("Desktop development with C++") to build the Pake window. WebView2 ships with Windows 11.

## Setup

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
```

`setup.ps1` does the following:

1. Clones `origin/main` into `%USERPROFILE%\apps\learnharness` (change it with `-AppDir`).
2. Installs `pake-cli` with `npm install -g` if missing, and builds `%LOCALAPPDATA%\LearnHarness Fork Launcher\LearnHarnessFork.exe`. The first Rust build takes several minutes.
3. Creates both shortcuts on the desktop and in the Start menu. The shortcuts run `scripts\windows` inside the clone, so pulling also updates the launchers.

The first launch runs `npm ci` and `next build`, which takes a few minutes.

## What each launch does

1. Runs `git fetch origin main`, then `git merge --ff-only`. When offline, when the clone is on a branch other than `main`, or when tracked files changed, it skips the update and starts the current build.
2. Runs `npm ci` and `npm run plugins:setup` only when a `package-lock.json` (including the plugins' ones) changed.
3. Runs `npm run build` and `node scripts/build-server.mjs` only when HEAD differs from the last build. The build gets empty stdin, so `next build` does not show its interactive Next.js upgrade menu (upgrading from it would change `package.json` in the clone and stop the fast-forward). The next update restores `next-env.d.ts`, which the build rewrites.
4. Starts `.next/standalone/server.js` on `127.0.0.1:3010`.

## Data

Learning data and API keys live where the packaged app keeps them: `%APPDATA%\LearnHarness Fork\data` and `%APPDATA%\LearnHarness Fork\auth.json`. Recreating the clone keeps them, and a later installer build uses the same data. Running both at once makes two servers read and write the same data, so run only one.

## Limitations

- The Pake window and the browser run the web build. Desktop-only features (such as passing an attached file by its path, or subscription sign-in) are not available.
- To change the port, run `setup.ps1 -Port <number> -RebuildPake` to rebuild the window and the shortcuts. Avoid 3000–3005, which are used for development.
