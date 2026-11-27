"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Puzzle, X } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { Button } from "@/components/ui/button";
import { COMMUNITY_CREDIT_URL, COMMUNITY_SECURITY_URL, communityListingReport, communitySource, type CommunityOffer } from "@/src/core";

export const pluginLinkClass = "underline underline-offset-2 hover:text-foreground";
const date = (timestamp: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(timestamp));
async function json(url: string, init?: RequestInit) {
	const response = await fetch(url, init);
	const body = await response.json();
	if (!response.ok) throw new Error(body.error || "Community catalog request failed.");
	return body;
}
export function CommunityPluginBrowser({ onClose, onInstall }: { onClose: () => void; onInstall: () => void }) {
	const [offers, setOffers] = useState<CommunityOffer[] | null>(null);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [attempt, retry] = useState(0);
	const controller = useRef<AbortController | null>(null);
	const title = useId();
	useEffect(() => {
		const load = new AbortController();
		void json("/api/plugin-catalog", { signal: load.signal }).then(body => {
			if (!load.signal.aborted) setOffers(body.offers);
		}, error => { if (!load.signal.aborted) setProblem(error.message); });
		return () => { load.abort(); controller.current?.abort(); };
	}, [attempt]);
	async function install({ listing, release, action }: CommunityOffer) {
		if (!release || !action || controller.current) return;
		const active = new AbortController();
		controller.current = active;
		setBusy(listing.id); setProblem(null); setNotice(null);
		try {
			const result = await json(`/api/plugin-catalog/${encodeURIComponent(listing.id)}`, {
				method: "POST", headers: { "content-type": "application/json" }, signal: active.signal,
				body: JSON.stringify({ action, sha256: release.sha256 }),
			});
			if (active.signal.aborted) return;
			setNotice(result.restartRequired ? `${listing.name} was updated and is off. Restart LearnHarness before enabling it.` : `${listing.name} was installed and is off. Enable it from Installed if you trust it.`);
			setOffers(items => items?.map(offer => offer.listing.id === listing.id ? { ...offer, action: null } : offer) ?? null);
			onInstall();
		} catch (error) { if (!active.signal.aborted) setProblem(error instanceof Error ? error.message : String(error)); }
		finally { if (controller.current === active) { controller.current = null; if (!active.signal.aborted) setBusy(null); } }
	}
	const match = query.trim().toLocaleLowerCase();
	const visible = offers?.filter(({ listing }) => [listing.name, listing.author, listing.description, listing.id].some(value => value.toLocaleLowerCase().includes(match)))
		.sort((a, b) => a.listing.name.localeCompare(b.listing.name) || a.listing.id.localeCompare(b.listing.id));
	return <HostDialog open aria-labelledby={title} onClose={() => {
		if (controller.current) return "blocked";
		onClose(); return "closed";
	}}
		backdropProps={{ className: "fixed inset-0 flex items-center justify-center bg-background/80" }}
		frame={<div data-testid="community-plugin-browser" className="settings-dialog-pop mx-4 max-h-[85vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-md border border-border bg-card p-5 shadow-xl" />}>
		<div className="flex items-center justify-between gap-3">
			<h2 id={title} className="text-sm uppercase tracking-widest">Browse community plugins</h2>
			<Button type="button" size="icon-sm" variant="ghost" aria-label="Close Browse" disabled={busy !== null} onClick={onClose}><X aria-hidden="true" /></Button>
		</div>
		<label className="block text-sm">Search plugins<input type="search" value={query} onChange={event => setQuery(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm" /></label>
		{problem && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{problem}</p><Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => { setProblem(null); setOffers(null); retry(n => n + 1); }}>Refresh Browse</Button></div>}
		{notice && <p role="status" className="text-sm">{notice}</p>}
		{!offers && !problem && <p role="status" className="text-sm text-muted-foreground">Loading community plugins…</p>}
		{visible?.length === 0 && <p role="status" className="text-sm text-muted-foreground">No plugins match.</p>}
		<div className="grid gap-3 sm:grid-cols-2">
			{visible?.map(offer => {
				const { listing, release, action } = offer;
				const source = communitySource(listing.repository);
				return <article key={listing.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3 text-sm">
					<div className="flex gap-2"><Puzzle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div className="min-w-0"><h3 className="break-words font-semibold">{listing.name}</h3><p className="break-words text-xs text-muted-foreground">{listing.author}</p></div></div>
					<p className="flex-1 break-words font-prose text-muted-foreground">{listing.description}</p>
					<p className="text-xs text-muted-foreground">{release ? <>v{release.version} · <time dateTime={release.publishedAt}>{date(release.publishedAt)}</time></> : "No compatible packaged release"}</p>
					{action && <Button type="button" variant="outline" size="sm" className="self-start" aria-label={`${action} ${listing.name}`} disabled={busy !== null} onClick={() => void install(offer)}>{busy === listing.id ? `${action === "Update" ? "Updating" : "Installing"}…` : action}</Button>}
					<div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
						<a className={pluginLinkClass} href={source} target="_blank" rel="noreferrer">Source</a>
						<a className={pluginLinkClass} href={`${source}/issues`} target="_blank" rel="noreferrer">Plugin bugs</a>
						<a className={pluginLinkClass} href={communityListingReport(listing)} target="_blank" rel="noreferrer">Listing problem</a>
					</div>
				</article>;
			})}
		</div>
		<p className="text-xs text-muted-foreground"><a className={pluginLinkClass} href={COMMUNITY_SECURITY_URL} target="_blank" rel="noreferrer">Report suspected malicious code or security issues privately</a>.</p>
		<p className="text-xs text-muted-foreground">Seeded from the <a className={pluginLinkClass} href={COMMUNITY_CREDIT_URL} target="_blank" rel="noreferrer">awesome list by RA!DEN (tn-lorenz)</a>. Thanks to the plugin authors.</p>
	</HostDialog>;
}
