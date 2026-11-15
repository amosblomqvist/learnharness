"use client";

/**
 * The host hold banner (src/core/host-hold.ts). While a plugin (or the
 * host's own lifecycle) holds the app, data writes are refused; this slim
 * bar says why and offers Cancel, which aborts the holder's work and
 * releases the hold (POST /api/hold/cancel). Truth is GET /api/hold, refetched
 * on every "hold-changed" event and on reconnect.
 */

import { useCallback, useEffect, useState } from "react";
import { useServerEvent, useServerResync } from "@/components/server-events";

interface HoldSnapshot { hold: { owner: string; reason: string; since: number } | null }

export default function HoldBanner() {
	const [hold, setHold] = useState<HoldSnapshot["hold"]>(null);
	const [cancelling, setCancelling] = useState(false);
	const refresh = useCallback(() => {
		fetch("/api/hold", { cache: "no-store" })
			.then((res) => (res.ok ? (res.json() as Promise<HoldSnapshot>) : null))
			.then((snapshot) => { if (snapshot) setHold(snapshot.hold); })
			.catch(() => { /* the next event or reconnect refetches */ });
	}, []);
	useEffect(refresh, [refresh]);
	useServerEvent("hold-changed", refresh);
	useServerResync(refresh);
	useEffect(() => { if (!hold) setCancelling(false); }, [hold]);
	if (!hold) return null;
	const cancel = () => {
		setCancelling(true);
		fetch("/api/hold/cancel", { method: "POST" }).catch(() => {}).finally(refresh);
	};
	return (
		<div
			role="status"
			data-testid="hold-banner"
			className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2 text-sm shadow-lg"
		>
			<span className="size-2 animate-pulse rounded-full bg-foreground/60" aria-hidden="true" />
			<span>
				<span className="font-medium">{hold.reason}…</span>
				<span className="text-muted-foreground"> Changes are paused until it finishes.</span>
			</span>
			{hold.owner !== "host" && (
				<button
					type="button"
					disabled={cancelling}
					onClick={cancel}
					className="rounded-md px-2.5 py-1 font-medium transition-colors hover:bg-accent disabled:opacity-50"
				>
					{cancelling ? "Cancelling…" : "Cancel"}
				</button>
			)}
		</div>
	);
}
