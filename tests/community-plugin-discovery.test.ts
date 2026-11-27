import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { checkCommunityFeatured, parseCommunityDetail, parseCommunityFeatured, parseCommunityFeed, type CommunityListing, type CommunityRelease } from "../src/core/community-catalog.ts";
import { communityZipManifestIds } from "../src/server/community-plugin-zip.ts";
import { code, discoverCommunityPlugins, GITHUB_API, renderDiscoveryReport, serializeCommunityDetail, serializeCommunityFeed } from "../scripts/discover-community-plugins.ts";
import { OSV_BATCH_URL } from "../scripts/check-community-catalog.ts";
import { zip } from "./community-zip.ts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const noExceptions = { schemaVersion: 1, exceptions: [] };
const noFeatured = { schemaVersion: 1, featured: [] };
const now = new Date("2026-11-27T05:23:41.512Z");
type Deps = Parameters<typeof discoverCommunityPlugins>[0];
/** Discovery with no featured releases, no details files and a fixed clock unless a test says otherwise. */
const discover = (deps: Pick<Deps, "feed" | "fetch"> & Partial<Deps>) => discoverCommunityPlugins({ featured: noFeatured, details: {}, exceptions: noExceptions, now, ...deps });
type Manifest = Record<string, unknown>;
function plugin(id: string, version: string, options: { wrapped?: boolean; manifest?: Manifest; main?: string } = {}) {
	const manifest = { id, name: `Plugin ${id}`, version, minAppVersion: "0.7.0", apiVersion: 1, main: "main.js", ...options.manifest };
	const prefix = options.wrapped ? `${id}/dist/` : "";
	return zip([[`${prefix}manifest.json`, JSON.stringify(manifest)], [`${prefix}main.js`, options.main ?? "export function activate() {}"]]);
}
const listed = (id: string, repository: string, releases: Partial<CommunityRelease>[] = []): CommunityListing => ({
	id, name: `Hand name ${id}`, author: "Hand author", description: "Hand description", repository, downloads: 0, listedAt: "2026-01-02T03:04:05Z",
	releases: releases.map(release => ({ version: "1.0.0", apiVersion: 1, minAppVersion: "0.7.0", publishedAt: "2026-11-01T00:00:00Z", tag: "v1.0.0", asset: `${id}.zip`, sha256: "0".repeat(64), ...release })),
});

interface Release { tag: string; assets: { name: string; bytes?: Buffer; digest?: string | null; downloads?: number }[]; published?: string; body?: string }
/** `readme` by tag: the file's text or bytes, or an HTTP status to answer with. */
interface Repo { description?: string | null; archived?: boolean; owner?: string; latest?: Release; tags?: Release[]; readme?: Record<string, string | Buffer | number> }

