/**
 * THE PHONE BUILD'S COMPOSITION ROOT (mobile Phase 0).
 *
 * Boots the on-device backend in the page: loads the IndexedDB-backed file
 * system, then (only then) loads the server route modules, and finally
 * routes same-origin `/api/*` fetches to them. The ordering matters —
 * server modules read settings and keys at import time, so the files must
 * be in memory first; the router is therefore imported dynamically.
 */

import "./shims/web-polyfills.ts";
import { assets } from "lh:assets";
import { bootPersistence, flushPersistence } from "./persist.ts";

export type Backend = {
	/** Handle one `/api/*` request on the device. */
	handle(req: Request): Promise<Response>;
	/** Resolves once every write so far is committed to IndexedDB. */
	flush(): Promise<void>;
	/** How many stored files were loaded at boot. */
	loadedFiles: number;
};

let booting: Promise<Backend> | null = null;

export function startBackend(): Promise<Backend> {
	booting ??= (async () => {
		const { files } = await bootPersistence(assets);
		const { routeRequest } = await import("./router.ts");
		return { handle: routeRequest, flush: flushPersistence, loadedFiles: files };
	})();
	return booting;
}

/** Route this page's same-origin `/api/*` fetches to the on-device backend.
 *  Every other request (model providers, static assets) goes to the network
 *  untouched. Returns the backend once booted. */
export async function installApiFetch(): Promise<Backend> {
	const backend = await startBackend();
	const networkFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		if (url.origin === location.origin && url.pathname.startsWith("/api/")) return backend.handle(req);
		return networkFetch(input, init);
	};
	return backend;
}
