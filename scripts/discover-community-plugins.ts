import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import coreIds from "../core-plugins.json";
import {
	COMMUNITY_DETAIL_LIMIT, COMMUNITY_FEED_LIMIT, COMMUNITY_ZIP_LIMIT, communityReleaseAsset, communitySource, compareCommunityVersions, parseCommunityDetail, parseCommunityFeatured,
	parseCommunityFeed, REPOSITORY_PATTERN, type CommunityDetail, type CommunityFeed, type CommunityListing, type CommunityRelease,
} from "../src/core/community-catalog.ts";
import { parsePluginManifest } from "../src/core/plugins.ts";
import { boundedBytes } from "../src/server/community-plugin-catalog.ts";
import { communityZipManifestIds, readCommunityPluginZip } from "../src/server/community-plugin-zip.ts";
import { checkCommunityCatalog } from "./check-community-catalog.ts";

/** Authors opt in to discovery by adding this topic to their repository. */
export const DISCOVERY_TOPIC = "learnharness-plugin";
export const GITHUB_API = "https://api.github.com";
const MAX_RELEASES = 24;
const SEARCH_PAGES = 10;
const README_LIMIT = 128 * 1024;
const NOTES_LIMIT = 16 * 1024;
/** Enough UTF-8 for README_LIMIT UTF-16 units however the text is encoded, so a longer README is always cut. */
const README_BYTES = 4 * README_LIMIT;

interface GitHubAsset { name: string; digest?: string | null; download_count?: number }
interface GitHubRelease { tag_name: string; published_at: string | null; body?: string | null; assets: GitHubAsset[] }
interface GitHubRepo { full_name: string; description: string | null; archived: boolean; owner: { login: string } }
type Lookup<T> = { found: T } | { missing: "not found" | "moved" };

