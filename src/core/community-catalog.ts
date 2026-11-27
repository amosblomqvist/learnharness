export const COMMUNITY_FEED_URL = "https://learnharness.ai/community-plugins.json";
export const communityDetailUrl = (id: string) => `https://learnharness.ai/community-plugins/${id}.json`;
export const COMMUNITY_SECURITY_URL = "https://github.com/amosblomqvist/learnharness/security/advisories/new";
export const COMMUNITY_CREDIT_URL = "https://github.com/tn-lorenz/awesome-learnharness";
export const COMMUNITY_FEED_LIMIT = 256 * 1024;
export const COMMUNITY_DETAIL_LIMIT = 256 * 1024;
export const COMMUNITY_ZIP_LIMIT = 16 * 1024 * 1024;
export const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export interface CommunityRelease {
	version: string;
	apiVersion: number;
	minAppVersion: string;
	publishedAt: string;
	tag: string;
	asset: string;
	sha256: string;
	/** Present only on a release a maintainer reviewed (plugin-catalog/featured.json). */
	featured?: true;
}
export interface CommunityListing {
	id: string;
	name: string;
	author: string;
	description: string;
	repository: string;
	/** Sum of GitHub download counts of the listed release ZIPs, taken when the feed was built. */
	downloads: number;
	/** When the plugin first entered the feed. */
	listedAt: string;
	releases: CommunityRelease[];
}
export interface CommunityFeed { schemaVersion: 1; plugins: CommunityListing[] }
export type CommunityOffer = { listing: CommunityListing; release: CommunityRelease | null; action: "Install" | "Update" | null };

const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const text = (value: unknown, limit: number): value is string => typeof value === "string" && !!value.trim() && value.length <= limit;
const like = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid community catalog object");
	return value as Record<string, unknown>;
}
function published(value: unknown): value is string {
	return like(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;
}
export function parseCommunityFeed(data: unknown, reservedIds: readonly string[] = []): CommunityFeed {
	const feed = record(data);
	if (feed.schemaVersion !== 1 || !Array.isArray(feed.plugins) || feed.plugins.length > 256) throw new Error("Unsupported community catalog");
	const ids = new Set(reservedIds);
	const plugins = feed.plugins.map((value: unknown): CommunityListing => {
		const { id, name, author, description, repository, downloads, listedAt, releases } = record(value);
		if (!like(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/) || id.length > 80 || ids.has(id) || !text(name, 128) || !text(author, 128) || !text(description, 512) || !like(repository, REPOSITORY_PATTERN)
			|| typeof downloads !== "number" || !Number.isSafeInteger(downloads) || downloads < 0 || !published(listedAt) || !Array.isArray(releases) || releases.length > 24) throw new Error("Invalid community catalog listing");
		ids.add(id);
		const versions = new Set<string>();
		return { id, name, author, description, repository, downloads, listedAt, releases: releases.map((entry: unknown): CommunityRelease => {
			const { version, apiVersion, minAppVersion, publishedAt, tag, asset, sha256, featured } = record(entry);
			if (!like(version, versionPattern) || versions.has(version) || typeof apiVersion !== "number" || !Number.isSafeInteger(apiVersion) || apiVersion < 1 || !like(minAppVersion, versionPattern) || !published(publishedAt) || (tag !== version && tag !== `v${version}`) || !like(asset, /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}\.zip$/) || !like(sha256, SHA256_PATTERN) || (featured !== undefined && featured !== true)) throw new Error("Invalid community release metadata");
			versions.add(version);
			return { version, apiVersion, minAppVersion, publishedAt, tag, asset, sha256, ...(featured ? { featured } : {}) };
		}) };
	});
	return { schemaVersion: 1, plugins };
}
export function compareCommunityVersions(a: string, b: string): number {
	const left = a.split(".").map(Number), right = b.split(".").map(Number);
	return (left[0]! - right[0]!) || (left[1]! - right[1]!) || (left[2]! - right[2]!);
}
export function compatibleCommunityRelease(listing: CommunityListing, appVersion: string, apiVersion: number): CommunityRelease | null {
	return listing.releases.filter(release => release.apiVersion === apiVersion && compareCommunityVersions(appVersion, release.minAppVersion) >= 0)
		.sort((a, b) => compareCommunityVersions(b.version, a.version))[0] ?? null;
}
export const communitySource = (repository: string) => `https://github.com/${repository}`;
export function communityReleaseAsset(listing: CommunityListing, release: CommunityRelease) {
	return `${communitySource(listing.repository)}/releases/download/${release.tag}/${release.asset}`;
}
export function communityListingReport({ id, repository }: Pick<CommunityListing, "id" | "repository">) {
	const params = new URLSearchParams({ labels: "community-plugin", title: `Catalog listing: ${id}`, body: `Plugin ID: ${id}\nSource: ${communitySource(repository)}\n\nWhat is wrong with the listing?\n\nFor suspected malicious code or security problems, use private vulnerability reporting instead.` });
	return `https://github.com/amosblomqvist/learnharness/issues/new?${params}`;
}

