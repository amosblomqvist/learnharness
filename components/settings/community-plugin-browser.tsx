"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, BadgeCheck } from "lucide-react";
import { HostMarkdown } from "@/components/host-markdown";
import { useInteractionLayers } from "@/components/interaction-layers";
import type { CatalogOperation } from "@/components/plugin-manager";
import { usePlugins } from "@/components/plugins";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	COMMUNITY_CREDIT_URL, COMMUNITY_SECURITY_URL, communityFeatured, communityListingReport, communityOffersFor, communitySource, reviewedCommunityRelease,
	type CommunityDetail, type CommunityOffer, type CommunityView,
} from "@/src/core";
import { communityMarkdown } from "./community-readme";

export const pluginLinkClass = "underline underline-offset-2 hover:text-foreground";
const date = (timestamp: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(timestamp));
const downloads = (count: number) => `${new Intl.NumberFormat().format(count)} ${count === 1 ? "download" : "downloads"}`;
const VIEWS: { id: CommunityView; label: string }[] = [{ id: "featured", label: "Featured" }, { id: "downloads", label: "Most downloaded" }, { id: "newest", label: "Newest" }];
// Third-party Markdown sits below the plugin name: smaller body and headings than chat.
const proseClass = "[--lh-prose-size:14px] [&_[data-streamdown=heading-1]]:text-xl [&_[data-streamdown=heading-2]]:text-lg [&_[data-streamdown=heading-3]]:text-base [&_[data-streamdown^=heading-]]:mt-5";
const reviewedBy = (version: string) => `Reviewed by LearnHarness maintainers (v${version}).`;

export function CatalogOperationStatus({ operation }: { operation?: CatalogOperation }) {
	return operation && <p role={operation.phase === "error" ? "alert" : "status"} className={operation.phase === "error" ? "text-sm text-destructive" : "text-sm"}>{operation.message}</p>;
}

type Catalog = { offers: CommunityOffer[]; completed?: CatalogOperation };
type Props = { onClose: () => void; onInstall: (offer: CommunityOffer) => void; operation?: CatalogOperation };

