/** Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		// Interface language, once per process (src/core/i18n.ts). The desktop
		// shell passes LH_LANG; a bare server reads the settings record.
		if (!process.env.LH_LANG) {
			const { readSettings } = await import("./src/store/settings.ts");
			try { process.env.LH_LANG = readSettings()?.general?.language ?? "zh"; }
			catch { process.env.LH_LANG = "zh"; }
		}
		const { initializeModelCatalog } = await import("./src/server/remote-model-catalog.ts");
		initializeModelCatalog();
		const { initializePlugins } = await import("./src/server/plugins.ts");
		try { await initializePlugins(); }
		catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
	}
}
