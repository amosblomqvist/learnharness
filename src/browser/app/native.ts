/**
 * The native shell (mobile Phase 5: Capacitor, mobile/native). Inside the
 * Android/iOS app, Capacitor injects `window.Capacitor` with the native
 * plugins installed in mobile/native/package.json — the web bundle needs
 * no Capacitor JavaScript of its own. Everywhere else (the home-screen web
 * app, desktop) these helpers report "not native".
 */
import { Buffer } from "../shims/buffer.ts";

type Plugin = Record<string, (options: Record<string, unknown>) => Promise<Record<string, unknown>>>;
type CapacitorGlobal = { isNativePlatform?: () => boolean; Plugins?: Record<string, Plugin | undefined> };

function capacitor(): CapacitorGlobal | null {
	const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
	return cap?.isNativePlatform?.() ? cap : null;
}

export function isNativeApp(): boolean {
	return capacitor() !== null;
}

/** Save a file through the native share sheet (Drive, Files, …): the
 *  WebView supports neither Web Share with files nor blob downloads.
 *  Writes it to the app's cache folder first, then shares that file. */
export async function shareFileNative(blob: Blob, name: string): Promise<void> {
	const plugins = capacitor()?.Plugins;
	const fs = plugins?.Filesystem;
	const share = plugins?.Share;
	if (!fs || !share) throw new Error("Saving files needs the Filesystem and Share plugins");
	const data = Buffer.wrap(new Uint8Array(await blob.arrayBuffer())).toString("base64");
	const { uri } = (await fs.writeFile!({ path: name, data, directory: "CACHE" })) as { uri: string };
	try {
		await share.share!({ title: name, files: [uri], dialogTitle: "Save backup" });
	} catch (err) {
		// Closing the sheet is a cancel, not a failure (web parity: AbortError).
		if (/cancel/i.test(String((err as Error)?.message ?? err))) {
			throw Object.assign(new Error("Share cancelled"), { name: "AbortError" });
		}
		throw err;
	}
}
