"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Hint } from "@/components/ui/hint";

const explanation = "Request priority processing for supported models across your chats. Fast mode may increase usage or cost.";

async function readSpeed(response: Response): Promise<boolean> {
	if (!response.ok) throw new Error("Could not read the saved preference");
	const body: { settings?: { chatSpeed?: { fast?: boolean } } | null } = await response.json();
	if (!body || !("settings" in body)) throw new Error("Missing settings response");
	return body.settings?.chatSpeed?.fast === true;
}

export function ChatSpeedSwitch() {
	const [fast, setFast] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const mounted = useRef(false);
	const writing = useRef(false);
	const revision = useRef(0);

	const refresh = useCallback(async () => {
		if (writing.current) return;
		const version = ++revision.current;
		try {
			const stored = await readSpeed(await fetch("/api/settings", { cache: "no-store" }));
			if (mounted.current && version === revision.current) {
				setFast(stored);
				setError("");
			}
		} catch {
			if (mounted.current && version === revision.current) {
				setFast(null);
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
	useSettingsSaved((section) => { if (section === "chatSpeed") void refresh(); });

	const toggle = async () => {
		if (fast === null || writing.current) return;
		writing.current = true;
		revision.current++;
		setSaving(true);
		setError("");
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

	return (
		<span className="relative inline-flex items-center">
			<Hint label={explanation} side="bottom">
				<button type="button" role="switch" aria-label="Fast mode for supported chats" aria-checked={fast === true}
					aria-busy={saving} disabled={fast === null || saving} onClick={toggle} data-testid="stats-fast"
					className="whitespace-nowrap rounded-full border bg-card/85 px-2.5 py-1 font-ui text-xs text-card-foreground shadow-lg hover:bg-muted disabled:opacity-60">
					{saving ? "Saving…" : fast === null ? "Fast · —" : fast ? "Fast on" : "Fast off"}
				</button>
			</Hint>
			{error && (
				<span role="alert" className="absolute bottom-full right-0 z-10 mb-1 w-max max-w-56 rounded-lg border bg-card px-2 py-1 text-xs text-card-foreground shadow">
					{error} <button type="button" className="underline" onClick={refresh}>Retry</button>
				</span>
			)}
		</span>
	);
}
