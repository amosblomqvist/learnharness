import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import coreIds from "../core-plugins.json";
import { COMMUNITY_FEED_LIMIT, COMMUNITY_ZIP_LIMIT, communityReleaseAsset, communitySource, compareCommunityVersions, parseCommunityFeed, REPOSITORY_PATTERN, type CommunityFeed, type CommunityListing, type CommunityRelease } from "../src/core/community-catalog.ts";
import { parsePluginManifest } from "../src/core/plugins.ts";
import { boundedBytes } from "../src/server/community-plugin-catalog.ts";
import { communityZipManifestIds, readCommunityPluginZip } from "../src/server/community-plugin-zip.ts";
import { checkCommunityCatalog } from "./check-community-catalog.ts";

/** Authors opt in to discovery by adding this topic to their repository. */
export const DISCOVERY_TOPIC = "learnharness-plugin";
export const GITHUB_API = "https://api.github.com";
const MAX_RELEASES = 24;
const SEARCH_PAGES = 10;

interface GitHubAsset { name: string; digest?: string | null }
interface GitHubRelease { tag_name: string; published_at: string | null; assets: GitHubAsset[] }
interface GitHubRepo { full_name: string; description: string | null; archived: boolean; owner: { login: string } }
type Lookup<T> = { found: T } | { missing: "not found" | "moved" };

export interface DiscoveryReport {
	checked: number;
	added: { id: string; repository: string; version: string; newListing: boolean; excused: string[] }[];
	failed: { id: string; repository: string; version: string; findings: string[] }[];
	skipped: { repository: string; reason: string }[];
	attention: { repository: string; reason: string }[];
}
interface Candidate { listing: CommunityListing; release: CommunityRelease; newListing: boolean; zip: Buffer }

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
async function listedReleaseProblems(fetcher: typeof fetch, token: string | undefined, listing: CommunityListing): Promise<string[]> {
	const problems: string[] = [];
	for (const release of listing.releases) {
		const result = await github<GitHubRelease>(fetcher, token, `/repos/${listing.repository}/releases/tags/${encodeURIComponent(release.tag)}`);
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

/** Newest first, at most MAX_RELEASES; false when the release is lower than every kept one. */
function addRelease(listing: CommunityListing, release: CommunityRelease): boolean {
	const releases = [release, ...listing.releases];
	while (releases.length > MAX_RELEASES) {
		const lowest = releases.reduce((low, entry) => compareCommunityVersions(entry.version, low.version) < 0 ? entry : low);
		releases.splice(releases.indexOf(lowest), 1);
	}
	if (!releases.includes(release)) return false;
	listing.releases = releases;
	return true;
}

export async function discoverCommunityPlugins(deps: { feed: unknown; exceptions: unknown; fetch?: typeof fetch; token?: string }): Promise<{ feed: CommunityFeed; report: DiscoveryReport }> {
	const fetcher = deps.fetch ?? fetch;
	const feed = parseCommunityFeed(deps.feed, coreIds);
	const report: DiscoveryReport = { checked: 0, added: [], failed: [], skipped: [], attention: [] };
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
		return { release, asset, zip };
	}

	for (const listing of feed.plugins) {
		report.checked++;
		const repo = await github<GitHubRepo>(fetcher, deps.token, `/repos/${listing.repository}`);
		if (!("found" in repo)) { report.attention.push({ repository: listing.repository, reason: `repository ${repo.missing}` }); continue; }
		if (repo.found.archived) { report.attention.push({ repository: listing.repository, reason: "repository is archived" }); continue; }
		for (const reason of await listedReleaseProblems(fetcher, deps.token, listing)) report.attention.push({ repository: listing.repository, reason });
		const found = await latest(listing.repository, true);
		if (!found) continue;
		const packaged = packageRelease(found.zip, listing.id, found.release, found.asset.name);
		if (typeof packaged === "string") { report.skipped.push({ repository: listing.repository, reason: `release ${found.release.tag_name}: ${packaged}` }); continue; }
		const same = listing.releases.find(entry => entry.version === packaged.release.version);
		if (same) { report.skipped.push({ repository: listing.repository, reason: `release ${found.release.tag_name}: version ${same.version} is already listed as tag ${same.tag}` }); continue; }
		candidates.push({ listing, release: packaged.release, newListing: false, zip: found.zip });
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
		fresh.push({ listing: { id, name, author, description, repository: repo.full_name, releases: [] }, release: packaged.release, newListing: true, zip: found.zip });
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
		if (!addRelease(listing, release)) {
			report.skipped.push({ repository: listing.repository, reason: `release ${release.tag}: version ${release.version} is lower than all ${MAX_RELEASES} listed releases` });
			continue;
		}
		if (candidate.newListing) {
			const at = feed.plugins.findIndex(entry => entry.id > listing.id);
			feed.plugins.splice(at < 0 ? feed.plugins.length : at, 0, listing);
		}
		report.added.push({ id: listing.id, repository: listing.repository, version: release.version, newListing: candidate.newListing, excused: result.excused.map(finding => `${finding.rule}${finding.file ? ` ${finding.file}` : ""}`) });
	}
	return { feed: parseCommunityFeed(feed, coreIds), report };
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
	section("Failed checks (not listed)", report.failed.flatMap(entry => [`- ${code(entry.id)} ${entry.version} from ${repoLink(entry.repository)}`, ...entry.findings.map(finding => `  - ${code(finding)}`)]));
	section("Needs attention (listed, nothing removed)", report.attention.map(entry => `- ${repoLink(entry.repository)}: ${code(entry.reason)}`));
	section("Skipped", report.skipped.map(entry => `- ${repoLink(entry.repository)}: ${code(entry.reason)}`));
	return `${lines.join("\n")}\n`;
}

async function main() {
	const args = process.argv.slice(2);
	const reportAt = args[0] === "--report" ? args[1] : undefined;
	if (args.length && (!reportAt || args.length !== 2)) throw new Error("Usage: tsx scripts/discover-community-plugins.ts [--report <file>]");
	const catalog = new URL("../plugin-catalog/community-plugins.json", import.meta.url);
	const before = readFileSync(catalog, "utf8");
	const { feed, report } = await discoverCommunityPlugins({
		feed: JSON.parse(before),
		exceptions: JSON.parse(readFileSync(new URL("../plugin-catalog/check-exceptions.json", import.meta.url), "utf8")),
		token: process.env.GITHUB_TOKEN || undefined,
	});
	const after = serializeCommunityFeed(feed);
	if (Buffer.byteLength(after) > COMMUNITY_FEED_LIMIT) throw new Error("Catalog exceeds public feed size limit");
	if (after !== before) writeFileSync(catalog, after);
	if (reportAt) writeFileSync(reportAt, renderDiscoveryReport(report));
	for (const entry of report.added) console.log(`added    ${entry.id}@${entry.version} ${entry.repository}${entry.newListing ? " (new listing)" : ""}`);
	for (const entry of report.failed) console.log(`failed   ${entry.id}@${entry.version} ${entry.repository}: ${entry.findings.join("; ")}`);
	for (const entry of report.attention) console.log(`attention ${entry.repository}: ${entry.reason}`);
	for (const entry of report.skipped) console.log(`skipped  ${entry.repository}: ${entry.reason}`);
	console.log(`Checked ${report.checked} repositories: ${report.added.length} added, ${report.failed.length} failed checks, ${report.attention.length} need attention, ${report.skipped.length} skipped.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(message(error)); process.exitCode = 2; });
}
