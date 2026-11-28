"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { useNotifyHub } from "@/components/server-events";
import { Hint } from "@/components/ui/hint";
import type { ServerEvents } from "@/src/core";

type FastModeResult = ServerEvents["chat-speed-result"]["result"];

const explanation = "Request priority processing for supported models across your chats. Fast mode may increase usage or cost. The status describes completed requests in the current turn; the switch controls future requests.";

async function readSpeed(response: Response): Promise<boolean> {
	if (!response.ok) throw new Error("Could not read the saved preference");
	const body: { settings?: { chatSpeed?: { fast?: boolean } } | null } = await response.json();
	if (!body || !("settings" in body)) throw new Error("Missing settings response");
	return body.settings?.chatSpeed?.fast === true;
}

function resultNotice(result: FastModeResult): string {
	if (result.outcome === "applied") return "OpenAI confirmed Fast processing for the completed requests in this turn.";
	if (result.outcome === "unconfirmed") return "OpenAI did not confirm Fast processing for every completed request in this turn.";
	if (result.servedTier === "default") return "Fast was requested, but OpenAI used Standard for at least one request in this turn.";
	const tier = result.servedTier === "flex" ? "Flex" : result.servedTier === "scale" ? "Scale"
		: result.servedTier === "ultrafast" ? "Ultrafast" : undefined;
	return tier
		? `Fast was requested, but OpenAI used ${tier} for at least one request in this turn.`
		: "Fast was requested, but OpenAI did not apply Fast processing for every completed request in this turn.";
}

export function ChatSpeedSwitch({ chatId, model }: { chatId?: string; model: { provider: string; id: string } }) {
	const hub = useNotifyHub();
	const [fast, setFast] = useState<boolean | null>(null);
	const [result, setResult] = useState<FastModeResult | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const mounted = useRef(false);
	const writing = useRef(false);
	const revision = useRef(0);
	// A preference/account change can overlap an admitted request. Its later
	// completion cannot confirm the new selection; wait for the next turn.
	const awaitingTurn = useRef(false);

	const refresh = useCallback(async () => {
		if (writing.current) return;
		const version = ++revision.current;
		try {
			const stored = await readSpeed(await fetch("/api/settings", { cache: "no-store" }));
			if (mounted.current && version === revision.current) {
				setFast(stored);
				if (!stored) awaitingTurn.current = true;
				setError("");
			}
		} catch {
			if (mounted.current && version === revision.current) {
				setFast(null);
				setResult(null);
				awaitingTurn.current = true;
				setError("Could not read Fast mode.");
			}
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		window.addEventListener("focus", refresh);
		return () => {
			mounted.current = false;
			revision.current++;
			window.removeEventListener("focus", refresh);
		};
	}, [refresh]);
	useSettingsSaved((section) => {
		if (section === "chatSpeed") {
			setResult(null);
			awaitingTurn.current = true;
			void refresh();
		}
	});
	useEffect(() => {
		setResult(null);
		if (!hub) return;
		const offResult = hub.subscribe("chat-speed-result", (payload) => {
			if (fast === true && !awaitingTurn.current && chatId && payload.chatId === chatId
				&& payload.model?.provider === model.provider && payload.model.id === model.id) setResult(payload.result);
		});
		const offTurn = hub.subscribe("turn-started", (payload) => {
			if (payload.chatId === chatId) { setResult(null); awaitingTurn.current = false; }
		});
		const offSubscriptions = hub.subscribe("subscriptions-changed", () => { setResult(null); awaitingTurn.current = true; });
		const offResync = hub.onResync(() => {
			setResult(null);
			awaitingTurn.current = true;
			void refresh();
		});
		return () => { offResult(); offTurn(); offSubscriptions(); offResync(); };
	}, [hub, chatId, model.provider, model.id, fast, refresh]);

	const toggle = async () => {
		if (fast === null || writing.current) return;
		writing.current = true;
		revision.current++;
		setSaving(true);
		setError("");
		setResult(null);
		awaitingTurn.current = true;
		try {
			const stored = await readSpeed(await fetch("/api/settings/chatSpeed", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ fast: !fast }),
			}));
			if (mounted.current) setFast(stored);
			notifySettingsSaved("chatSpeed");
		} catch {
			if (mounted.current) {
				setFast(null);
				setError("Could not confirm Fast mode.");
			}
		} finally {
			writing.current = false;
			if (mounted.current) setSaving(false);
		}
	};
	const label = result?.outcome === "applied" ? "Fast applied"
		: result?.outcome === "not-applied" ? "Fast not applied"
			: result?.outcome === "unconfirmed" ? "Fast unconfirmed" : "Fast requested";

	return (
		<span className="relative inline-flex items-center">
			<Hint label={explanation} side="bottom">
				<button type="button" role="switch" aria-label="Fast mode for supported chats" aria-checked={fast === true}
					aria-busy={saving} disabled={fast === null || saving} onClick={toggle} data-testid="stats-fast"
					className="whitespace-nowrap rounded-full border bg-card/85 px-2.5 py-1 font-ui text-xs text-card-foreground shadow-lg hover:bg-muted disabled:opacity-60">
					{saving ? "Saving…" : fast === null ? "Fast · —" : fast ? label : "Fast off"}
				</button>
			</Hint>
			{fast === true && result && !error && (
				<span role="status" aria-live="polite" className="absolute bottom-full right-0 z-10 mb-1 w-max max-w-64 rounded-lg border bg-card px-2 py-1 text-xs text-card-foreground shadow">
					{resultNotice(result)}
				</span>
			)}
			{error && (
				<span role="alert" className="absolute bottom-full right-0 z-10 mb-1 w-max max-w-56 rounded-lg border bg-card px-2 py-1 text-xs text-card-foreground shadow">
					{error} <button type="button" className="underline" onClick={refresh}>Retry</button>
				</span>
			)}
		</span>
	);
}
