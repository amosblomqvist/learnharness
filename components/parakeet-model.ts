"use client";

import { useCallback, useEffect, useState } from "react";

/** GET/POST/DELETE /api/stt/parakeet — the local dictation model's status. */
export type ParakeetModelStatus =
	| { state: "missing"; error?: string }
	| { state: "downloading"; receivedBytes: number; totalBytes: number }
	| { state: "ready"; diskBytes: number };

export const PARAKEET_POLL_MS = 500;
const ENDPOINT = "/api/stt/parakeet";

/** Decimal megabytes, matching the "487 MB" the download is advertised as. */
export function formatMegabytes(bytes: number): string {
	return `${Math.round(bytes / 1_000_000)} MB`;
}

async function request(method: "GET" | "POST" | "DELETE"): Promise<ParakeetModelStatus> {
	const res = await fetch(ENDPOINT, method === "GET" ? undefined : { method });
	if (!res.ok) throw new Error(`parakeet ${res.status}`);
	return await res.json() as ParakeetModelStatus;
}

/** The model's status while `enabled`; polls every 500 ms only while a
 * download runs. Actions answer with the new status, which replaces the old. */
export function useParakeetModel(enabled: boolean) {
	const [status, setStatus] = useState<ParakeetModelStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const downloading = status?.state === "downloading";

	const refresh = useCallback(async () => {
		try {
			setStatus(await request("GET"));
			setError(null);
		} catch {
			setError("Could not read the local model status.");
		}
	}, []);
	useEffect(() => {
		if (enabled) void refresh();
	}, [enabled, refresh]);
	useEffect(() => {
		if (!enabled || !downloading) return;
		const id = setInterval(() => { void refresh(); }, PARAKEET_POLL_MS);
		return () => clearInterval(id);
	}, [enabled, downloading, refresh]);

	const act = useCallback(async (method: "POST" | "DELETE") => {
		try {
			setStatus(await request(method));
			setError(null);
		} catch {
			setError(method === "POST" ? "Could not start the download." : "Could not update the local model.");
		}
	}, []);

	return {
		status, error,
		download: useCallback(() => act("POST"), [act]),
		/** Cancels a running download, or removes an installed model. */
		remove: useCallback(() => act("DELETE"), [act]),
	};
}