export interface DiscoveryReport {
	checked: number;
	added: { id: string; repository: string; version: string; newListing: boolean; excused: string[] }[];
	failed: { id: string; repository: string; version: string; findings: string[] }[];
	skipped: { repository: string; reason: string }[];
	/** No repository: a featured.json entry that matches no listed release. */
	attention: { repository?: string; reason: string }[];
	featured: { id: string; version: string; featured: boolean }[];
}
interface Candidate { listing: CommunityListing; release: CommunityRelease; github: GitHubRelease; newListing: boolean; zip: Buffer }
/** GitHub's view of each listed or proposed release, by repository and tag; null when the release is gone. */
type Seen = Map<string, GitHubRelease | null>;
const seenKey = (repository: string, tag: string) => `${repository.toLowerCase()}#${tag}`;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Only api.github.com sees the token; asset, raw and OSV requests stay anonymous. */
async function github<T>(fetcher: typeof fetch, token: string | undefined, path: string): Promise<Lookup<T>> {
	const response = await fetcher(`${GITHUB_API}${path}`, {
		headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404 || response.status === 451) return { missing: "not found" };
	if ([301, 302, 307, 308].includes(response.status)) return { missing: "moved" };
	if (!response.ok) throw new Error(`GitHub API ${path.split("?")[0]}: HTTP ${response.status}`);
	return { found: await response.json() as T };
}

async function topicRepos(fetcher: typeof fetch, token: string | undefined): Promise<GitHubRepo[]> {
	const repos: GitHubRepo[] = [];
	for (let page = 1; page <= SEARCH_PAGES; page++) {
		const query = new URLSearchParams({ q: `topic:${DISCOVERY_TOPIC} archived:false`, per_page: "100", page: String(page) });
		const result = await github<{ items: GitHubRepo[] }>(fetcher, token, `/search/repositories?${query}`);
		if (!("found" in result)) throw new Error("GitHub topic search is unavailable");
		repos.push(...result.found.items);
		if (result.found.items.length < 100) break;
	}
	return repos;
}

/** Listed releases are never removed; a missing or changed one is reported. */
async function listedReleaseProblems(fetcher: typeof fetch, token: string | undefined, listing: CommunityListing, seen: Seen): Promise<string[]> {
	const problems: string[] = [];
	for (const release of listing.releases) {
		const result = await github<GitHubRelease>(fetcher, token, `/repos/${listing.repository}/releases/tags/${encodeURIComponent(release.tag)}`);
		seen.set(seenKey(listing.repository, release.tag), "found" in result ? result.found : null);
		if (!("found" in result)) { problems.push(`listed release ${release.tag} ${result.missing}`); continue; }
		const asset = result.found.assets.find(entry => entry.name === release.asset);
		if (!asset) problems.push(`listed release ${release.tag} no longer has ${release.asset}`);
		else if (asset.digest && asset.digest !== `sha256:${release.sha256}`) problems.push(`listed release ${release.tag} asset ${release.asset} changed (GitHub digest no longer matches the catalog sha256)`);
	}
	return problems;
}

function publishedAt(value: string | null): string | undefined {
	if (!value || !Number.isFinite(Date.parse(value))) return undefined;
	return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Read a release ZIP into a catalog release, or explain why it cannot be listed. */
function packageRelease(zip: Buffer, known: string | undefined, release: GitHubRelease, asset: string): { id: string; manifest: ReturnType<typeof parsePluginManifest>; release: CommunityRelease } | string {
	let id = known;
	try {
		if (!id) {
			const ids = communityZipManifestIds(zip);
			if (ids.length !== 1) return "expected one built manifest at the ZIP root or <id>/dist/";
			if (ids[0]) id = ids[0];
			else {
				const root = JSON.parse(utf8.decode(readCommunityPluginZip(zip, "").get("manifest.json")!)) as { id?: unknown };
				if (typeof root.id !== "string") return "manifest.json has no id";
				id = root.id;
			}
		}
		const raw = readCommunityPluginZip(zip, id).get("manifest.json");
		if (!raw || raw.length > 32 * 1024) return "missing or oversized manifest.json";
		const data = JSON.parse(utf8.decode(raw)) as Record<string, unknown>;
		const manifest = parsePluginManifest(data, id, typeof data.minAppVersion === "string" ? data.minAppVersion : "0.0.0");
		if (release.tag_name !== manifest.version && release.tag_name !== `v${manifest.version}`) return `tag ${release.tag_name} does not match manifest version ${manifest.version}`;
		const published = publishedAt(release.published_at);
		if (!published) return "release has no publish date";
		return { id, manifest, release: { version: manifest.version, apiVersion: manifest.apiVersion, minAppVersion: manifest.minAppVersion, publishedAt: published, tag: release.tag_name, asset, sha256: createHash("sha256").update(zip).digest("hex") } };
	} catch (error) { return `invalid package: ${message(error)}`; }
}

/** Newest first, at most MAX_RELEASES; null when the release is lower than every kept one. */
function withRelease(listing: CommunityListing, release: CommunityRelease): CommunityRelease[] | null {
	const releases = [release, ...listing.releases];
	while (releases.length > MAX_RELEASES) {
		const lowest = releases.reduce((low, entry) => compareCommunityVersions(entry.version, low.version) < 0 ? entry : low);
		releases.splice(releases.indexOf(lowest), 1);
	}
	return releases.includes(release) ? releases : null;
}

const timestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The README at a tag as text; null when the repository has none there. Any other failure throws. */
async function readme(fetcher: typeof fetch, token: string | undefined, repository: string, tag: string): Promise<{ text: string; invalid: boolean } | null> {
	const response = await fetcher(`${GITHUB_API}/repos/${repository}/readme?ref=${encodeURIComponent(tag)}`, {
		headers: { accept: "application/vnd.github.raw+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404) { void response.body?.cancel().catch(() => {}); return null; }
	if (response.status !== 200 || !response.body) {
		void response.body?.cancel().catch(() => {});
		throw new Error(`README at ${tag}: HTTP ${response.status}`);
	}
	const reader = response.body.getReader(), chunks: Uint8Array[] = [];
	let total = 0, cut = false;
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		chunks.push(next.value);
		if ((total += next.value.byteLength) >= README_BYTES) { cut = true; void reader.cancel().catch(() => {}); break; }
	}
	const bytes = Buffer.concat(chunks, total).subarray(0, README_BYTES);
	// A prefix may end inside a character; stream mode leaves that tail out instead of calling it invalid.
	try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: cut }), invalid: false }; }
	catch { return { text: new TextDecoder("utf-8").decode(bytes, { stream: cut }), invalid: true }; }
}

/** Cut at the last line break that leaves room for the marker line. */
function capText(text: string, limit: number, marker: string): string {
	if (text.length <= limit) return text;
	const room = Math.max(0, limit - marker.length - 1);
	let end = text.lastIndexOf("\n", room);
	if (end < 0) end = room;
	if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
	return `${text.slice(0, end)}\n${marker}`;
}

export const serializeCommunityDetail = (detail: CommunityDetail) => `${JSON.stringify(detail, null, 2)}\n`;

