// electron-builder afterPack hook — mac icon swap and the Linux launcher.
//
// MAC (owner ruling 2026-10-13): mac.icon is the Icon Composer document
// (build/icon.icon); actool compiles it into Assets.car (the macOS 26
// Liquid Glass render) PLUS a backwards-compat icns — but actool's
// fallback icns caps at 256px (known actool behavior), which looks soft
// at Finder/Launchpad sizes on pre-Tahoe macOS. This hook swaps in the
// hand-packed full-res build/icon.icns (all 10 entries, 16→1024, packed
// via iconutil from the design's PNG exports) AFTER packaging and BEFORE
// signing, so:
//
//   macOS 26+  → Assets.car (CFBundleIconName) — true layered glass icon;
//   older mac  → icon.icns (CFBundleIconFile) — today's full-res flatten.
//
// LINUX: server mode. The Electron binary moves to <executable>.bin and a
// launcher takes its name, so AppRun, /usr/bin, and the .desktop entry all
// reach it. Without --headless it execs the binary unchanged; with it, the
// binary runs resources/server-mode.cjs as Node and Chromium never starts.
// The deb's AppArmor profile (build/apparmor-profile.tpl) names the .bin.
//
// Windows builds return immediately (build/icon.ico is a static file).
const fs = require("node:fs");
const path = require("node:path");

function linuxLauncher(executable) {
	return `#!/bin/sh
# LearnHarness launcher. --headless serves the web app on --host/--port
# (resources/server-mode.cjs); anything else starts the desktop app.
here=$(dirname "$(readlink -f "$0")")
for arg do
	if [ "$arg" = --headless ]; then
		ELECTRON_RUN_AS_NODE=1 exec "$here/${executable}.bin" "$here/resources/server-mode.cjs" "$@"
	fi
done
exec "$here/${executable}.bin" "$@"
`;
}

function installLinuxLauncher(appOutDir, executable) {
	const binary = path.join(appOutDir, executable);
	fs.renameSync(binary, `${binary}.bin`);
	fs.writeFileSync(binary, linuxLauncher(executable), { mode: 0o755 });
	console.log(`[after-pack] server-mode launcher → ${binary} (Electron → ${executable}.bin)`);
}

module.exports = async function afterPack(context) {
	if (context.electronPlatformName === "linux") {
		installLinuxLauncher(context.appOutDir, context.packager.executableName);
		return;
	}
	if (context.electronPlatformName !== "darwin") return;
	const appBundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	const target = path.join(appBundle, "Contents", "Resources", "icon.icns");
	const source = path.join(context.packager.info.projectDir, "build", "icon.icns");
	fs.copyFileSync(source, target);
	console.log(`[after-pack] pre-Tahoe fallback icns (full-res) → ${target}`);
};
