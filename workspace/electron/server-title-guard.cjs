/**
 * Preloaded only into the packaged macOS backend, before Next starts.
 *
 * Next assigns process.title. In Electron's Node mode on macOS, the native
 * setter checks in with Launch Services using the main app bundle, creating
 * an unwanted foreground application registration. Keep title writes in JS
 * instead: the native process name stays unchanged while JS can read back
 * its assigned title. This deliberately does not emulate native truncation
 * or every coercion detail; assignments use String(value).
 *
 * Explicit launch arguments (not NODE_OPTIONS) keep the full-Electron browser
 * helper untouched. Node-mode fork descendants can inherit this preload.
 */
if (process.platform === "darwin" && process.env.ELECTRON_RUN_AS_NODE === "1" && process.env.LH_DESKTOP_SERVER === "1") {
	let title = process.title;
	Object.defineProperty(process, "title", {
		configurable: true,
		enumerable: true,
		get: () => title,
		set: (value) => {
			title = String(value);
		},
	});
}