/**
 * README at the newest listed tag plus every listed version's release notes. Over-long text is cut with a
 * marker; a file over the size limit empties the oldest notes, then shortens the README. Problems are returned.
 */
async function buildDetail(fetcher: typeof fetch, token: string | undefined, listing: CommunityListing, seen: Seen, previous: CommunityDetail | undefined): Promise<{ detail: CommunityDetail; problems: string[] }> {
	const problems: string[] = [];
	const ordered = [...listing.releases].sort((a, b) => compareCommunityVersions(b.version, a.version));
	const newest = ordered[0]!;
	const source = await readme(fetcher, token, listing.repository, newest.tag);
	const readmeMarker = `… Truncated. Read the full README on GitHub: ${communitySource(listing.repository)}/tree/${newest.tag}`;
	if (source?.invalid) problems.push(`README at ${newest.tag} is not valid UTF-8; invalid bytes are shown as replacement characters`);
	if (source && source.text.length > README_LIMIT) problems.push(`README at ${newest.tag} is over 128 KiB and was truncated`);
	const releases = ordered.map(release => {
		const github = seen.get(seenKey(listing.repository, release.tag));
		const body = github ? (github.body ?? "").replace(/\r\n/g, "\n") : previous?.releases.find(entry => entry.version === release.version)?.notes ?? "";
		if (body.length > NOTES_LIMIT) problems.push(`release notes for ${release.version} are over 16 KiB and were truncated`);
		return { version: release.version, notes: capText(body, NOTES_LIMIT, `… Truncated. Read the full release notes on GitHub: ${communitySource(listing.repository)}/releases/tag/${release.tag}`) };
	});
	const detail: CommunityDetail = { schemaVersion: 1, id: listing.id, readme: source ? { tag: newest.tag, markdown: capText(source.text, README_LIMIT, readmeMarker) } : null, releases };
	const over = () => Buffer.byteLength(serializeCommunityDetail(detail)) - COMMUNITY_DETAIL_LIMIT;
	const emptied: string[] = [];
	for (let index = releases.length - 1; index >= 0 && over() > 0; index--) {
		if (!releases[index]!.notes) continue;
		releases[index]!.notes = "";
		emptied.push(releases[index]!.version);
	}
	if (emptied.length) problems.push(`release notes for ${emptied.join(", ")} were left out to keep the details file under 256 KiB`);
	if (detail.readme && over() > 0) {
		let limit = detail.readme.markdown.length;
		while (over() > 0 && limit > readmeMarker.length + 1) {
			limit = Math.max(readmeMarker.length + 1, limit - over());
			detail.readme.markdown = capText(source!.text, limit, readmeMarker);
		}
		problems.push(`README at ${newest.tag} was shortened to keep the details file under 256 KiB`);
	}
	return { detail: parseCommunityDetail(detail, listing), problems };
}

/** Sum of the listed ZIPs' GitHub download counts; undefined when one of them can't be read. */
function downloadCount(listing: CommunityListing, seen: Seen): number | undefined {
	let total = 0;
	for (const release of listing.releases) {
		const count = seen.get(seenKey(listing.repository, release.tag))?.assets.find(asset => asset.name === release.asset)?.download_count;
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
		total += count;
	}
	return Number.isSafeInteger(total) ? total : undefined;
}

/** Set `featured` on exactly the releases featured.json names; true when any flag changed. */
function syncFeatured(feed: CommunityFeed, list: ReturnType<typeof parseCommunityFeatured>, report: DiscoveryReport): boolean {
	const wanted = new Set(list.featured.map(({ id, sha256 }) => `${id}/${sha256}`));
	let changed = false;
	for (const listing of feed.plugins) for (const release of listing.releases) {
		const key = `${listing.id}/${release.sha256}`;
		const want = wanted.delete(key);
		if (want === (release.featured === true)) continue;
		changed = true;
		report.featured.push({ id: listing.id, version: release.version, featured: want });
		if (want) release.featured = true;
		else delete release.featured;
	}
	for (const entry of wanted) report.attention.push({ reason: `featured.json names ${entry}, which is not a listed release` });
	return changed;
}

/**
 * `details` holds the existing details files by id; the result's `details` holds only the files to write.
 * Download counts are refreshed only when something else changed, so counts alone never open a pull request.
 */
