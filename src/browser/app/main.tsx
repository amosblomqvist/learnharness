/**
 * Phone build entry: start the on-device backend, route `/api/*` fetches
 * and event streams to it, then render the app.
 */
import "katex/dist/katex.min.css";
import "./phone.css";
import { createRoot } from "react-dom/client";
import { installApiFetch } from "../backend.ts";
import { installApiEventSource } from "./event-source.ts";
import { App } from "./app.tsx";
import { registerSettingsSection } from "@/components/settings/extra-sections";
import { PhoneDataSection } from "./phone-data.tsx";

registerSettingsSection({ id: "phone-data", label: "Phone data", render: () => <PhoneDataSection /> });

async function main(): Promise<void> {
	// The drawer starts closed on a phone (the desktop default is open);
	// an explicit choice the user made later is kept.
	try {
		if (localStorage.getItem("lh:sidebar-open") === null) localStorage.setItem("lh:sidebar-open", "0");
	} catch {
		// storage unavailable: the desktop default applies
	}
	installApiEventSource();
	const backend = await installApiFetch();
	(globalThis as { lhBackend?: unknown }).lhBackend = backend;
	const root = document.getElementById("root");
	if (!root) throw new Error("missing #root");
	createRoot(root).render(<App />);
	// Offline support (src/browser/app/sw.template.js). Best effort: an
	// unsupported or failed registration leaves the app working online.
	if ("serviceWorker" in navigator && window.isSecureContext) {
		navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("[sw] registration failed:", err));
	}
}

main().catch((err) => {
	console.error("[boot] failed:", err);
	const root = document.getElementById("root");
	if (root) root.textContent = `LearnHarness could not start: ${(err as Error).message}`;
});
