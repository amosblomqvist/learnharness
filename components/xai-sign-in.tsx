"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { XAI_SIGN_IN_LABEL, xaiSignInLine, type XaiSignInAction, type XaiSignInView } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

function actionLabel(action: XaiSignInAction, phase: XaiSignInView["phase"]): string {
	if (action === "cancel") return "Cancel";
	if (action === "sign-out") return "Sign out";
	if (phase === "signed-in") return "Sign in again";
	if (phase === "signed-out") return XAI_SIGN_IN_LABEL;
	return "Try again";
}

const buttonClass =
	"shrink-0 rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40";

export const XAI_OAUTH_ROW_LABEL = "Xai Oauth";

export type XaiSignInLayout = "stack" | "row";

export function XaiSignInBody({
	view,
	busy,
	layout,
	onAction,
}: {
	view: XaiSignInView;
	busy: boolean;
	layout: XaiSignInLayout;
	onAction: (action: XaiSignInAction) => void;
}) {
	const line = xaiSignInLine(view);
	const buttons = (
		<div className={layout === "row" ? "ml-auto flex flex-wrap justify-end gap-2" : "flex flex-wrap gap-2"}>
			{view.actions.map((action) => (
				<button
					key={action}
					type="button"
					data-testid={`xai-sign-in-${action}`}
					disabled={busy}
					onClick={() => onAction(action)}
					className={buttonClass}
				>
					{actionLabel(action, view.phase)}
				</button>
			))}
		</div>
	);
	const detail = (
		<>
			{line ? (
				<p data-testid="xai-sign-in-line" className="text-xs text-muted-foreground">
					{line}
				</p>
			) : null}
			{view.phase === "pending" ? (
				<div className="flex flex-wrap items-center gap-2">
					<code data-testid="xai-sign-in-code" className="font-mono text-xs text-foreground">
						{view.userCode}
					</code>
					<button
						type="button"
						data-testid="xai-sign-in-copy"
						className={buttonClass}
						onClick={() => {
							void navigator.clipboard.writeText(view.userCode).catch(() => {});
						}}
					>
						Copy code
					</button>
					<a
						data-testid="xai-sign-in-link"
						href={view.verificationUri}
						target="_blank"
						rel="noopener noreferrer"
						className="text-xs text-foreground underline"
					>
						Open the xAI page
					</a>
				</div>
			) : null}
		</>
	);

	if (layout === "row") {
		return (
			<div data-testid="xai-sign-in" className="flex flex-col gap-2 px-1 py-1.5">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<span className="font-ui text-xs text-foreground">{XAI_OAUTH_ROW_LABEL}</span>
					{buttons}
				</div>
				{detail}
			</div>
		);
	}

	return (
		<div data-testid="xai-sign-in" className="flex flex-col gap-2 px-1 py-1.5">
			{detail}
			{buttons}
		</div>
	);
}

export function XaiSignInControl({ layout = "stack" }: { layout?: XaiSignInLayout }) {
	const [view, setView] = useState<XaiSignInView | null>(null);
	const [busy, setBusy] = useState(false);
	const openedCode = useRef<string | null>(null);
	const prevPhase = useRef<XaiSignInView["phase"] | null>(null);

	const load = useCallback(async () => {
		const res = await fetch("/api/xai/sign-in");
		if (!res.ok) return;
		setView((await res.json()) as XaiSignInView);
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (view?.phase !== "pending") return;
		const id = setInterval(() => {
			void load();
		}, 2000);
		return () => clearInterval(id);
	}, [view?.phase, load]);

	useEffect(() => {
		if (!view) return;
		const prev = prevPhase.current;
		const becameSignedIn = view.phase === "signed-in" && prev !== null && prev !== "signed-in";
		const signedOut = prev === "signed-in" && view.phase !== "signed-in" && view.phase !== "pending";
		if (becameSignedIn || signedOut) notifySettingsSaved("keys");
		prevPhase.current = view.phase;
	}, [view]);

	useEffect(() => {
		if (view?.phase !== "pending") return;
		if (openedCode.current === view.userCode) return;
		openedCode.current = view.userCode;
		window.open(view.verificationUri, "_blank", "noopener,noreferrer");
	}, [view]);

	async function run(type: XaiSignInAction) {
		setBusy(true);
		try {
			const res = await fetch("/api/xai/sign-in", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type }),
			});
			if (!res.ok) return;
			setView((await res.json()) as XaiSignInView);
		} finally {
			setBusy(false);
		}
	}

	if (!view) return null;
	return <XaiSignInBody view={view} busy={busy} layout={layout} onAction={(action) => void run(action)} />;
}