export async function discoverCommunityPlugins(deps: {
	feed: unknown; featured: unknown; details: Record<string, unknown>; exceptions: unknown; fetch?: typeof fetch; token?: string; now?: Date;
}): Promise<{ feed: CommunityFeed; details: Record<string, CommunityDetail>; report: DiscoveryReport }> {
	const fetcher = deps.fetch ?? fetch;
	const feed = parseCommunityFeed(deps.feed, coreIds);
	const featured = parseCommunityFeatured(deps.featured);
	const listedAt = timestamp(deps.now ?? new Date());
	const seen: Seen = new Map();
	const details: Record<string, CommunityDetail> = {};
	const report: DiscoveryReport = { checked: 0, added: [], failed: [], skipped: [], attention: [], featured: [] };
	const listedByRepo = new Map(feed.plugins.map(listing => [listing.repository.toLowerCase(), listing]));
	const listedById = new Map(feed.plugins.map(listing => [listing.id, listing]));
	const newRepos = (await topicRepos(fetcher, deps.token))
		.filter(repo => REPOSITORY_PATTERN.test(repo.full_name) && !listedByRepo.has(repo.full_name.toLowerCase()))
		.sort((a, b) => a.full_name.toLowerCase().localeCompare(b.full_name.toLowerCase()));
	const candidates: Candidate[] = [];

	async function latest(repository: string, listed: boolean): Promise<{ release: GitHubRelease; asset: GitHubAsset; zip: Buffer } | undefined> {
		const result = await github<GitHubRelease>(fetcher, deps.token, `/repos/${repository}/releases/latest`);
		if (!("found" in result)) {
			(listed ? report.attention : report.skipped).push({ repository, reason: "no stable GitHub release" });
			return undefined;
		}
		const release = result.found;
		const listing = listedByRepo.get(repository.toLowerCase());
		if (listing?.releases.some(entry => entry.tag === release.tag_name)) return undefined;
		const zips = release.assets.filter(asset => asset.name.toLowerCase().endsWith(".zip"));
		if (zips.length !== 1) {
			report.skipped.push({ repository, reason: `release ${release.tag_name} has ${zips.length} uploaded .zip assets; expected exactly one` });
			return undefined;
		}
		const asset = zips[0]!;
		let zip: Buffer;
		try { zip = await boundedBytes(fetcher, communityReleaseAsset({ repository } as CommunityListing, { tag: release.tag_name, asset: asset.name } as CommunityRelease), COMMUNITY_ZIP_LIMIT, AbortSignal.timeout(60_000), true); }
		catch (error) {
			report.skipped.push({ repository, reason: `release ${release.tag_name}: could not download ${asset.name}: ${message(error)}` });
			return undefined;
		}
		if (asset.digest && asset.digest !== `sha256:${createHash("sha256").update(zip).digest("hex")}`) {
			report.skipped.push({ repository, reason: `release ${release.tag_name}: downloaded ${asset.name} does not match GitHub's digest` });
			return undefined;
		}
		seen.set(seenKey(repository, release.tag_name), release);
		return { release, asset, zip };
	}

	for (const listing of feed.plugins) {
		report.checked++;
		const repo = await github<GitHubRepo>(fetcher, deps.token, `/repos/${listing.repository}`);
		if (!("found" in repo)) { report.attention.push({ repository: listing.repository, reason: `repository ${repo.missing}` }); continue; }
		if (repo.found.archived) { report.attention.push({ repository: listing.repository, reason: "repository is archived" }); continue; }
		for (const reason of await listedReleaseProblems(fetcher, deps.token, listing, seen)) report.attention.push({ repository: listing.repository, reason });
		const found = await latest(listing.repository, true);
		if (!found) continue;
		const packaged = packageRelease(found.zip, listing.id, found.release, found.asset.name);
		if (typeof packaged === "string") { report.skipped.push({ repository: listing.repository, reason: `release ${found.release.tag_name}: ${packaged}` }); continue; }
		const same = listing.releases.find(entry => entry.version === packaged.release.version);
		if (same) { report.skipped.push({ repository: listing.repository, reason: `release ${found.release.tag_name}: version ${same.version} is already listed as tag ${same.tag}` }); continue; }
		candidates.push({ listing, release: packaged.release, github: found.release, newListing: false, zip: found.zip });
	}

	const claimed = new Map<string, string[]>();
	const fresh: Candidate[] = [];
	for (const repo of newRepos) {
		report.checked++;
		const found = await latest(repo.full_name, false);
		if (!found) continue;
		const packaged = packageRelease(found.zip, undefined, found.release, found.asset.name);
		if (typeof packaged === "string") { report.skipped.push({ repository: repo.full_name, reason: `release ${found.release.tag_name}: ${packaged}` }); continue; }
		const { id, manifest } = packaged;
		const name = manifest.name.trim(), author = manifest.author?.trim() || repo.owner.login, description = manifest.description?.trim() || repo.description?.trim() || "";
		const owner = listedById.get(id);
		let reason: string | undefined;
		if (coreIds.includes(id)) reason = `id ${id} is reserved by a Core plugin`;
		else if (owner) reason = `id ${id} is already listed for ${owner.repository}`;
		else if (!description) reason = "no description in manifest.json or the GitHub repository";
		else if (name.length > 128 || author.length > 128 || description.length > 512) reason = "name or author over 128 characters, or description over 512";
		if (reason) { report.skipped.push({ repository: repo.full_name, reason }); continue; }
		claimed.set(id, [...claimed.get(id) ?? [], repo.full_name]);
		fresh.push({ listing: { id, name, author, description, repository: repo.full_name, downloads: 0, listedAt, releases: [] }, release: packaged.release, github: found.release, newListing: true, zip: found.zip });
	}
	for (const candidate of fresh) {
		const repos = claimed.get(candidate.listing.id)!;
		if (repos.length > 1) report.skipped.push({ repository: candidate.listing.repository, reason: `id ${candidate.listing.id} is claimed by more than one new repository (${repos.join(", ")}); a maintainer decides` });
		else candidates.push(candidate);
	}

	for (const candidate of candidates) {
		const { listing, release } = candidate;
		const single = { schemaVersion: 1, plugins: [{ ...listing, releases: [release] }] };
		try { parseCommunityFeed(single, coreIds); }
		catch (error) { report.skipped.push({ repository: listing.repository, reason: `release ${release.tag}: ${message(error)}` }); continue; }
		const assetUrl = communityReleaseAsset(listing, release);
		const cached: typeof fetch = (input, init) => String(input) === assetUrl ? Promise.resolve(new Response(Uint8Array.from(candidate.zip))) : fetcher(input, init);
		let result: Awaited<ReturnType<typeof checkCommunityCatalog>>;
		try { result = await checkCommunityCatalog({ feed: single, exceptions: deps.exceptions, fetch: cached }); }
		catch (error) { report.skipped.push({ repository: listing.repository, reason: `release ${release.tag}: checks could not run: ${message(error)}` }); continue; }
		if (result.failures.length) {
			report.failed.push({ id: listing.id, repository: listing.repository, version: release.version, findings: result.failures.map(finding => `${finding.rule}${finding.file ? ` ${finding.file}` : ""}: ${finding.detail}`) });
			continue;
		}
		const releases = withRelease(listing, release);
		if (!releases) {
			report.skipped.push({ repository: listing.repository, reason: `release ${release.tag}: version ${release.version} is lower than all ${MAX_RELEASES} listed releases` });
			continue;
		}
		let built: Awaited<ReturnType<typeof buildDetail>>;
		const previous = (() => { try { return parseCommunityDetail(deps.details[listing.id], listing); } catch { return undefined; } })();
		try { built = await buildDetail(fetcher, deps.token, { ...listing, releases }, seen, previous); }
		catch (error) { report.skipped.push({ repository: listing.repository, reason: `release ${release.tag}: details could not be built, retried next run: ${message(error)}` }); continue; }
		listing.releases = releases;
		details[listing.id] = built.detail;
		for (const problem of built.problems) report.attention.push({ repository: listing.repository, reason: `details: ${problem}` });
		if (candidate.newListing) {
			const at = feed.plugins.findIndex(entry => entry.id > listing.id);
			feed.plugins.splice(at < 0 ? feed.plugins.length : at, 0, listing);
		}
		report.added.push({ id: listing.id, repository: listing.repository, version: release.version, newListing: candidate.newListing, excused: result.excused.map(finding => `${finding.rule}${finding.file ? ` ${finding.file}` : ""}`) });
	}
	const flagsChanged = syncFeatured(feed, featured, report);
	if (report.added.length || flagsChanged) {
		for (const listing of feed.plugins) listing.downloads = downloadCount(listing, seen) ?? listing.downloads;
	}
	return { feed: parseCommunityFeed(feed, coreIds), details, report };
}