/** Browse and plugin detail, as pages of the Settings content column. */
export function CommunityPluginBrowser({ onClose, onInstall, operation }: Props) {
	const [catalog, setCatalog] = useState<Catalog | null>(null);
	const [query, setQuery] = useState("");
	const [chosenView, setView] = useState<CommunityView | null>(null);
	const [detail, setDetail] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [attempt, retry] = useState(0);
	const interactions = useInteractionLayers();
	const search = useRef<HTMLInputElement>(null);
	const returnTo = useRef<string | null>(null);
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
	const grid = useRef<HTMLDivElement>(null);
	useEffect(() => { search.current?.focus(); }, []);
	// Back from a detail page lands on the card it was opened from. Catalog IDs are [a-z0-9-], safe in a selector.
	useEffect(() => {
		if (detail || !returnTo.current) return;
		grid.current?.querySelector<HTMLElement>(`[data-plugin="${returnTo.current}"] h3 button`)?.focus();
		returnTo.current = null;
	}, [detail]);
	function moveFocus(event: KeyboardEvent<HTMLElement>) {
		// The host suppresses native Tab. Cycle only inside this page, without
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
	const offer = detail ? catalog?.offers.find(entry => entry.listing.id === detail) : undefined;
	const installs = { catalog, operation, completed, onInstall };
	if (detail && offer) return <section data-testid="community-plugin-detail" onKeyDown={moveFocus} className="px-6 py-5">
		<PluginDetail offer={offer} installs={installs} onBack={() => { returnTo.current = detail; setDetail(null); }} />
	</section>;

	const offers = catalog?.offers ?? [];
	const anyFeatured = offers.some(communityFeatured);
	const view = chosenView ?? (anyFeatured ? "featured" : "downloads");
	const match = query.trim().toLocaleLowerCase();
	const visible = communityOffersFor(offers, view).filter(({ listing }) => [listing.name, listing.author, listing.description, listing.id].some(value => value.toLocaleLowerCase().includes(match)));
	const hidden = offers.filter(entry => !entry.release).length;
	return <section data-testid="community-plugin-browser" onKeyDown={moveFocus} className="flex flex-col gap-4 px-6 py-5">
		<BackButton onClick={onClose}>Community plugins</BackButton>
		<h2 className="text-sm uppercase tracking-widest text-foreground">Browse community plugins</h2>
		<div className="flex flex-wrap items-end gap-3">
			<ViewSwitch view={view} onChange={setView} />
			<label className="min-w-48 flex-1 text-sm">Search plugins<input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" /></label>
		</div>
		{problem && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{problem}</p><Button type="button" variant="outline" size="sm" onClick={() => { setProblem(null); setCatalog(null); retry(n => n + 1); }}>Refresh Browse</Button></div>}
		<CatalogOperationStatus operation={operation} />
		{!catalog && !problem && <p role="status" className="text-sm text-muted-foreground">Loading community plugins…</p>}
		{catalog && view === "featured" && !anyFeatured ? <div className="space-y-2 text-sm text-muted-foreground">
			<p role="status">No featured plugins yet. Featured plugins are reviewed by LearnHarness maintainers.</p>
			<Button type="button" variant="outline" size="sm" onClick={() => setView("downloads")}>Show most downloaded</Button>
		</div> : catalog && visible.length === 0 && <p role="status" className="text-sm text-muted-foreground">No plugins match.</p>}
		<div ref={grid} className="grid gap-3 sm:grid-cols-2">
			{visible.map(entry => <PluginCard key={entry.listing.id} offer={entry} installs={installs} onOpen={() => setDetail(entry.listing.id)} />)}
		</div>
		{hidden > 0 && <p className="text-xs text-muted-foreground">{hidden === 1 ? "1 listing is" : `${hidden} listings are`} hidden because {hidden === 1 ? "it has" : "they have"} no compatible release.</p>}
		<p className="text-xs text-muted-foreground"><a className={pluginLinkClass} href={COMMUNITY_SECURITY_URL} target="_blank" rel="noreferrer">Report suspected malicious code or security issues privately</a>.</p>
		<p className="text-xs text-muted-foreground">Seeded from the <a className={pluginLinkClass} href={COMMUNITY_CREDIT_URL} target="_blank" rel="noreferrer">awesome list by RA!DEN (tn-lorenz)</a>. Thanks to the plugin authors.</p>
	</section>;
}

function BackButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
	return <Button type="button" variant="ghost" size="sm" className="-ml-2 self-start text-muted-foreground" onClick={onClick}><ArrowLeft aria-hidden="true" />{children}</Button>;
}

