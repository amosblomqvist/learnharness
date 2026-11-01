# iPhone app

`ios/` is a SwiftUI app that connects to your self-hosted LearnHarness
server (see [self-hosting.md](self-hosting.md)). Sessions, the knowledge
graph, settings and provider keys all live on the server, so the phone,
the desktop app and any other device stay in sync.

## What it does

The app draws its own interface in the desktop app's look (the same
monochrome palette, monospaced text and CMU Serif titles) and embeds the
server's pages only for what the server renders: a session's transcript
with its question and practice cards, the knowledge graph, and one
settings section at a time.

- **Connect to Server**: type the address (e.g. `my-server.lan:3000`). The
  app checks it is a LearnHarness server before saving it, and warns
  before plain `http://` outside a home network or Tailscale.
- **Sign in** with the server password. The session lasts 30 days and
  covers the embedded pages too.
- **Sessions**: every session, newest first, with the All / Teaching /
  Practice filter, search, swipe to rename or delete (with or without the
  session's graph traces), live status (thinking, question or problem
  waiting) and a Background section listing running research, demo and
  visual agents and graph extractions, each with Stop.
- **New session**: Learn or Practice, typed or dictated.
- **In a session**: a native composer (send, stop, steer while the teacher
  works, Next problem in practice) and a menu with Model & Thinking, Find
  in Session, Open the Plan, Export as Markdown, Rename, Reload and Delete.
- **Dictation** uses Apple's speech recognition, on the device where
  supported. It works over plain `http://`, where the web page's
  microphone would not.
- **Graph** and **Settings** tabs. Settings → Test Connection checks the
  address, sign-in, the live channel, the chosen model and its provider
  key, and can send a real test message in a throwaway session. Its
  report includes the page's recent errors, which helps when something
  goes wrong on a device.

Messages, answers and other writes travel over the app's own connection
rather than the embedded page's.

## How the pages fit in

The app's User-Agent carries `LearnHarnessiOS/<v>` (let in by apps-only
servers) and `LHNativeShell/<v>`. With the second token the pages hide
their own sidebar, chat title and composer (`components/native-shell.ts`,
the "iPhone app" rules at the end of `app/globals.css`) and report the
composer's state to the app over a script message handler.

## Install it on your iPhone

You need a Mac with Xcode and an Apple ID. No App Store or TestFlight needed.

1. Open `ios/LearnHarness.xcodeproj` in Xcode.
2. Select the **LearnHarness** target → **Signing & Capabilities** → set
   **Team** to your Apple ID (Xcode → Settings → Accounts to add it), and
   change the bundle identifier from `com.example.learnharness` to your
   own (e.g. `com.yourname.learnharness`).
3. Plug in your iPhone (or pick it over Wi-Fi), choose it as the run
   destination at the top of the window, and press **Run** (⌘R).
4. First time only, on the iPhone:
   - **Settings → Privacy & Security → Developer Mode** → on (restarts the phone).
   - **Settings → General → VPN & Device Management** → trust your developer certificate.
5. Open LearnHarness, enter your server's address (e.g. `my-server.lan:3000`),
   tap **Connect**, then sign in with the server password
   ([server-password.md](server-password.md)). Allow **Local Network**
   access when iOS asks.

With a free Apple ID the app stops opening after 7 days; press Run in
Xcode again to renew it. A paid Apple Developer account ($99/year) makes it
last a year and allows TestFlight.

## Using it away from home

A `.lan` name only resolves on your home network. To learn on the go,
install [Tailscale](https://tailscale.com) on the server and the iPhone,
then use **Settings → Change Server…** with the server's Tailscale name
(e.g. `my-server.your-tailnet.ts.net:3000`).

## Development

```bash
brew install xcodegen
cd ios && xcodegen generate        # after editing project.yml
xcodebuild -project LearnHarness.xcodeproj -scheme LearnHarness \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

`project.yml` is the source of truth for the Xcode project; the generated
`LearnHarness.xcodeproj` is committed so you can open it without XcodeGen.
The app's address rules match the desktop app's
(`electron/remote-server.cjs`) and are covered by
`LearnHarnessTests/ServerAddressTests.swift`. CMU Serif
(`LearnHarness/Fonts/cmunbx.ttf`) is the same OFL-licensed file as
`public/fonts/`.
