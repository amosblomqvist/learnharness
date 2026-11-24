# Use LearnHarness on an iPhone

The phone browser uses the running desktop app's server, models, settings, graph, plugins, and saved sessions. Keep LearnHarness open on the PC. The interface follows the current theme and adapts to portrait, landscape, safe areas, and the on-screen keyboard.

## Connect through Tailscale

1. Connect the PC and iPhone to Tailscale using the same personal account.
2. In LearnHarness on the PC, open **Settings → General → Mobile Access** and enable it.
3. Run the setup command shown there on the PC:

   ```sh
   tailscale serve --bg --https=9443 http://127.0.0.1:4397
   ```

4. Select **Check connection**, then **Copy private link**. Open the link in Safari on the iPhone. You can also use Safari's **Add to Home Screen**.

The HTTPS link is `https://<your-PC>.<your-tailnet>.ts.net:9443`. Enable Tailscale DNS on the phone so that name resolves. HTTPS is needed for microphone dictation and browser clipboard access. Your existing dictation provider configuration is still required.

## Use a direct link without Tailscale DNS

The direct link uses the PC's Tailscale IPv4 address, so it works with **Use Tailscale DNS** off on the phone. Set it up alongside the HTTPS link by running this on the PC:

```sh
tailscale serve --bg --tcp=9081 --proxy-protocol=1 tcp://127.0.0.1:4398
```

Select **Check connection**, then **Copy direct link**. The link looks like `http://100.x.y.z:9081`. Connect Tailscale on the phone with the same account as the PC and paste the full `http://` link into the browser.

Traffic still travels inside Tailscale's encrypted connection, but the page itself is plain HTTP, so the browser may label it not secure. Tailscale passes each connection's tailnet address to LearnHarness using the PROXY protocol. LearnHarness accepts a connection only from untagged, unexpired devices on the PC's account, and it checks that list on every request. Browsers allow the microphone only on secure pages, so dictation is turned off on the direct link; use the HTTPS link for dictation. Everything else works the same.

Remove only this endpoint with `tailscale serve --tcp=9081 off`.

Port 9443 is separate from other Tailscale sites on 443 or 8443. If 9443 already serves something else, resolve that conflict before running the command. The setup command configures a private Tailscale Serve endpoint. The gateway requires the same Tailscale user as the PC; Funnel and tagged-device identity are not supported.

Turn **Mobile Access** off to stop phone connections and close active streams. The preference is remembered on this PC, and an enabled gateway starts when the desktop app starts. Remove only this Tailscale endpoint with:

```sh
tailscale serve --https=9443 off
```

## Use the phone interface

Open the sidebar with the header button. It becomes a drawer containing teaching/practice, session search, folders, plugin actions, background activity, and settings. The **•••** buttons expose session/folder actions, including a folder selector for moves. Opening a session closes the drawer.

Settings fill the screen with a horizontally scrollable section selector. Side conversations fill the available screen, preserving their content and drafts. Graph gestures support touch; the full lesson plan supports pinch zoom and the existing zoom buttons. Wide code and tables scroll within their content area.

Model calls and native operations run on the PC. Existing provider connections work from the phone. Sign-in flows that require a PC browser open there; finish those flows on the PC. Update controls, when available, apply to the PC app.

## Upload photos and files

Use the paperclip to choose **Photos or camera** or **Files**. Upload up to 32 files totaling **25 MiB per request**. The composer waits for an upload to finish before sending. Uploaded files are retained under `<learning data>/attachments/`, and the message uses their server-side paths so the existing file-reading tools can use them later.

Uploads preserve the configured file-access restrictions. If file access is restricted, allow the attachments directory in **Settings → Agent → Tools → File access** before uploading. File decoding and image formats supported by the configured tools/models still apply. Phone uploads do not provide a browser for the PC filesystem.

## Open a local phone viewport

In **Settings → General → Mobile Access**, choose Compact (320 × 568), Phone (390 × 844), or Large (430 × 932), then select **Open phone viewport**. This opens a separate, resizable window connected to the current workspace. Tailscale and Mobile Access can stay off for this window. Changes in it are real changes to the shared workspace.

This window uses the browser upload path rather than the desktop file-path picker. Resize it to test intermediate widths or landscape. Actual iPhone Safari testing is still needed for iOS microphone permissions, keyboard behavior, safe areas, and Home Screen mode.

## Verification

After building, run `node scripts/smoke-mobile.mjs --desktop` to check portrait and landscape layouts, drawer actions, settings, real uploads, session composers, plan access, desktop layout, and the connected native viewport using temporary learning data and an installed Chrome browser. Override `LH_TEST_CHROME` for another installed Chrome-compatible executable. No models are invoked. Set `LH_MOBILE_SCREENSHOTS` to a directory to save screenshots.
