# LearnHarness for Android

The user chose an installable Samsung-tablet APK using their ChatGPT Pro plan,
independent of their PC, and explicitly requested implementation and delivery.
Keep the existing Cursor support in the desktop branch. Do not deploy a server,
request an API key, or copy development credentials into the APK.

## Approach

A cloud-backed wrapper conflicts with the selected local-data approach. A new
native learning app would duplicate the existing teacher, exercises, graph and
storage. Embed the existing standalone Next server in an Android application,
using Node.js Mobile, with an Android WebView for the existing interface.
This implementation choice preserves the existing app and local file formats.

The Android shell owns a single Node runtime, app-private persistent data,
temporary files, a per-launch loopback capability and browser/file-picker access.
ChatGPT authentication uses the existing public OAuth client with PKCE and a
loopback callback in the system browser. Tokens stay in app-private storage,
excluded from backup. Only model requests need internet; existing local material
remains available without a PC or an application hosting service.

## Constraints and verification

- Android 8+; package ARM64 and x86_64 (emulator) initially; native PDF/SVG bindings
  must match Android rather than the Linux build host.
- Bind only to 127.0.0.1, protect local app requests with a random HttpOnly cookie,
  reject cross-site writes, and open external pages in the system browser.
- Keep data outside the replaceable application bundle; app upgrades preserve it.
- Show startup failures instead of an indefinite blank screen; support file imports,
  back navigation, keyboard insets and portrait/landscape tablet layouts.
- Pin and checksum the embedded runtime; retain its licenses and source reference.
- Build and signature-check the APK, install and exercise it on an Android emulator.
  Real ChatGPT Pro login requires the user's account and must not be claimed tested
  unless performed. Clearly identify any device-only limitations.

The Node Mobile fork is a prerelease runtime dependency. Document its provenance
and test the shipped binary rather than relying on desktop Node tests alone.
Desktop-only CLI providers and headless Chromium execution cannot be promised on
Android; provide honest availability errors while preserving them on desktop.
