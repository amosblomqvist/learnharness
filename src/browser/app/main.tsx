/**
 * Phone build entry: start the on-device backend, route `/api/*` fetches
 * and event streams to it, then render the app.
 */
import "katex/dist/katex.min.css";
import { createRoot } from "react-dom/client";
import { installApiFetch } from "../backend.ts";
import { installApiEventSource } from "./event-source.ts";
import { App } from "./app.tsx";

async function main(): Promise<void> {
	installApiEventSource();
	const backend = await installApiFetch();
	(globalThis as { lhBackend?: unknown }).lhBackend = backend;
	const root = document.getElementById("root");
	if (!root) throw new Error("missing #root");
	createRoot(root).render(<App />);
}

main().catch((err) => {
	console.error("[boot] failed:", err);
	const root = document.getElementById("root");
	if (root) root.textContent = `LearnHarness could not start: ${(err as Error).message}`;
});