/** A fake GitHub: topic search, repos, releases, asset downloads, plus raw and OSV for the checks. */
function github(world: { topic?: string[]; repos: Record<string, Repo> }) {
	const requests: { url: string; authorization: string | null }[] = [];
	const repo = (name: string) => Object.entries(world.repos).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
	const shape = (full_name: string, value: Repo) => ({ full_name, description: value.description ?? null, archived: !!value.archived, owner: { login: value.owner ?? full_name.split("/")[0] } });
	const release = (value: Release) => ({
		tag_name: value.tag, published_at: value.published ?? "2026-11-20T10:00:00Z", body: value.body ?? null,
		assets: value.assets.map(({ name, bytes, digest, downloads }) => ({ name, digest: digest === undefined ? (bytes ? `sha256:${sha(bytes)}` : null) : digest, ...downloads === undefined ? {} : { download_count: downloads } })),
	});
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
		if (url.startsWith(`${GITHUB_API}/search/repositories?`)) {
			const items = (world.topic ?? []).map(name => shape(name, repo(name)!));
			return Response.json({ items });
		}
		let match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/readme\?ref=(.+)$/.exec(url);
		if (match) {
			assert.equal(new Headers(init?.headers).get("accept"), "application/vnd.github.raw+json");
			const found = repo(match[1]!)?.readme?.[decodeURIComponent(match[2]!)];
			if (found === undefined) return new Response("", { status: 404 });
			return typeof found === "number" ? new Response("", { status: found }) : new Response(Uint8Array.from(Buffer.from(found)));
		}
		match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)(\/releases\/(?:latest|tags\/(.+)))?$/.exec(url);
		if (match) {
			const value = repo(match[1]!);
			if (!value) return new Response("", { status: 404 });
			if (!match[2]) return Response.json(shape(match[1]!, value));
			const found = match[3] ? [...value.tags ?? [], ...value.latest ? [value.latest] : []].find(entry => entry.tag === decodeURIComponent(match![3]!)) : value.latest;
			return found ? Response.json(release(found)) : new Response("", { status: 404 });
		}
		match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(url);
		if (match) {
			const value = repo(match[1]!);
			const bytes = [...value?.tags ?? [], ...value?.latest ? [value.latest] : []].find(entry => entry.tag === match![2])?.assets.find(asset => asset.name === match![3])?.bytes;
			return bytes ? new Response(Uint8Array.from(bytes)) : new Response("", { status: 404 });
		}
		if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("", { status: 404 });
		if (url === OSV_BATCH_URL) return Response.json({ results: [] });
		throw new Error(`unexpected request ${url}`);
	};
	return { fetcher, requests };
}

test("manifest ids are read from the root or the wrapped <id>/dist/ layout", () => {
	assert.deepEqual(communityZipManifestIds(plugin("root-one", "1.0.0")), [""]);
	assert.deepEqual(communityZipManifestIds(plugin("wrapped-one", "1.0.0", { wrapped: true })), ["wrapped-one"]);
	assert.deepEqual(communityZipManifestIds(zip([["a/dist/manifest.json", "{}"], ["manifest.json", "{}"], ["a/docs/manifest.json", "{}"]])), ["a", ""]);
});

test("discovery lists new topic repos and appends new releases without touching listings", async () => {
	const fresh = plugin("fresh", "0.2.0", { wrapped: true, manifest: { description: "  From the manifest. " } });
	const fallback = plugin("fallback", "1.0.0");
	const update = plugin("kept", "2.0.0");
	const { fetcher, requests } = github({
		topic: ["New/fresh-plugin", "Other/fallback-plugin", "owner/kept-plugin"],
		repos: {
			"New/fresh-plugin": { latest: { tag: "v0.2.0", assets: [{ name: "fresh.zip", bytes: fresh }, { name: "notes.txt" }] } },
			"Other/fallback-plugin": { description: "Repository description", owner: "octo", latest: { tag: "1.0.0", assets: [{ name: "fallback-1.0.0.zip", bytes: fallback }] } },
			"owner/kept-plugin": { latest: { tag: "v2.0.0", assets: [{ name: "kept-2.0.0.zip", bytes: update }] }, tags: [{ tag: "v1.0.0", assets: [{ name: "kept.zip", digest: null }] }] },
			"owner/current": { latest: { tag: "v1.0.0", assets: [{ name: "current.zip", digest: null }] } },
		},
	});
	const feed = { schemaVersion: 1, plugins: [listed("current", "owner/current", [{}]), listed("kept", "owner/kept-plugin", [{ asset: "kept.zip" }])] };
	const result = await discover({ feed, fetch: fetcher, token: "secret-token" });

	assert.deepEqual(result.feed.plugins.map(listing => listing.id), ["current", "fallback", "fresh", "kept"]);
	const [current, fallbackListing, freshListing, kept] = result.feed.plugins;
	assert.deepEqual(current, feed.plugins[0], "an up-to-date listing is unchanged");
	assert.deepEqual({ ...kept, releases: undefined }, { ...feed.plugins[1], releases: undefined }, "listing metadata is never rewritten");
	assert.deepEqual(kept!.releases.map(release => [release.version, release.asset]), [["2.0.0", "kept-2.0.0.zip"], ["1.0.0", "kept.zip"]]);
	assert.deepEqual(freshListing, { id: "fresh", name: "Plugin fresh", author: "New", description: "From the manifest.", repository: "New/fresh-plugin", downloads: 0, listedAt: "2026-11-27T05:23:41Z", releases: [
		{ version: "0.2.0", apiVersion: 1, minAppVersion: "0.7.0", publishedAt: "2026-11-20T10:00:00Z", tag: "v0.2.0", asset: "fresh.zip", sha256: sha(fresh) },
	] });
	assert.deepEqual([fallbackListing!.author, fallbackListing!.description, fallbackListing!.releases[0]!.tag], ["octo", "Repository description", "1.0.0"]);
	assert.deepEqual(result.report.added.map(entry => `${entry.id}@${entry.version} ${entry.newListing}`), ["kept@2.0.0 false", "fresh@0.2.0 true", "fallback@1.0.0 true"]);
	assert.deepEqual([result.report.failed, result.report.skipped, result.report.attention], [[], [], []]);
	assert.equal(result.report.checked, 4);

	assert.ok(requests.some(request => request.url.startsWith(GITHUB_API)));
	for (const request of requests) assert.equal(request.authorization, request.url.startsWith(`${GITHUB_API}/`) ? "Bearer secret-token" : null, request.url);
	assert.deepEqual(parseCommunityFeed(JSON.parse(serializeCommunityFeed(result.feed))), result.feed);
});

