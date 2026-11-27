"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Puzzle, X } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { useInteractionLayers } from "@/components/interaction-layers";
import type { CatalogOperation } from "@/components/plugin-manager";
import { Button } from "@/components/ui/button";
import { COMMUNITY_CREDIT_URL, COMMUNITY_SECURITY_URL, communityListingReport, communitySource, type CommunityOffer } from "@/src/core";

export const pluginLinkClass = "underline underline-offset-2 hover:text-foreground";
const date = (timestamp: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(timestamp));
export function CatalogOperationStatus({ operation }: { operation?: CatalogOperation }) {
	return operation && <p role={operation.phase === "error" ? "alert" : "status"} className={operation.phase === "error" ? "text-sm text-destructive" : "text-sm"}>{operation.message}</p>;
}
export function CommunityPluginBrowser({ onClose, onInstall, operation }: { onClose: () => void; onInstall: (offer: CommunityOffer) => void; operation?: CatalogOperation }) {
	const [catalog, setCatalog] = useState<{ offers: CommunityOffer[]; completed?: CatalogOperation } | null>(null);
	const [query, setQuery] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const [attempt, retry] = useState(0);
	const title = useId();
	const interactions = useInteractionLayers();
	const busy = operation?.phase === "pending";
	const completed = operation?.phase === "success" ? operation : undefined;
	useEffect(() => {
		const load = new AbortController();
		void fetch("/api/plugin-catalog", { signal: load.signal }).then(async response => {
			const body = await response.json();
			if (!response.ok) throw new Error(body.error || "Community catalog request failed.");
			if (!load.signal.aborted) { setProblem(null); setCatalog({ offers: body.offers, completed }); }
		}).catch(error => { if (!load.signal.aborted) setProblem(error.message); });
		return () => load.abort();
	}, [attempt, completed]);
	function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
		// The host suppresses native Tab. Cycle only inside this dialog, without
		// changing the app's shortcut policy or trapping other modal layers.
		if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey || !interactions.isElementEligible(event.currentTarget)) return;
		const stops = [...event.currentTarget.querySelectorAll<HTMLElement>("button, input, a[href]")]
			.filter(element => (!element.hasAttribute("tabindex") || element.tabIndex >= 0) && !element.matches(":disabled") && interactions.isElementEligible(element));
		if (!stops.length) return;
		const index = stops.indexOf(document.activeElement as HTMLElement);
		const next = index < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
		event.preventDefault(); event.stopPropagation();
		stops[next]?.focus();
	}
	const match = query.trim().toLocaleLowerCase();
	const visible = catalog?.offers.filter(({ listing }) => [listing.name, listing.author, listing.description, listing.id].some(value => value.toLocaleLowerCase().includes(match)))
		.sort((a, b) => a.listing.name.localeCompare(b.listing.name) || a.listing.id.localeCompare(b.listing.id));
	return <HostDialog open aria-labelledby={title} onClose={() => { onClose(); return "closed"; }}
		backdropProps={{ className: "fixed inset-0 flex items-center justify-center bg-background/80" }}
		frame={<div data-testid="community-plugin-browser" onKeyDown={moveFocus} className="settings-dialog-pop mx-4 max-h-[85vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-md border border-border bg-card p-5 shadow-xl" />}>
		<div className="flex items-center justify-between gap-3">
			<h2 id={title} className="text-sm uppercase tracking-widest">Browse community plugins</h2>
			<Button type="button" size="icon-sm" variant="ghost" aria-label="Close Browse" onClick={onClose}><X aria-hidden="true" /></Button>
		</div>
		<label className="block text-sm">Search plugins<input type="search" value={query} onChange={event => setQuery(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm" /></label>
		{problem && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{problem}</p><Button type="button" variant="outline" size="sm" onClick={() => { setProblem(null); setCatalog(null); retry(n => n + 1); }}>Refresh Browse</Button></div>}
		<CatalogOperationStatus operation={operation} />
		{!catalog && !problem && <p role="status" className="text-sm text-muted-foreground">Loading community plugins…</p>}
		{visible?.length === 0 && <p role="status" className="text-sm text-muted-foreground">No plugins match.</p>}
		<div className="grid gap-3 sm:grid-cols-2">
			{visible?.map(offer => {
				const { listing, release, action } = offer;
				const source = communitySource(listing.repository);
				return <article key={listing.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3 text-sm">
					<div className="flex gap-2"><Puzzle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div className="min-w-0"><h3 className="break-words font-semibold">{listing.name}</h3><p className="break-words text-xs text-muted-foreground">{listing.author}</p></div></div>
					<p className="flex-1 break-words font-prose text-muted-foreground">{listing.description}</p>
					<p className="text-xs text-muted-foreground">{release ? <>v{release.version} · <time dateTime={release.publishedAt}>{date(release.publishedAt)}</time></> : "No compatible packaged release"}</p>
					{action && (catalog?.completed === completed || completed?.id !== listing.id) && <Button type="button" variant="outline" size="sm" className="self-start" aria-label={`${action} ${listing.name}`} disabled={busy} onClick={() => onInstall(offer)}>{busy && operation.id === listing.id ? `${action === "Update" ? "Updating" : "Installing"}…` : action}</Button>}
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