/** One tab stop; arrow keys move between views, as in a native radio group. */
function ViewSwitch({ view, onChange }: { view: CommunityView; onChange: (view: CommunityView) => void }) {
	const group = useRef<HTMLDivElement>(null);
	function arrows(event: KeyboardEvent<HTMLDivElement>) {
		const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		const next = VIEWS[(VIEWS.findIndex(entry => entry.id === view) + step + VIEWS.length) % VIEWS.length]!;
		onChange(next.id);
		group.current?.querySelector<HTMLElement>(`[data-view="${next.id}"]`)?.focus();
	}
	return <div ref={group} role="radiogroup" aria-label="Sort plugins" onKeyDown={arrows} className="flex max-w-full flex-wrap rounded-md border border-border p-0.5 text-sm">
		{VIEWS.map(entry => <button key={entry.id} type="button" role="radio" data-view={entry.id} aria-checked={view === entry.id} tabIndex={view === entry.id ? 0 : -1} onClick={() => onChange(entry.id)}
			className={cn("rounded-sm px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", view === entry.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>{entry.label}</button>)}
	</div>;
}

function FeaturedMark({ version }: { version: string }) {
	return <span title={reviewedBy(version)} className="inline-flex shrink-0 items-center gap-1 text-xs text-foreground"><BadgeCheck aria-hidden="true" className="size-3.5" />Featured</span>;
}

type Installs = { catalog: Catalog | null; operation?: CatalogOperation; completed?: CatalogOperation; onInstall: (offer: CommunityOffer) => void };
function InstallControl({ offer, installs, className }: { offer: CommunityOffer; installs: Installs; className?: string }) {
	const { snapshot } = usePlugins();
	const { listing, action } = offer, { catalog, operation, completed } = installs;
	const busy = operation?.phase === "pending";
	// After an install, hold the old action until the catalog reloads.
	if (action && (catalog?.completed === completed || completed?.id !== listing.id)) return <Button type="button" variant="outline" size="sm" className={className} aria-label={`${action} ${listing.name}`} disabled={busy} onClick={() => installs.onInstall(offer)}>
		{busy && operation.id === listing.id ? `${action === "Update" ? "Updating" : "Installing"}…` : action}
	</Button>;
	return snapshot.plugins.some(plugin => plugin.info.id === listing.id) ? <span className={cn("text-xs text-muted-foreground", className)}>Installed</span> : null;
}

function PluginCard({ offer, installs, onOpen }: { offer: CommunityOffer; installs: Installs; onOpen: () => void }) {
	const { listing, release } = offer;
	return <article data-plugin={listing.id} className="relative flex min-w-0 flex-col gap-1.5 rounded-md border border-border p-3 text-sm transition-colors hover:bg-accent/40">
		<div className="flex items-baseline justify-between gap-2">
			<h3 className="min-w-0 break-words font-semibold">
				<button type="button" onClick={onOpen}
					className="text-left after:absolute after:inset-0 after:rounded-md after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">{listing.name}</button>
			</h3>
			{communityFeatured(offer) && release && <FeaturedMark version={release.version} />}
		</div>
		<p className="break-words text-xs text-muted-foreground">{listing.author}</p>
		<p className="line-clamp-2 break-words font-prose text-muted-foreground">{listing.description}</p>
		<div className="mt-auto flex items-center justify-between gap-2 pt-1">
			<span className="text-xs text-muted-foreground">{downloads(listing.downloads)}</span>
			<InstallControl offer={offer} installs={installs} className="relative z-10" />
		</div>
	</article>;
}

type DetailState = { detail: CommunityDetail } | { problem: string } | null;
function PluginDetail({ offer, installs, onBack }: { offer: CommunityOffer; installs: Installs; onBack: () => void }) {
	const { listing, release } = offer;
	const [state, setState] = useState<DetailState>(null);
	const [tab, setTab] = useState<"readme" | "changelog">("readme");
	const [attempt, retry] = useState(0);
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => { heading.current?.focus(); }, []);
	useEffect(() => {
		const load = new AbortController();
		void fetch(`/api/plugin-catalog/${encodeURIComponent(listing.id)}`, { signal: load.signal }).then(async response => {
			const body = await response.json();
			if (!response.ok) throw new Error(body.error || "Plugin details are unavailable.");
			if (!load.signal.aborted) setState({ detail: body.detail });
		}).catch(error => { if (!load.signal.aborted) setState({ problem: error.message }); });
		return () => load.abort();
	}, [listing.id, attempt]);
	const source = communitySource(listing.repository);
	const reviewed = reviewedCommunityRelease(listing);
	const featured = communityFeatured(offer) && release;
	return <div className="flex flex-col gap-4">
		<BackButton onClick={onBack}>Browse</BackButton>
		<div className="flex flex-wrap items-start justify-between gap-3">
			<div className="min-w-0">
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<h2 ref={heading} tabIndex={-1} className="break-words text-lg font-semibold focus-visible:outline-none">{listing.name}</h2>
					{featured && <FeaturedMark version={release.version} />}
				</div>
				<p className="break-words text-xs text-muted-foreground">{listing.author}</p>
			</div>
			<InstallControl offer={offer} installs={installs} />
		</div>
		<CatalogOperationStatus operation={installs.operation} />
		<div className="space-y-1 text-xs text-muted-foreground">
			<p>{[downloads(listing.downloads), release && `v${release.version}`].filter(Boolean).join(" · ")}{release && <> · Released <time dateTime={release.publishedAt}>{date(release.publishedAt)}</time></>}</p>
			{featured ? <p className="text-foreground">{reviewedBy(release.version)}</p>
				: reviewed && release && <p>v{reviewed.version} was reviewed by LearnHarness maintainers. v{release.version} has not been reviewed.</p>}
		</div>
		<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
			<a className={pluginLinkClass} href={source} target="_blank" rel="noreferrer">Source</a>
			<a className={pluginLinkClass} href={`${source}/issues`} target="_blank" rel="noreferrer">Plugin bugs</a>
			<a className={pluginLinkClass} href={communityListingReport(listing)} target="_blank" rel="noreferrer">Listing problem</a>
		</div>
		<p className="break-words font-prose text-sm text-muted-foreground">{listing.description}</p>
		<DetailTabs tab={tab} onChange={setTab} />
		<div role="tabpanel" id={`plugin-${tab}`} aria-labelledby={`plugin-${tab}-tab`} className={cn("min-w-0", proseClass)}>
			{!state ? <p role="status" className="text-sm text-muted-foreground">Loading details…</p>
				: "problem" in state ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{state.problem}</p>
					<Button type="button" variant="outline" size="sm" onClick={() => { setState(null); retry(n => n + 1); }}>Try again</Button></div>
					: tab === "readme" ? (state.detail.readme ? <HostMarkdown text={communityMarkdown(state.detail.readme.markdown, listing.repository, state.detail.readme.tag)} />
						: <p className="text-sm text-muted-foreground">This plugin has no README.</p>)
						: <Changelog offer={offer} detail={state.detail} />}
		</div>
	</div>;
}

function DetailTabs({ tab, onChange }: { tab: "readme" | "changelog"; onChange: (tab: "readme" | "changelog") => void }) {
	const tabs = [{ id: "readme", label: "README" }, { id: "changelog", label: "Changelog" }] as const;
	const list = useRef<HTMLDivElement>(null);
	function arrows(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const next = tab === "readme" ? "changelog" : "readme";
		onChange(next);
		list.current?.querySelector<HTMLElement>(`#plugin-${next}-tab`)?.focus();
	}
	return <div ref={list} role="tablist" aria-label="Plugin details" onKeyDown={arrows} className="flex gap-4 border-b border-border text-sm">
		{tabs.map(entry => <button key={entry.id} type="button" role="tab" id={`plugin-${entry.id}-tab`} aria-controls={`plugin-${entry.id}`} aria-selected={tab === entry.id} tabIndex={tab === entry.id ? 0 : -1} onClick={() => onChange(entry.id)}
			className={cn("-mb-px border-b-2 pb-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tab === entry.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{entry.label}</button>)}
	</div>;
}

function Changelog({ offer, detail }: { offer: CommunityOffer; detail: CommunityDetail }) {
	const { listing } = offer;
	const releases = listing.releases.slice().sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
	if (!releases.length) return <p className="text-sm text-muted-foreground">No releases.</p>;
	return <ol className="flex flex-col gap-5">
		{releases.map(release => {
			const notes = detail.releases.find(entry => entry.version === release.version)?.notes.trim();
			return <li key={release.version} className="min-w-0">
				<h3 className="flex flex-wrap items-baseline gap-x-3 text-sm font-semibold">v{release.version}
					<time className="text-xs font-normal text-muted-foreground" dateTime={release.publishedAt}>{date(release.publishedAt)}</time>
					{release.featured && <FeaturedMark version={release.version} />}
				</h3>
				<div className="mt-1.5">{notes ? <HostMarkdown text={communityMarkdown(notes, listing.repository, release.tag)} /> : <p className="text-sm text-muted-foreground">No release notes.</p>}</div>
			</li>;
		})}
	</ol>;
}