test("releases that cannot be listed are skipped with a reason", async () => {
	const ok = (id: string) => plugin(id, "1.0.0");
	const { fetcher } = github({
		topic: ["a/no-zip", "a/two-zips", "a/bad-tag", "a/bad-digest", "a/core", "a/taken", "a/twin-one", "a/twin-two", "a/no-description", "a/no-release", "a/two-manifests"],
		repos: {
			"a/no-zip": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "source.tar.gz" }] } },
			"a/two-zips": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "x.zip", bytes: ok("x") }, { name: "y.ZIP", bytes: ok("y") }] } },
			"a/bad-tag": { description: "d", latest: { tag: "release-1", assets: [{ name: "bad-tag.zip", bytes: ok("bad-tag") }] } },
			"a/bad-digest": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "bad-digest.zip", bytes: ok("bad-digest"), digest: `sha256:${"1".repeat(64)}` }] } },
			"a/core": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "core.zip", bytes: ok("flashcards") }] } },
			"a/taken": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "taken.zip", bytes: ok("listed-one") }] } },
			"a/twin-one": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "twin.zip", bytes: ok("twin") }] } },
			"a/twin-two": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "twin.zip", bytes: ok("twin") }] } },
			"a/no-description": { latest: { tag: "v1.0.0", assets: [{ name: "plain.zip", bytes: ok("plain") }] } },
			"a/no-release": {},
			"a/two-manifests": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "two.zip", bytes: zip([["manifest.json", "{}"], ["two/dist/manifest.json", "{}"]]) }] } },
			"owner/listed-one": { latest: { tag: "v1.0.0", assets: [{ name: "listed-one.zip", digest: null }] } },
		},
	});
	const feed = { schemaVersion: 1, plugins: [listed("listed-one", "owner/listed-one", [{}])] };
	const result = await discover({ feed, fetch: fetcher });
	assert.deepEqual(result.feed, parseCommunityFeed(feed), "nothing is listed");
	assert.deepEqual(result.report.skipped.map(entry => `${entry.repository}: ${entry.reason}`).sort(), [
		"a/bad-digest: release v1.0.0: downloaded bad-digest.zip does not match GitHub's digest",
		"a/bad-tag: release release-1: tag release-1 does not match manifest version 1.0.0",
		"a/core: id flashcards is reserved by a Core plugin",
		"a/no-description: no description in manifest.json or the GitHub repository",
		"a/no-release: no stable GitHub release",
		"a/no-zip: release v1.0.0 has 0 uploaded .zip assets; expected exactly one",
		"a/taken: id listed-one is already listed for owner/listed-one",
		"a/twin-one: id twin is claimed by more than one new repository (a/twin-one, a/twin-two); a maintainer decides",
		"a/twin-two: id twin is claimed by more than one new repository (a/twin-one, a/twin-two); a maintainer decides",
		"a/two-manifests: release v1.0.0: expected one built manifest at the ZIP root or <id>/dist/",
		"a/two-zips: release v1.0.0 has 2 uploaded .zip assets; expected exactly one",
	]);
});

