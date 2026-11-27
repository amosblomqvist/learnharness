import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import coreIds from "../core-plugins.json";
import { parseCommunityFeed, type CommunityListing, type CommunityRelease } from "../src/core/community-catalog.ts";
import { boundedBytes, CommunityReleaseError, verifyCommunityRelease } from "../src/server/community-plugin-catalog.ts";
import { applyCheckExceptions, lockedPackages, maliciousDependencies, parseCheckExceptions, scanReleaseFiles, type CatalogFinding, type ReleaseFindings, type ReportedFinding } from "../src/server/community-plugin-checks.ts";

export const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const LOCKFILE_LIMIT = 16 * 1024 * 1024;
const sourceUrl = (listing: CommunityListing, release: CommunityRelease, file: string) => `https://raw.githubusercontent.com/${listing.repository}/${release.tag}/${file}`;

/** The source file at the release tag, or undefined when the repository has none. */
async function sourceFile(fetcher: typeof fetch, listing: CommunityListing, release: CommunityRelease, file: string): Promise<Buffer | undefined> {
	try { return await boundedBytes(fetcher, sourceUrl(listing, release, file), LOCKFILE_LIMIT, AbortSignal.timeout(30_000)); }
	catch (error) {
		if ((error as { status?: number }).status === 404) return undefined;
		throw new Error(`Could not fetch ${file} for ${listing.id}@${release.version}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function dependencyFindings(fetcher: typeof fetch, listing: CommunityListing, release: CommunityRelease): Promise<CatalogFinding[]> {
	const bytes = await sourceFile(fetcher, listing, release, "package-lock.json");
	if (!bytes) {
		// No package.json means no npm dependencies to check (a hand-written dist).
		if (!await sourceFile(fetcher, listing, release, "package.json")) return [];
		return [{ rule: "missing-lockfile", detail: `package.json without package-lock.json at ${listing.repository}@${release.tag}` }];
	}
	const packages = lockedPackages(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
	if (!packages.length) return [];
	const response = await fetcher(OSV_BATCH_URL, {
		method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(60_000),
		body: JSON.stringify({ queries: packages.map(({ name, version }) => ({ package: { name, ecosystem: "npm" }, version })) }),
	});
	if (!response.ok) throw new Error(`OSV query failed for ${listing.id}@${release.version}: HTTP ${response.status}`);
	return maliciousDependencies(packages, await response.json());
}

export async function checkCommunityCatalog(deps: { feed: unknown; exceptions: unknown; fetch?: typeof fetch }) {
	const fetcher = deps.fetch ?? fetch;
	const feed = parseCommunityFeed(deps.feed, coreIds);
	const exceptions = parseCheckExceptions(deps.exceptions);
	const releases: ReleaseFindings[] = [];
	for (const listing of feed.plugins) {
		for (const release of listing.releases) {
			const findings: CatalogFinding[] = [];
			try {
				// Content checks do not depend on this checkout's app version.
				findings.push(...scanReleaseFiles(await verifyCommunityRelease(fetcher, listing, release, release.minAppVersion, AbortSignal.timeout(60_000))));
			} catch (error) {
				const stage = error instanceof CommunityReleaseError ? `${error.stage}: ` : "";
				findings.push({ rule: "release-invalid", detail: `${stage}${error instanceof Error ? error.message : String(error)}` });
			}
			findings.push(...await dependencyFindings(fetcher, listing, release));
			releases.push({ id: listing.id, version: release.version, findings });
		}
	}
	return { releases, ...applyCheckExceptions(releases, exceptions) };
}

const line = (finding: ReportedFinding) => `${finding.id}@${finding.version} ${finding.rule}${finding.file ? ` ${finding.file}` : ""}: ${finding.detail}`;
const annotation = (message: string) => message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

async function main() {
	const read = (name: string) => JSON.parse(readFileSync(new URL(`../plugin-catalog/${name}`, import.meta.url), "utf8"));
	const result = await checkCommunityCatalog({ feed: read("community-plugins.json"), exceptions: read("check-exceptions.json") });
	const actions = process.env.GITHUB_ACTIONS === "true";
	for (const finding of result.excused) console.log(`excused  ${line(finding)}`);
	for (const finding of result.failures) {
		console.log(`FAIL     ${line(finding)}`);
		if (actions) console.log(`::error title=Community catalog check::${annotation(line(finding))}`);
	}
	for (const exception of result.stale) {
		const message = `stale exception ${exception.id}@${exception.version} ${exception.rule}${exception.file ? ` ${exception.file}` : ""} matches no finding`;
		console.log(`FAIL     ${message}`);
		if (actions) console.log(`::error title=Community catalog check::${annotation(message)}`);
	}
	console.log(`Checked ${result.releases.length} release(s): ${result.failures.length} failure(s), ${result.excused.length} excused, ${result.stale.length} stale exception(s).`);
	process.exitCode = result.failures.length || result.stale.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 2; });
}
