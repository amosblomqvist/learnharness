"use client";

/**
 * The signed-in account, pinned at the sidebar's foot (mobile-web, 2026-10-29).
 * Hidden in the Electron shell and in the pre-auth local mode: there is no
 * session to end there.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOutIcon } from "lucide-react";
import { useMe, invalidateMe } from "@/components/auth/use-me";

export function AccountFooter() {
	const { user, loading } = useMe();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	if (loading || !user || user.id === "local") return null;

	const signOut = async () => {
		if (busy) return;
		setBusy(true);
		await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
		invalidateMe();
		router.replace("/login");
		router.refresh();
	};

	return (
		<div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5" data-testid="account-footer">
			<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] uppercase text-foreground" aria-hidden="true">
				{user.name.trim().slice(0, 1) || "?"}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-xs text-foreground">{user.name}</span>
				<span className="block truncate text-[11px] text-muted-foreground">{user.email}</span>
			</span>
			<button
				type="button"
				onClick={() => void signOut()}
				disabled={busy}
				title="Sign out"
				aria-label="Sign out"
				className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<LogOutIcon className="size-3.5" />
			</button>
		</div>
	);
}