test("a release that fails the static checks is reported, unless a maintainer excused it", async () => {
	const sneaky = plugin("sneaky", "1.0.0", { manifest: { description: "d" }, main: "export function activate() { eval(atob('YQ==')); }" });
	const world = { topic: ["a/sneaky"], repos: { "a/sneaky": { latest: { tag: "v1.0.0", assets: [{ name: "sneaky.zip", bytes: sneaky }] } } } };
	const failed = await discover({ feed: { schemaVersion: 1, plugins: [] }, fetch: github(world).fetcher });
	assert.deepEqual(failed.feed.plugins, []);
	assert.deepEqual(failed.report.failed.map(entry => [entry.id, entry.version, entry.findings.map(finding => finding.replace(/ at offset .*/, ""))]), [["sneaky", "1.0.0", ["obfuscation main.js: eval("]]]);

	const exceptions = { schemaVersion: 1, exceptions: [{ id: "sneaky", version: "1.0.0", rule: "obfuscation", file: "main.js", reason: "Reviewed: decodes a constant." }] };
	const excused = await discover({ feed: { schemaVersion: 1, plugins: [] }, exceptions, fetch: github(world).fetcher });
	assert.deepEqual(excused.feed.plugins.map(listing => listing.id), ["sneaky"]);
	assert.deepEqual(excused.report.added[0]!.excused, ["obfuscation main.js"]);
});

test("missing repos and releases are reported but never removed", async () => {
	const { fetcher } = github({
		repos: {
			"owner/archived": { archived: true },
			"owner/changed": { latest: { tag: "v1.0.0", assets: [{ name: "changed.zip", digest: `sha256:${"2".repeat(64)}` }] } },
			"owner/deleted-release": { tags: [] },
		},
	});
	const feed = { schemaVersion: 1, plugins: [listed("archived", "owner/archived", [{}]), listed("changed", "owner/changed", [{}]), listed("deleted-release", "owner/deleted-release", [{}]), listed("gone", "owner/gone", [{}])] };
	const result = await discover({ feed, fetch: fetcher });
	assert.deepEqual(result.feed, parseCommunityFeed(feed));
	assert.deepEqual(result.report.attention.map(entry => `${entry.repository}: ${entry.reason}`), [
		"owner/archived: repository is archived",
		"owner/changed: listed release v1.0.0 asset changed.zip changed (GitHub digest no longer matches the catalog sha256)",
		"owner/deleted-release: listed release v1.0.0 not found",
		"owner/deleted-release: no stable GitHub release",
		"owner/gone: repository not found",
	]);
});

