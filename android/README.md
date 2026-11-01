# LearnHarness on Android

An Android host for the existing LearnHarness application. The APK embeds the
Next standalone server and Node.js Mobile; it does not connect to a desktop PC or
require a hosted LearnHarness server. Learning data and ChatGPT credentials stay
in Android's private app storage. Model requests still require internet.

The ARM64 APK targets Samsung Galaxy Tab S9+ and Tab S10 FE. Minimum Android: 8.
The x86_64 APK is for emulator validation. Both use the same application payload.

## Install and connect ChatGPT Pro

1. Copy the signed ARM64 APK to the tablet and open it in Samsung My Files.
2. Allow installation from that app when Android asks, then install LearnHarness.
3. On first launch, wait for the local application to unpack.
4. Open Settings → Providers → ChatGPT and sign in. Chrome or Samsung Internet
   opens the OpenAI authorization page. Approve use of your ChatGPT plan, then
   return to LearnHarness. No API key is required.
5. Select available ChatGPT models in the app's model settings.

Usage is subject to the limits and eligibility of the connected ChatGPT plan.
The app never falls back to a developer's API key. No account is shipped in it.

Local sessions can be read without internet. Generating new answers and signing
in require internet. Keep LearnHarness open while generating; closing it from
Android's recent-apps screen stops its local runtime. Android may also terminate
work under memory pressure. Stored sessions remain available after restarting.

Install updates signed with the same key over the existing app to preserve data.
Uninstalling or clearing app data removes local sessions and credentials. Backups
are disabled so device-bound credentials are not copied to another device.

## Build

Requirements: Node 24+ (CI uses 26), JDK 21, Python 3, curl, unzip, tar, Android SDK
platform 35, build-tools 35, NDK 28.0.13004108 and CMake 3.22.1.

```sh
npm ci
npm run android:prepare
cd android
./gradlew testDebugUnitTest assembleDebug assembleRelease
```

Set `JAVA_HOME` to your JDK and `ANDROID_HOME` to your SDK. Build products are in
`android/app/build/outputs/apk/`. The release APK is unsigned until signed with
the owner's private key using Android `apksigner`. Never commit a signing key.
Debug APKs are for testing, not interchangeable with a release-signed install.

To sign a personal ARM64 install, run `node scripts/android/sign.mjs` from the
repository root (or pass a downloaded unsigned APK path). This creates a private
key under `~/.cache/learnharness-android/signing/` and reuses it on subsequent
builds. Back up that directory privately: losing it prevents in-place updates.
The signed APK and SHA-256 are written to `dist/`.

The Android APK GitHub Actions workflow builds both ABIs and runs the x86_64 app
on an API 35 emulator. `node scripts/android/smoke.mjs` checks startup, WebView,
HTTP access controls, portrait/landscape layout, OAuth request construction and
session persistence after an offline restart. It does not log into a real account
or spend ChatGPT quota.

## Runtime and limits

The Node Mobile binary is a **prerelease** from the fogtape fork. The original
nodejs-mobile release is Node 18 and cannot run this version of Next. See
`runtime.json` for pinned source and SHA-256. The build verifies that digest and
the package-lock integrity of Android native dependencies.

ARM64 includes Android-native canvas and SVG rendering libraries. The x86_64
emulator build does not have those optional native renderers. Desktop-only CLI
providers (including Cursor) and headless Chromium demo verification need their
desktop environment; they are not installed in the tablet. Desktop behavior is
preserved in the same branch.

This is an initial Android build. A successful emulator run is not a claim of
physical Samsung-device testing or a completed ChatGPT Pro login. Those require
the tablet and its owner's account.
