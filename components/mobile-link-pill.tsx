"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, QrCodeIcon, SmartphoneIcon } from "lucide-react";
import type { MobileAccessStatus } from "@/lib/mobile-access";
import { MOBILE_STATUS_EVENT, copyText, mobileQrLinks, mobileShareLink, mobileStatus } from "@/components/mobile-runtime";
import { MobileLinkQr } from "@/components/mobile-link-qr";

/** Home's Mobile Access link: a copy pill plus a QR button whose panel shows
 * a scannable code for each ready link (HTTPS and direct). It renders only on the PC while Mobile
 * Access is on and a link exists: HTTPS when Tailscale Serve is up, otherwise
 * the direct link. Settings and window focus keep it current. */
export function MobileLinkPill() {
	const [status, setStatus] = useState<MobileAccessStatus | undefined>();
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	const [qrOpen, setQrOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let live = true;
		const load = () => { void mobileStatus().then(status => { if (live) setStatus(status); }).catch(() => { if (live) setStatus(undefined); }); };
		const changed = (event: Event) => setStatus((event as CustomEvent<MobileAccessStatus>).detail);
		load();
		window.addEventListener("focus", load);
		window.addEventListener(MOBILE_STATUS_EVENT, changed);
		return () => { live = false; window.removeEventListener("focus", load); window.removeEventListener(MOBILE_STATUS_EVENT, changed); };
	}, []);
	useEffect(() => {
		if (state === "idle") return;
		const timer = window.setTimeout(() => setState("idle"), 1600);
		return () => window.clearTimeout(timer);
	}, [state]);
	useEffect(() => {
		if (!qrOpen) return;
		const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setQrOpen(false); };
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setQrOpen(false); };
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escape);
		return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
	}, [qrOpen]);
	const link = mobileShareLink(status);
	const qrLinks = mobileQrLinks(status);
	if (!link) return null;
	const chip = "lh-no-drag flex h-8 items-center rounded-md border border-border bg-card font-ui text-xs text-muted-foreground shadow-sm transition-colors hover:border-muted-foreground/50 hover:bg-accent hover:text-foreground cursor-pointer";
	return (
		<div ref={root} className="relative flex items-center gap-1">
			<button
				type="button"
				data-testid="home-mobile-link"
				title={state === "failed" ? "Could not copy. Copy it from Settings → Mobile Access." : "Copy mobile link"}
				aria-label={`Copy mobile link ${link}`}
				onClick={() => { void copyText(link).then(ok => setState(ok ? "copied" : "failed")); }}
				className={`${chip} max-w-[min(26rem,60vw)] gap-1.5 px-2.5`}
			>
				<SmartphoneIcon aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="truncate">{state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : link}</span>
				{state === "copied" ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" /> : <CopyIcon aria-hidden="true" className="size-3.5 shrink-0" />}
			</button>
			<button
				type="button"
				data-testid="home-mobile-qr-toggle"
				title="Show QR code"
				aria-label="Show mobile link QR code"
				aria-expanded={qrOpen}
				onClick={() => setQrOpen(open => !open)}
				className={`${chip} w-8 justify-center${qrOpen ? " border-muted-foreground/50 bg-accent text-foreground" : ""}`}
			>
				<QrCodeIcon aria-hidden="true" className="size-3.5" />
			</button>
			{qrOpen && <div
				data-testid="home-mobile-qr"
				className="absolute left-1/2 top-full z-50 mt-2 flex w-max -translate-x-1/2 flex-col items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-lg"
			>
				<div className="flex gap-4">
					{qrLinks.map(entry => <div key={entry.kind} data-testid={`home-mobile-qr-${entry.kind}`} className="flex w-44 flex-col items-center gap-1.5">
						<p className="font-ui text-xs font-medium text-foreground">{entry.label}</p>
						<MobileLinkQr link={entry.link} size={176} />
						<p className="break-all text-center font-ui text-[11px] text-muted-foreground">{entry.link}</p>
						<p className="text-center font-ui text-[11px] text-muted-foreground">{entry.hint}</p>
					</div>)}
				</div>
				<p className="font-ui text-[11px] text-muted-foreground">Scan with your phone&apos;s camera.</p>
			</div>}
		</div>
	);
}