test("a listing keeps at most 24 releases by dropping the lowest version", async () => {
	const releases = Array.from({ length: 24 }, (_, i) => ({ version: `1.${i}.0`, tag: `v1.${i}.0`, asset: `capped-1.${i}.0.zip` }));
	const next = plugin("capped", "2.0.0");
	const { fetcher } = github({ repos: { "owner/capped": { latest: { tag: "v2.0.0", assets: [{ name: "capped.zip", bytes: next }] }, tags: releases.map(release => ({ tag: release.tag, assets: [{ name: release.asset, digest: null }] })) } } });
	const result = await discover({ feed: { schemaVersion: 1, plugins: [listed("capped", "owner/capped", releases)] }, fetch: fetcher });
	const versions = result.feed.plugins[0]!.releases.map(release => release.version);
	assert.equal(versions.length, 24);
	assert.equal(versions[0], "2.0.0");
	assert.ok(!versions.includes("1.0.0") && versions.includes("1.1.0"));

	const older = plugin("capped", "0.9.0");
	const backport = github({ repos: { "owner/capped": { latest: { tag: "v0.9.0", assets: [{ name: "capped-0.9.0.zip", bytes: older }] }, tags: releases.map(release => ({ tag: release.tag, assets: [{ name: release.asset, digest: null }] })) } } });
	const full = await discover({ feed: { schemaVersion: 1, plugins: [listed("capped", "owner/capped", releases)] }, fetch: backport.fetcher });
	assert.equal(full.feed.plugins[0]!.releases.length, 24);
	assert.deepEqual([full.report.added, full.report.skipped.map(entry => entry.reason)], [[], ["release v0.9.0: version 0.9.0 is lower than all 24 listed releases"]]);
});

test("a version already listed under its other tag spelling is skipped", async () => {
	const again = plugin("respelled", "1.0.0");
	const { fetcher } = github({ repos: { "owner/respelled": { latest: { tag: "v1.0.0", assets: [{ name: "respelled.zip", bytes: again }] }, tags: [{ tag: "1.0.0", assets: [{ name: "respelled.zip", digest: null }] }] } } });
	const feed = { schemaVersion: 1, plugins: [listed("respelled", "owner/respelled", [{ tag: "1.0.0", asset: "respelled.zip" }])] };
	const result = await discover({ feed, fetch: fetcher });
	assert.deepEqual(result.feed, parseCommunityFeed(feed));
	assert.deepEqual(result.report.skipped.map(entry => entry.reason), ["release v1.0.0: version 1.0.0 is already listed as tag 1.0.0"]);
});

test("the report shows untrusted text as inert code", () => {
	assert.equal(code("plain"), "` plain `");
	assert.equal(code("a `tick` and ``two``\nline"), "``` a `tick` and ``two`` line ```");
	const report = renderDiscoveryReport({ checked: 1, added: [], failed: [], attention: [], featured: [], skipped: [{ repository: "a/b", reason: "@maintainer see [here](https://evil.example) <img src=x>" }] });
	assert.match(report, /^- \[a\/b\]\(https:\/\/github\.com\/a\/b\): ` @maintainer see \[here\]\(https:\/\/evil\.example\) <img src=x> `$/m);
});

