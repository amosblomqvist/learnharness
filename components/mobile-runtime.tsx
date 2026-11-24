"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { MobileAccessStatus } from "@/lib/mobile-access";
import type { UpdateState } from "@/components/settings/update-settings";

const QUERY = "(max-width: 767px), (pointer: coarse) and (max-width: 1023px)";
const subscribe = (callback: () => void) => {
	if (typeof window.matchMedia !== "function") return () => {};
	const query = window.matchMedia(QUERY);
	query.addEventListener("change", callback);
	return () => query.removeEventListener("change", callback);
};
const snapshot = () => !window.lh?.platform && typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
const serverSnapshot = () => false;
export function useMobileLayout() { return useSyncExternalStore(subscribe, snapshot, serverSnapshot); }

export async function mobileStatus(): Promise<MobileAccessStatus> {
	if (window.lh?.mobile) return window.lh.mobile.status();
	const response = await fetch("/api/mobile-access", { cache: "no-store" });
	if (!response.ok) throw new Error("Mobile Access status is unavailable.");
	return response.json();
}
export async function mobileCommand(op: string, fields: Record<string, unknown> = {}): Promise<MobileAccessStatus> {
	const bridge = window.lh?.mobile;
	if (bridge) {
		if (op === "refresh") return bridge.refresh();
		if (op === "enable") return bridge.enable(fields.enabled === true);
		if (op === "preview") return bridge.preview(String(fields.size));
	}
	const response = await fetch("/api/mobile-access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, ...fields }) });
	const reply = await response.json();
	if (!response.ok) throw new Error(reply.error || "Mobile Access could not be changed.");
	return reply;
}
async function hostControl<T>(kind: string, fields: Record<string, unknown>): Promise<T> {
	const response = await fetch("/api/mobile-host", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ...fields }) });
	const reply = await response.json();
	if (!response.ok || reply.error) throw new Error(reply.error || "The PC connection is unavailable.");
	return reply.value;
}

/** The phone receives public controls only. Credentials and native operations
 * stay on the PC. The local phone viewport uses this exact browser path. */
export function MobileRuntime() {
	const mobile = useMobileLayout();
	useEffect(() => {
		const root = document.documentElement;
		root.toggleAttribute("data-lh-mobile", mobile);
		if (!mobile) return;
		const viewport = window.visualViewport;
		const fit = () => {
			// Preserve pinch zoom; only the unzoomed keyboard changes our frame.
			if (viewport && viewport.scale !== 1) return;
			root.style.setProperty("--lh-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
			root.style.setProperty("--lh-viewport-top", `${viewport?.offsetTop ?? 0}px`);
		};
		fit();
		viewport?.addEventListener("resize", fit); viewport?.addEventListener("scroll", fit); window.addEventListener("resize", fit);
		return () => { root.removeAttribute("data-lh-mobile"); root.style.removeProperty("--lh-viewport-height"); root.style.removeProperty("--lh-viewport-top"); viewport?.removeEventListener("resize", fit); viewport?.removeEventListener("scroll", fit); window.removeEventListener("resize", fit); };
	}, [mobile]);
	useEffect(() => {
		if (window.lh?.platform) return;
		let live = true;
		let pending = false;
		const connect = async () => {
			if (!live || pending) return;
			pending = true;
			try {
			const status = await mobileStatus();
			if (!live) return;
			if (!status.remote) { window.clearInterval(retry); return; }
			const poll = (listener: (state: UpdateState) => void) => {
				const timer = window.setInterval(() => { void hostControl<UpdateState>("update", { op: "status" }).then(listener).catch(() => {}); }, 5000);
				return () => window.clearInterval(timer);
			};
			window.lh = { mobileRemote: true, expandWindow: () => {}, subscriptionTransport: "web",
				openSubscriptionBrowser: action => hostControl<void>("browser", { action }),
				getUpdateState: () => hostControl<UpdateState>("update", { op: "status" }),
				onUpdateStatus: poll,
				checkForUpdates: () => hostControl<void>("update", { op: "check" }),
				installUpdate: () => { void hostControl<void>("update", { op: "install" }).catch(() => {}); },
			};
			window.dispatchEvent(new Event("lh:mobile-ready"));
			window.clearInterval(retry);
			} catch { /* Initial fetch can race a dev reload or PC reconnect. */ }
			finally { pending = false; }
		};
		const retry = window.setInterval(() => { void connect(); }, 5000);
		void connect();
		window.addEventListener("online", connect);
		return () => { live = false; window.clearInterval(retry); window.removeEventListener("online", connect); };
	}, []);
	return null;
}
