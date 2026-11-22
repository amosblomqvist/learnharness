import React, { act, useLayoutEffect } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { useSourceDirectory } from "../components/source-directory.ts";
import type { SourceDirectory } from "../src/core/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}

test("a late POST acknowledgement never overwrites a more recent event-driven hierarchy", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const initial = { organization: { version: 1, folders: [], placements: {} }, sources: [] } satisfies SourceDirectory;
	const snapshot = (name: string): SourceDirectory => ({ ...initial, organization: { ...initial.organization,
		folders: [{ id: "folder", name, parentId: null, createdAt: "now" }],
	} });
	const acknowledge = deferred<Response>();
	const reconcile = deferred<Response>();
	let reconciliationReads = 0;
	let latest = snapshot("Initial");
	let holdRead = false;
	const values = { React, window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (_url: unknown, init?: RequestInit) => {
			if (init?.method === "POST") return acknowledge.promise;
			if (holdRead) { reconciliationReads++; return reconcile.promise; }
			return Response.json(latest);
		},
	};
	const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, values);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(dom.document.querySelector("#root")!);
	const callbacks = new Map<string, (data: string) => void>();
	const connect = (): NotifySource => ({ onOpen: () => {}, close: () => {}, onEvent: (name, cb) => { callbacks.set(name, cb); } });
	let change!: ReturnType<typeof useSourceDirectory>["change"];
	const seen: (string | undefined)[] = [];
	function Probe() {
		const state = useSourceDirectory(true);
		change = state.change;
		useLayoutEffect(() => { seen.push(state.directory?.organization.folders[0]?.name); }, [state.directory]);
		return null;
	}
	try {
		await act(async () => { root.render(<ServerEventsProvider connect={connect}><Probe /></ServerEventsProvider>); });
		assert.equal(seen.at(-1), "Initial");
		const write = change({ action: "rename-folder", id: "folder", name: "Sidebar write" });
		await act(async () => {
			latest = snapshot("Later window write");
			callbacks.get("sources-changed")!("{}");
		});
		assert.equal(seen.at(-1), "Later window write");
		holdRead = true;
		await act(async () => {
			acknowledge.resolve(Response.json(snapshot("Sidebar write")));
			// Bounded microtask flush: the response has a JSON body, no real network.
			await acknowledge.promise;
			await new Promise(resolve => setImmediate(resolve));
		});
		assert.equal(seen.at(-1), "Later window write", "do not regress while the reconciliation GET is pending");
		await act(async () => {
			reconcile.resolve(Response.json(snapshot("Newest directory")));
			await write;
		});
		assert.equal(reconciliationReads, 1);
		assert.equal(seen.at(-1), "Newest directory");
		assert.ok(!seen.includes("Sidebar write"));
	} finally {
		await act(async () => { root.unmount(); });
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
});