test("new and updated listings get downloads, listedAt and a details file", async () => {
	const fresh = plugin("fresh", "1.0.0", { manifest: { description: "d" } });
	const update = plugin("kept", "2.0.0");
	const { fetcher } = github({
		topic: ["a/fresh"],
		repos: {
			"a/fresh": { latest: { tag: "v1.0.0", body: "First\r\nrelease", assets: [{ name: "fresh.zip", bytes: fresh, downloads: 3 }] }, readme: { "v1.0.0": "# Fresh\r\n" } },
			"owner/kept": {
				latest: { tag: "v2.0.0", body: "Two", assets: [{ name: "kept-2.0.0.zip", bytes: update, downloads: 5 }] },
				tags: [{ tag: "v1.0.0", body: null as unknown as string, assets: [{ name: "kept.zip", digest: null, downloads: 40 }] }],
				readme: { "v1.0.0": "old", "v2.0.0": "# Kept at two" },
			},
			"owner/gone-release": { tags: [], latest: { tag: "v1.1.0", assets: [{ name: "gone-1.1.0.zip", bytes: plugin("gone-release", "1.1.0"), downloads: 1 }] } },
			"owner/quiet": { latest: { tag: "v1.0.0", assets: [{ name: "quiet.zip", digest: null, downloads: 9 }] }, readme: { "v1.0.0": "unchanged" } },
		},
	});
	const feed = { schemaVersion: 1, plugins: [
		listed("gone-release", "owner/gone-release", [{ asset: "gone.zip" }]),
		{ ...listed("kept", "owner/kept", [{ asset: "kept.zip" }]), downloads: 30 },
		{ ...listed("quiet", "owner/quiet", [{ asset: "quiet.zip" }]), downloads: 2 },
	] };
	const previous = { "gone-release": { schemaVersion: 1, id: "gone-release", readme: null, releases: [{ version: "1.0.0", notes: "Kept from before" }] } };
	const result = await discover({ feed, fetch: fetcher, details: previous });

	const byId = Object.fromEntries(result.feed.plugins.map(listing => [listing.id, listing]));
	assert.deepEqual([byId.fresh!.downloads, byId.fresh!.listedAt], [3, "2026-11-27T05:23:41Z"]);
	assert.deepEqual([byId.kept!.downloads, byId.kept!.listedAt], [45, "2026-01-02T03:04:05Z"], "listedAt is kept; downloads sum every listed ZIP");
	assert.equal(byId.quiet!.downloads, 9, "every listing's count is refreshed when the run changes the feed");
	assert.equal(byId["gone-release"]!.downloads, 0, "a count that can't be read in full keeps the old value");

	assert.deepEqual(Object.keys(result.details).sort(), ["fresh", "gone-release", "kept"], "only listings that got a release are rebuilt");
	assert.deepEqual(result.details.fresh, { schemaVersion: 1, id: "fresh", readme: { tag: "v1.0.0", markdown: "# Fresh\r\n" }, releases: [{ version: "1.0.0", notes: "First\nrelease" }] });
	assert.deepEqual(result.details.kept, { schemaVersion: 1, id: "kept", readme: { tag: "v2.0.0", markdown: "# Kept at two" }, releases: [{ version: "2.0.0", notes: "Two" }, { version: "1.0.0", notes: "" }] });
	assert.deepEqual(result.details["gone-release"], { schemaVersion: 1, id: "gone-release", readme: null, releases: [{ version: "1.1.0", notes: "" }, { version: "1.0.0", notes: "Kept from before" }] });
	for (const listing of result.feed.plugins.filter(entry => result.details[entry.id])) {
		assert.deepEqual(parseCommunityDetail(JSON.parse(serializeCommunityDetail(result.details[listing.id]!)), listing), result.details[listing.id]);
	}
});

test("download counts alone do not change the feed", async () => {
	const { fetcher } = github({ repos: { "owner/quiet": { latest: { tag: "v1.0.0", assets: [{ name: "quiet.zip", digest: null, downloads: 9 }] } } } });
	const feed = { schemaVersion: 1, plugins: [{ ...listed("quiet", "owner/quiet", [{ asset: "quiet.zip" }]), downloads: 2 }] };
	const result = await discover({ feed, fetch: fetcher });
	assert.equal(serializeCommunityFeed(result.feed), serializeCommunityFeed(parseCommunityFeed(feed)));
	assert.deepEqual(result.details, {});
});

test("a README that can't be fetched holds the release back until the next run", async () => {
	const bytes = plugin("flaky", "1.0.0", { manifest: { description: "d" } });
	const { fetcher } = github({ topic: ["a/flaky"], repos: { "a/flaky": { latest: { tag: "v1.0.0", assets: [{ name: "flaky.zip", bytes }] }, readme: { "v1.0.0": 502 } } } });
	const result = await discover({ feed: { schemaVersion: 1, plugins: [] }, fetch: fetcher });
	assert.deepEqual([result.feed.plugins, result.details, result.report.added], [[], {}, []]);
	assert.deepEqual(result.report.skipped.map(entry => entry.reason), ["release v1.0.0: details could not be built, retried next run: README at v1.0.0: HTTP 502"]);
});

