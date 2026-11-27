export const COMMUNITY_FEED_URL = "https://learnharness.ai/community-plugins.json";
export const COMMUNITY_SECURITY_URL = "https://github.com/amosblomqvist/learnharness/security/advisories/new";
export const COMMUNITY_CREDIT_URL = "https://github.com/tn-lorenz/awesome-learnharness";
export const COMMUNITY_FEED_LIMIT = 256 * 1024;
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
}
export interface CommunityListing {
	id: string;
	name: string;
	author: string;
	description: string;
	repository: string;
	releases: CommunityRelease[];
}
/** Remote kill switch for catalog installs from `repository`. No versions = every version. */
export interface CommunityRevocation {
	id: string;
	repository: string;
	versions?: string[];
	reason: string;
}
export interface CommunityFeed { schemaVersion: 1; plugins: CommunityListing[]; revoked: CommunityRevocation[] }
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
		const { id, name, author, description, repository, releases } = record(value);
		if (!like(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/) || id.length > 80 || ids.has(id) || !text(name, 128) || !text(author, 128) || !text(description, 512) || !like(repository, REPOSITORY_PATTERN) || !Array.isArray(releases) || releases.length > 24) throw new Error("Invalid community catalog listing");
		ids.add(id);
		const versions = new Set<string>();
		return { id, name, author, description, repository, releases: releases.map((entry: unknown): CommunityRelease => {
			const { version, apiVersion, minAppVersion, publishedAt, tag, asset, sha256 } = record(entry);
			if (!like(version, versionPattern) || versions.has(version) || typeof apiVersion !== "number" || !Number.isSafeInteger(apiVersion) || apiVersion < 1 || !like(minAppVersion, versionPattern) || !published(publishedAt) || (tag !== version && tag !== `v${version}`) || !like(asset, /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}\.zip$/) || !like(sha256, SHA256_PATTERN)) throw new Error("Invalid community release metadata");
			versions.add(version);
			return { version, apiVersion, minAppVersion, publishedAt, tag, asset, sha256 };
		}) };
	});
	return { schemaVersion: 1, plugins, revoked: parseCommunityRevocations(feed.revoked ?? []) };
}
export function parseCommunityRevocations(data: unknown): CommunityRevocation[] {
	if (!Array.isArray(data) || data.length > 256) throw new Error("Invalid community revocations");
	return data.map((value: unknown): CommunityRevocation => {
		const { id, repository, versions, reason } = record(value);
		if (!like(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/) || id.length > 80 || !like(repository, REPOSITORY_PATTERN) || !text(reason, 512)) throw new Error("Invalid community revocation");
		if (versions === undefined) return { id, repository, reason };
		if (!Array.isArray(versions) || !versions.length || versions.length > 64 || new Set(versions).size !== versions.length || !versions.every(version => like(version, versionPattern))) throw new Error("Invalid community revocation versions");
		return { id, repository, versions: [...versions] as string[], reason };
	});
}
/** The reason a catalog install of `id` from `repository` at `version` is revoked, if it is. */
export function communityRevocation(revoked: readonly CommunityRevocation[], id: string, repository: string, version: string): string | undefined {
	return revoked.find(entry => entry.id === id && entry.repository === repository && (!entry.versions || entry.versions.includes(version)))?.reason;
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
