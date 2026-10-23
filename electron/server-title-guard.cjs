/**
 * server-title-guard.cjs — preloaded (--require) into the server child.
 *
 * Next's startServer sets process.title = "next-server (vX)". On macOS,
 * libuv applies a title through private LaunchServices calls, and that
 * checks the process in as a FOREGROUND app: because the child runs this
 * app's own binary (ELECTRON_RUN_AS_NODE), the Dock grows a second,
 * window-less "LearnHarness" tile with the generic exec icon that bounces
 * at every launch. Keeping the title in JS only (never handed to libuv)
 * leaves the child an invisible background process. Nothing reads the
 * OS-level title — `ps` keeps showing the binary path.
 */
let title = process.title;
Object.defineProperty(process, "title", {
	configurable: true,
	enumerable: true,
	get: () => title,
	set: (value) => {
		title = String(value);
	},
});