export const serializeCommunityFeed = (feed: CommunityFeed) => `${JSON.stringify(feed, null, 2)}\n`;

/** Untrusted text as an inline code span, so it cannot mention, link or format. */
export function code(value: string): string {
	const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
	const fence = "`".repeat(Math.max(0, ...[...flat.matchAll(/`+/g)].map(run => run[0].length)) + 1);
	return `${fence} ${flat} ${fence}`;
}
const repoLink = (repository: string) => `[${repository}](${communitySource(repository)})`;

export function renderDiscoveryReport(report: DiscoveryReport): string {
	const lines = [
		"Automatic discovery for the community plugin catalog. Each release below passed `npm run catalog:check` in the discovery run. Merging lists it; it is not a code review.",
		"",
		`Checked ${report.checked} repositor${report.checked === 1 ? "y" : "ies"} (topic \`${DISCOVERY_TOPIC}\` and existing listings).`,
	];
	const section = (title: string, rows: string[]) => { if (rows.length) lines.push("", `### ${title}`, "", ...rows); };
	section("Added", report.added.map(entry => `- ${code(entry.id)} ${entry.version} from ${repoLink(entry.repository)}${entry.newListing ? " (new listing)" : ""}${entry.excused.length ? `, excused: ${entry.excused.map(code).join(", ")}` : ""}`));
	section("Featured (from featured.json)", report.featured.map(entry => `- ${code(entry.id)} ${entry.version}: ${entry.featured ? "marked featured" : "featured mark removed"}`));
	section("Failed checks (not listed)", report.failed.flatMap(entry => [`- ${code(entry.id)} ${entry.version} from ${repoLink(entry.repository)}`, ...entry.findings.map(finding => `  - ${code(finding)}`)]));
	section("Needs attention (listed, nothing removed)", report.attention.map(entry => `- ${entry.repository ? repoLink(entry.repository) : "`featured.json`"}: ${code(entry.reason)}`));
	section("Skipped", report.skipped.map(entry => `- ${repoLink(entry.repository)}: ${code(entry.reason)}`));
	return `${lines.join("\n")}\n`;
}

async function main() {
	const args = process.argv.slice(2);
	const reportAt = args[0] === "--report" ? args[1] : undefined;
	if (args.length && (!reportAt || args.length !== 2)) throw new Error("Usage: tsx scripts/discover-community-plugins.ts [--report <file>]");
	const catalog = new URL("../plugin-catalog/community-plugins.json", import.meta.url);
	const detailsDirectory = new URL("../plugin-catalog/details/", import.meta.url);
	const before = readFileSync(catalog, "utf8");
	const { feed, details, report } = await discoverCommunityPlugins({
		feed: JSON.parse(before),
		featured: JSON.parse(readFileSync(new URL("../plugin-catalog/featured.json", import.meta.url), "utf8")),
		details: Object.fromEntries(readdirSync(detailsDirectory).filter(name => name.endsWith(".json")).map(name => [name.slice(0, -5), JSON.parse(readFileSync(new URL(name, detailsDirectory), "utf8"))])),
		exceptions: JSON.parse(readFileSync(new URL("../plugin-catalog/check-exceptions.json", import.meta.url), "utf8")),
		token: process.env.GITHUB_TOKEN || undefined,
	});
	const after = serializeCommunityFeed(feed);
	if (Buffer.byteLength(after) > COMMUNITY_FEED_LIMIT) throw new Error("Catalog exceeds public feed size limit");
	if (after !== before) writeFileSync(catalog, after);
	for (const [id, detail] of Object.entries(details)) writeFileSync(new URL(`${id}.json`, detailsDirectory), serializeCommunityDetail(detail));
	if (reportAt) writeFileSync(reportAt, renderDiscoveryReport(report));
	for (const entry of report.added) console.log(`added    ${entry.id}@${entry.version} ${entry.repository}${entry.newListing ? " (new listing)" : ""}`);
	for (const entry of report.featured) console.log(`featured ${entry.id}@${entry.version}: ${entry.featured ? "marked" : "unmarked"}`);
	for (const entry of report.failed) console.log(`failed   ${entry.id}@${entry.version} ${entry.repository}: ${entry.findings.join("; ")}`);
	for (const entry of report.attention) console.log(`attention ${entry.repository ?? "featured.json"}: ${entry.reason}`);
	for (const entry of report.skipped) console.log(`skipped  ${entry.repository}: ${entry.reason}`);
	console.log(`Checked ${report.checked} repositories: ${report.added.length} added, ${report.failed.length} failed checks, ${report.attention.length} need attention, ${report.skipped.length} skipped.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(message(error)); process.exitCode = 2; });
}
