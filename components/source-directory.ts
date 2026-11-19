"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OrganizationAction, SourceDirectory } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";

/**
 * The shared source organization (folders + placements), read and changed
 * through the existing /api/graph/sources route. The session sidebar and the
 * graph's folder filter use this; Chains keeps its own established reader
 * over the same route. Operation-based writes only — never whole-state.
 *
 * A failed read leaves `directory` undefined: callers fall back to their
 * folder-less presentation instead of failing.
 */
export function useSourceDirectory(enabled: boolean) {
	const [directory, setDirectory] = useState<SourceDirectory>();
	const [failure, setFailure] = useState("");
	const version = useRef(0);
	const request = useRef<AbortController | null>(null);
	const tail = useRef<Promise<unknown>>(Promise.resolve());

	const read = useCallback(async () => {
		const current = ++version.current;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		try {
			const response = await fetch("/api/graph/sources", { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("Could not read folders.");
			const body = await response.json() as SourceDirectory;
			if (!controller.signal.aborted && current === version.current) setDirectory(body);
		} catch {
			// Keep the last good organization; a transient failure must not
			// collapse the list into a different shape.
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;
		void read();
		return () => { version.current++; request.current?.abort(); request.current = null; };
	}, [enabled, read]);
	useServerEvent("sources-changed", () => { if (enabled) void read(); });
	useServerEvent("chats-changed", () => { if (enabled) void read(); });
	useServerResync(() => { if (enabled) void read(); });

	const change = useCallback((action: OrganizationAction): Promise<string | undefined> => {
		const operation = tail.current.catch(() => {}).then(async () => {
			try {
				const response = await fetch("/api/graph/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(action),
				});
				const body = await response.json() as { createdFolderId?: unknown; error?: unknown };
				if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not save folders.");
				// The acknowledgement describes the directory at commit time; a
				// later window's write may already be reflected in an SSE read.
				// Never install the POST snapshot. Reconcile with a fresh GET.
				await read();
				setFailure("");
				return typeof body.createdFolderId === "string" ? body.createdFolderId : undefined;
			} catch (error) {
				setFailure(error instanceof Error ? error.message : String(error));
				throw error;
			}
		});
		tail.current = operation;
		return operation;
	}, [read]);

	return { directory, failure, clearFailure: () => setFailure(""), reportFailure: setFailure, change };
}