test("details over their caps are truncated with a marker and reported", async () => {
	const longReadme = `${"a".repeat(1000)}\n`.repeat(200);
	const longNotes = `${"n".repeat(99)}\n`.repeat(200);
	const bytes = plugin("big", "1.0.0", { manifest: { description: "d" } });
	const { fetcher } = github({ topic: ["a/big"], repos: { "a/big": { latest: { tag: "v1.0.0", body: longNotes, assets: [{ name: "big.zip", bytes }] }, readme: { "v1.0.0": longReadme } } } });
	const result = await discover({ feed: { schemaVersion: 1, plugins: [] }, fetch: fetcher });
	const detail = result.details.big!;
	assert.ok(detail.readme!.markdown.length <= 128 * 1024);
	assert.ok(detail.readme!.markdown.endsWith("\n… Truncated. Read the full README on GitHub: https://github.com/a/big/tree/v1.0.0"));
	assert.match(detail.readme!.markdown, /^(a{1000}\n)+… Truncated/, "cut at a line break");
	assert.ok(detail.releases[0]!.notes.length <= 16 * 1024);
	assert.ok(detail.releases[0]!.notes.endsWith("\n… Truncated. Read the full release notes on GitHub: https://github.com/a/big/releases/tag/v1.0.0"));
	assert.deepEqual(result.report.attention.map(entry => entry.reason), [
		"details: README at v1.0.0 is over 128 KiB and was truncated",
		"details: release notes for 1.0.0 are over 16 KiB and were truncated",
	]);

	const invalid = github({ topic: ["a/latin"], repos: { "a/latin": { latest: { tag: "v1.0.0", assets: [{ name: "latin.zip", bytes: plugin("latin", "1.0.0", { manifest: { description: "d" } }) }] }, readme: { "v1.0.0": Buffer.from([0x63, 0x61, 0x66, 0xe9]) } } } });
	const latin = await discover({ feed: { schemaVersion: 1, plugins: [] }, fetch: invalid.fetcher });
	assert.equal(latin.details.latin!.readme!.markdown, "caf�");
	assert.deepEqual(latin.report.attention.map(entry => entry.reason), ["details: README at v1.0.0 is not valid UTF-8; invalid bytes are shown as replacement characters"]);
});

test("a details file over 256 KiB leaves out the oldest notes first", async () => {
	const notes = `${"n".repeat(99)}\n`.repeat(160);
	const releases = Array.from({ length: 23 }, (_, i) => ({ version: `1.${i}.0`, tag: `v1.${i}.0`, asset: `wide-1.${i}.0.zip` }));
	const { fetcher } = github({ repos: { "owner/wide": {
		latest: { tag: "v2.0.0", body: notes, assets: [{ name: "wide.zip", bytes: plugin("wide", "2.0.0") }] },
		tags: releases.map(release => ({ tag: release.tag, body: notes, assets: [{ name: release.asset, digest: null }] })),
		readme: { "v2.0.0": `${"r".repeat(99)}\n`.repeat(1200) },
	} } });
	const result = await discover({ feed: { schemaVersion: 1, plugins: [listed("wide", "owner/wide", releases)] }, fetch: fetcher });
	const detail = result.details.wide!;
	assert.ok(Buffer.byteLength(serializeCommunityDetail(detail)) <= 256 * 1024);
	assert.equal(detail.readme!.markdown.length, 120_000, "the README is kept whole");
	const kept = detail.releases.filter(entry => entry.notes).map(entry => entry.version), dropped = detail.releases.filter(entry => !entry.notes).map(entry => entry.version);
	assert.equal(kept[0], "2.0.0");
	assert.deepEqual(detail.releases.map(entry => entry.version), [...kept, ...dropped], "the newest notes are the ones kept");
	assert.deepEqual(result.report.attention.map(entry => entry.reason), [`details: release notes for ${[...dropped].reverse().join(", ")} were left out to keep the details file under 256 KiB`]);
});