export type CommunityView = "featured" | "downloads" | "newest";
/** The mark belongs to a reviewed release, so a newer unreviewed one drops it. */
export const communityFeatured = (offer: Pick<CommunityOffer, "release">) => offer.release?.featured === true;
export function reviewedCommunityRelease(listing: CommunityListing): CommunityRelease | null {
	return listing.releases.filter(release => release.featured).sort((a, b) => compareCommunityVersions(b.version, a.version))[0] ?? null;
}
/** Browse lists only offers with a compatible release; ties fall back to name, then id. */
export function communityOffersFor<T extends CommunityOffer>(offers: readonly T[], view: CommunityView): T[] {
	const byName = (a: T, b: T) => a.listing.name.localeCompare(b.listing.name) || a.listing.id.localeCompare(b.listing.id);
	const key = view === "newest" ? (offer: T) => Date.parse(offer.listing.listedAt) : (offer: T) => offer.listing.downloads;
	return offers.filter(offer => offer.release && (view !== "featured" || communityFeatured(offer))).sort((a, b) => (key(b) - key(a)) || byName(a, b));
}

export interface CommunityFeatured { schemaVersion: 1; featured: { id: string; sha256: string }[] }
/** Maintainer-kept review list. Discovery never writes it. */
export function parseCommunityFeatured(data: unknown): CommunityFeatured {
	const file = record(data);
	if (file.schemaVersion !== 1 || !Array.isArray(file.featured) || file.featured.length > 256) throw new Error("Unsupported featured list");
	const seen = new Set<string>();
	return { schemaVersion: 1, featured: file.featured.map((value: unknown) => {
		const { id, sha256, ...rest } = record(value);
		if (typeof id !== "string" || !like(sha256, SHA256_PATTERN) || Object.keys(rest).length || seen.has(`${id}/${sha256}`)) throw new Error("Invalid featured entry");
		seen.add(`${id}/${sha256}`);
		return { id, sha256 };
	}) };
}
/** The feed's featured flags must be exactly the reviewed releases in the featured list. */
export function checkCommunityFeatured(feed: CommunityFeed, list: CommunityFeatured) {
	const wanted = new Set(list.featured.map(({ id, sha256 }) => `${id}/${sha256}`));
	for (const listing of feed.plugins) for (const release of listing.releases) {
		const key = `${listing.id}/${release.sha256}`;
		if (wanted.delete(key) !== (release.featured === true)) throw new Error(`Featured flag out of sync with featured.json: ${listing.id} ${release.version}`);
	}
	const [missing] = wanted;
	if (missing) throw new Error(`featured.json names a release that is not in the feed: ${missing}`);
}

export interface CommunityDetail {
	schemaVersion: 1;
	id: string;
	readme: { tag: string; markdown: string } | null;
	releases: { version: string; notes: string }[];
}
/** Snapshot of README and release notes, cross-checked against the listing it belongs to. */
export function parseCommunityDetail(data: unknown, listing: CommunityListing): CommunityDetail {
	const detail = record(data);
	const { schemaVersion, id, readme, releases } = detail;
	if (schemaVersion !== 1 || id !== listing.id || !Array.isArray(releases) || releases.length > 24) throw new Error("Invalid community plugin details");
	let snapshot: CommunityDetail["readme"] = null;
	if (readme !== null) {
		const { tag, markdown } = record(readme);
		if (!listing.releases.some(release => release.tag === tag) || typeof markdown !== "string" || markdown.length > 128 * 1024) throw new Error("Invalid community plugin README");
		snapshot = { tag: tag as string, markdown };
	}
	const versions = new Set<string>();
	return { schemaVersion: 1, id, readme: snapshot, releases: releases.map((entry: unknown) => {
		const { version, notes } = record(entry);
		if (typeof version !== "string" || versions.has(version) || !listing.releases.some(release => release.version === version) || typeof notes !== "string" || notes.length > 16 * 1024) throw new Error("Invalid community release notes");
		versions.add(version);
		return { version, notes };
	}) };
}