test("featured flags follow featured.json on every run", async () => {
	const { fetcher } = github({ repos: {
		"owner/star": { latest: { tag: "v1.0.0", assets: [{ name: "star.zip", digest: null, downloads: 7 }] } },
		"owner/was": { latest: { tag: "v1.0.0", assets: [{ name: "was.zip", digest: null, downloads: 1 }] } },
	} });
	const feed = { schemaVersion: 1, plugins: [
		listed("star", "owner/star", [{ asset: "star.zip", sha256: "a".repeat(64) }]),
		listed("was", "owner/was", [{ asset: "was.zip", sha256: "b".repeat(64), featured: true }]),
	] };
	const featured = { schemaVersion: 1, featured: [{ id: "star", sha256: "a".repeat(64) }, { id: "ghost", sha256: "c".repeat(64) }] };
	const result = await discover({ feed, fetch: fetcher, featured });
	assert.deepEqual(result.feed.plugins.map(listing => [listing.id, listing.releases[0]!.featured, listing.downloads]), [["star", true, 7], ["was", undefined, 1]]);
	assert.deepEqual(result.report.featured, [{ id: "star", version: "1.0.0", featured: true }, { id: "was", version: "1.0.0", featured: false }]);
	assert.deepEqual(result.report.attention, [{ reason: `featured.json names ghost/${"c".repeat(64)}, which is not a listed release` }]);
	checkCommunityFeatured(result.feed, parseCommunityFeatured({ ...featured, featured: featured.featured.slice(0, 1) }));
	assert.match(renderDiscoveryReport(result.report), /### Featured \(from featured\.json\)\n\n- ` star ` 1\.0\.0: marked featured\n- ` was ` 1\.0\.0: featured mark removed/);
	assert.match(renderDiscoveryReport(result.report), /^- `featured\.json`: ` featured\.json names ghost/m);
});

test("a README that alone overflows the file is shortened, and a huge one is read only in part", async () => {
	const wide = `${"€".repeat(99)}\n`.repeat(1300);
	const one = github({ topic: ["a/wide"], repos: { "a/wide": { latest: { tag: "v1.0.0", body: "Notes", assets: [{ name: "wide.zip", bytes: plugin("wide", "1.0.0", { manifest: { description: "d" } }) }] }, readme: { "v1.0.0": wide } } } });
	const shortened = await discover({ feed: { schemaVersion: 1, plugins: [] }, fetch: one.fetcher });
	const detail = shortened.details.wide!;
	assert.ok(Buffer.byteLength(serializeCommunityDetail(detail)) <= 256 * 1024);
	assert.deepEqual(detail.releases, [{ version: "1.0.0", notes: "" }]);
	assert.match(detail.readme!.markdown, /^(€{99}\n)+… Truncated\. Read the full README on GitHub: https:\/\/github\.com\/a\/wide\/tree\/v1\.0\.0$/);
	assert.deepEqual(shortened.report.attention.map(entry => entry.reason), [
		"details: release notes for 1.0.0 were left out to keep the details file under 256 KiB",
		"details: README at v1.0.0 was shortened to keep the details file under 256 KiB",
	]);

	const huge = github({ topic: ["a/huge"], repos: { "a/huge": { latest: { tag: "v1.0.0", assets: [{ name: "huge.zip", bytes: plugin("huge", "1.0.0", { manifest: { description: "d" } }) }] }, readme: { "v1.0.0": `${"€".repeat(63)}\n`.repeat(40_000) } } } });
	const read = await discover({ feed: { schemaVersion: 1, plugins: [] }, fetch: huge.fetcher });
	assert.ok(read.details.huge!.readme!.markdown.length <= 128 * 1024);
	assert.deepEqual(read.report.attention.map(entry => entry.reason), [
		"details: README at v1.0.0 is over 128 KiB and was truncated",
		"details: README at v1.0.0 was shortened to keep the details file under 256 KiB",
	], "a read that stops inside a character is not called invalid UTF-8");
});
