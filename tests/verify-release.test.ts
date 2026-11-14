/**
 * The final release gate (scripts/verify-release.ts) — pure-function tests
 * plus CLI end-to-end runs, all offline against fixtures. The expected asset
 * names asserted here are the ones derived from the INSTALLED
 * app-builder-lib 26.15.3 (see the script header for the derivation):
 * 3 assets — the NSIS exe, its blockmap, and latest.yml. The product name
 * "LearnHarness Fork" has a space; GitHub and latest.yml spell it with "-".
 * The workflow-wiring tests also run the publish job's script against a fake
 * GitHub client.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";

import {
	checkVersion, expectedAssets, feedExpectations, isPlainAssetName, normalizeReleasePages,
	parseReleases, selectDraft, verifyAssets, verifyConfigAssumptions, verifyMetadataFiles,
	type ReleaseAsset, type ReleaseRecord,
} from "../scripts/verify-release.ts";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = path.join(repoRoot, "scripts", "verify-release.ts");
const VERSION = "0.2.0";
const TAG = `v${VERSION}`;

/** A base64-looking sha512 (the gate checks shape, not the actual digest). */
const sha512 = (seed: string) => Buffer.from(seed.padEnd(64, "0")).toString("base64");

function asset(id: number, name: string, overrides: Partial<ReleaseAsset> = {}): ReleaseAsset {
	return { id, name, size: 5000, state: "uploaded", ...overrides };
}

/** The complete, healthy 3-asset draft for a version. */
function healthyRelease(version: string, tagForm: "v" | "bare" = "v"): ReleaseRecord {
	const e = expectedAssets(version);
	return {
		id: 42,
		tag_name: tagForm === "v" ? `v${version}` : version,
		draft: true,
		assets: e.files.map((name, index) => asset(1000 + index, name)),
	};
}

/** The update feed exactly as app-builder-lib writes it. */
function healthyFeeds(version: string, release: ReleaseRecord): Record<string, string> {
	const byName = new Map(release.assets.map((entry) => [entry.name, entry]));
	const feeds: Record<string, string> = {};
	for (const expectation of feedExpectations(expectedAssets(version))) {
		const files = expectation.urls.map((url) => {
			const found = byName.get(url);
			assert.ok(found, `fixture needs ${url}`);
			return `  - url: ${url}\n    sha512: ${sha512(url)}\n    size: ${found.size}\n`;
		});
		const first = expectation.urls[0]!;
		feeds[expectation.file] =
			`version: ${version}\nfiles:\n${files.join("")}` +
			`path: ${first}\nsha512: ${sha512(first)}\nreleaseDate: '2026-10-13T09:37:13.265Z'\n`;
	}
	return feeds;
}

describe("release gate — expected asset inventory", () => {
	it("is exactly the 3 Windows assets, with the space in the product name spelled as a dash", () => {
		assert.deepEqual(expectedAssets(VERSION).files, [
			"LearnHarness-Fork-0.2.0-x64-setup.exe",
			"LearnHarness-Fork-0.2.0-x64-setup.exe.blockmap",
			"latest.yml",
		]);
	});

	it("accepts plain semver versions and nothing else", () => {
		assert.ok(checkVersion("1.2.3").ok);
		assert.ok(checkVersion("1.2.3-beta.1").ok);
		assert.ok(!checkVersion("1.2").ok);
		assert.ok(!checkVersion("0.2.0 ; rm -rf").ok);
		assert.ok(!checkVersion(undefined).ok);
	});
});

describe("release gate — release-list parsing", () => {
	it("flattens gh --paginate --slurp pages and accepts a plain array", () => {
		const release = healthyRelease(VERSION);
		const paged = normalizeReleasePages([[release], [], [release]]);
		assert.ok(paged.ok);
		assert.deepEqual(paged.releases, [release, release]);
		const plain = normalizeReleasePages([release]);
		assert.ok(plain.ok);
		assert.deepEqual(plain.releases, [release]);
	});

	it("fails closed on a non-array document", () => {
		assert.ok(!normalizeReleasePages({ message: "Bad credentials" }).ok);
	});

	it("rejects malformed release entries and assets", () => {
		const bad = [{ id: 1, tag_name: "v0.2.0", draft: "yes", assets: [] }];
		assert.ok(!parseReleases(bad).ok);
		const badAssets = [{ id: 1, tag_name: "v0.2.0", draft: true, assets: [{ id: 1, name: "x", size: 1, state: "" }] }];
		assert.ok(!parseReleases(badAssets).ok);
		assert.ok(parseReleases([healthyRelease(VERSION)]).ok);
	});
});

describe("release gate — draft selection (fail-closed, existing tag matching)", () => {
	it("selects the single draft carrying the v-tag", () => {
		const selection = selectDraft([healthyRelease(VERSION)], TAG, VERSION);
		assert.ok(selection.ok && selection.release.id === 42 && selection.warnings.length === 0);
	});

	it("still matches the legacy unprefixed tag form but reports the hazard", () => {
		const selection = selectDraft([healthyRelease(VERSION, "bare")], TAG, VERSION);
		assert.ok(selection.ok);
		assert.equal(selection.warnings.length, 1);
		assert.match(selection.warnings[0]!, /unprefixed tag "0.2.0"/);
		assert.match(selection.warnings[0]!, /SECOND draft/);
	});

	it("fails when nothing matches", () => {
		const selection = selectDraft([healthyRelease("0.1.0")], TAG, VERSION);
		assert.ok(!selection.ok);
		assert.match(selection.errors.join("\n"), /no release matches/);
	});

	it("fails when the match is already published — never modifies it", () => {
		const published = { ...healthyRelease(VERSION), draft: false };
		const selection = selectDraft([published], TAG, VERSION);
		assert.ok(!selection.ok);
		assert.match(selection.errors.join("\n"), /already published/);
	});

	it("fails on ambiguous v-tag + bare-version drafts", () => {
		const selection = selectDraft([healthyRelease(VERSION), healthyRelease(VERSION, "bare")], TAG, VERSION);
		assert.ok(!selection.ok);
		assert.match(selection.errors.join("\n"), /2 releases match/);
	});
});

describe("release gate — packaging-config drift guard", () => {
	const yaml = require("js-yaml") as { load(source: string): unknown };
	const realConfig = yaml.load(fs.readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8"));
	const realPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

	it("accepts the repository's real configuration", () => {
		const verdict = verifyConfigAssumptions(realConfig, realPkg);
		assert.ok(verdict.ok, JSON.stringify(verdict, null, 2));
	});

	it("does not look at the mac and linux sections", () => {
		const config = structuredClone(realConfig) as Record<string, unknown>;
		delete config.mac;
		delete config.linux;
		assert.ok(verifyConfigAssumptions(config, realPkg).ok);
	});

	const drifts: Array<[string, (config: Record<string, unknown>) => void]> = [
		["win artifactName", (config) => { (config.win as Record<string, unknown>).artifactName = "${productName}-${version}-setup.${ext}"; }],
		["top-level artifactName", (config) => { config.artifactName = "${name}-${version}.${ext}"; }],
		["productName", (config) => { config.productName = "LearnHarness"; }],
		["win target", (config) => { (config.win as Record<string, unknown>).target = [{ target: "appx", arch: ["x64"] }]; }],
		["publish provider", (config) => { config.publish = [{ provider: "github", owner: "reeschan", releaseType: "prerelease" }]; }],
		["publish owner", (config) => { config.publish = [{ provider: "github", owner: "amosblomqvist", releaseType: "draft" }]; }],
	];
	for (const [label, mutate] of drifts) {
		it(`fails when ${label} drifts (expectations must be re-derived)`, () => {
			const config = structuredClone(realConfig) as Record<string, unknown>;
			mutate(config);
			const verdict = verifyConfigAssumptions(config, realPkg);
			assert.ok(!verdict.ok);
			assert.match(verdict.errors.join("\n"), /expected names no longer hold|would not land in this fork's draft|productName is /);
		});
	}
});

describe("release gate — asset inventory", () => {
	it("passes a complete draft and names every deviation", () => {
		assert.ok(verifyAssets(healthyRelease(VERSION), expectedAssets(VERSION)).ok);
		const release = healthyRelease(VERSION);
		release.assets = release.assets.filter((entry) => entry.name !== "LearnHarness-Fork-0.2.0-x64-setup.exe.blockmap");
		release.assets.push(asset(9999, "LearnHarness-Fork-0.2.0-x64.AppImage"));
		release.assets.push(asset(9998, "LearnHarness-Fork-0.1.0-x64-setup.exe"));
		release.assets.push(asset(9997, "latest.yml", { size: 0 }));
		release.assets.push(asset(9996, "latest.yml", { state: "starter" }));
		const verdict = verifyAssets(release, expectedAssets(VERSION));
		assert.ok(!verdict.ok);
		const joined = verdict.errors.join("\n");
		assert.match(joined, /x64-setup\.exe\.blockmap: missing/);
		assert.match(joined, /x64\.AppImage: unexpected/);
		assert.match(joined, /0\.1\.0-x64-setup\.exe: unexpected/);
		assert.match(joined, /duplicate asset name/);
		assert.match(joined, /zero-size/);
		assert.match(joined, /state is "starter"/);
	});

	it("rejects the installer under its local name with a space", () => {
		const release = healthyRelease(VERSION);
		release.assets = release.assets.map((entry) =>
			entry.name === "LearnHarness-Fork-0.2.0-x64-setup.exe" ? { ...entry, name: "LearnHarness Fork-0.2.0-x64-setup.exe" } : entry);
		const verdict = verifyAssets(release, expectedAssets(VERSION));
		assert.ok(!verdict.ok);
		assert.match(verdict.errors.join("\n"), /LearnHarness Fork-0\.2\.0-x64-setup\.exe: unexpected/);
		assert.match(verdict.errors.join("\n"), /LearnHarness-Fork-0\.2\.0-x64-setup\.exe: missing/);
	});
});

describe("release gate — updater reference hygiene", () => {
	it("accepts bare asset names only", () => {
		assert.ok(isPlainAssetName("LearnHarness-Fork-0.2.0-x64-setup.exe"));
		for (const bad of ["", ".", "..", "../LearnHarness.exe", "dist/LearnHarness.exe", "https://evil.example/app.exe",
			"http://evil.example/app.exe", "file:///etc/passwd", "C:\\app.exe", "~x/app.exe", "app.exe?q=1", "app.exe#x"]) {
			assert.equal(isPlainAssetName(bad), false, bad);
		}
	});
});

describe("release gate — update feed", () => {
	it("accepts the healthy latest.yml for the complete draft", () => {
		const release = healthyRelease(VERSION);
		const feeds = healthyFeeds(VERSION, release);
		assert.deepEqual(Object.keys(feeds), ["latest.yml"]);
		const verdict = verifyMetadataFiles(feeds, release, expectedAssets(VERSION));
		assert.ok(verdict.ok, JSON.stringify(verdict, null, 2));
	});

	type Mutation = (feeds: Record<string, string>, release: ReleaseRecord) => void;
	const exe = expectedAssets(VERSION).win.exe;
	const spaced = "LearnHarness Fork-0.2.0-x64-setup.exe";
	const mutations: Array<[string, Mutation, RegExp]> = [
		["wrong version in latest.yml", (feeds) => { feeds["latest.yml"] = feeds["latest.yml"]!.replace(`version: ${VERSION}`, "version: 0.3.0"); }, /latest\.yml: version is "0\.3\.0"/],
		["path traversal in a reference", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace(`url: ${exe}`, "url: ../../dist/app.exe");
		}, /latest\.yml: files\[0\]\.url is not a bare asset name/],
		["absolute-URL reference", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace(`url: ${exe}`, "url: https://evil.example/app.exe");
		}, /is not a bare asset name/],
		["reference to an asset the release does not hold", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace(`url: ${exe}`, "url: LearnHarness-Fork-0.1.0-x64-setup.exe");
		}, /references "LearnHarness-Fork-0\.1\.0-x64-setup\.exe" which is not an asset/],
		["a url with the space of the local file name", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace(`url: ${exe}`, `url: ${spaced}`);
		}, /references "LearnHarness Fork-0\.2\.0-x64-setup\.exe" which is not an asset/],
		["a path with the space of the local file name", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace(`\npath: ${exe}\n`, `\npath: ${spaced}\n`);
		}, /top-level path is "LearnHarness Fork-0\.2\.0-x64-setup\.exe"/],
		["a path naming another asset", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace(`\npath: ${exe}\n`, `\npath: ${exe}.blockmap\n`);
		}, /top-level path is/],
		["a url naming another asset", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace(`url: ${exe}\n`, `url: ${exe}.blockmap\n`);
		}, /must reference exactly/],
		["size disagreeing with the uploaded asset", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace("size: 5000", "size: 4999");
		}, /size 4999 ≠ release asset size 5000/],
		["legacy sha512 not matching files[0]", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace(`sha512: ${sha512(exe)}\nreleaseDate`, `sha512: ${sha512("tampered")}\nreleaseDate`);
		}, /top-level sha512 does not match/],
		["extra entry in latest.yml", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace("path:", `  - url: ${exe}.blockmap\n    sha512: ${sha512(exe)}\n    size: 5000\npath:`);
		}, /must reference exactly/],
		["garbage sha512", (feeds) => {
			feeds["latest.yml"] = feeds["latest.yml"]!.replace(`sha512: ${sha512(exe)}`, "sha512: deadbeef");
		}, /sha512 is not a base64 digest/],
		["unparseable feed", (feeds) => { feeds["latest.yml"] = "\tversion: [unclosed"; }, /does not parse as YAML/],
		["non-mapping feed", (feeds) => { feeds["latest.yml"] = "- just\n- a\n- list\n"; }, /top level is not a mapping/],
		["feed not downloaded", (feeds) => { delete feeds["latest.yml"]; }, /not downloaded/],
	];
	for (const [label, mutate, pattern] of mutations) {
		it(`fails on ${label}`, () => {
			const release = healthyRelease(VERSION);
			const feeds = healthyFeeds(VERSION, release);
			mutate(feeds, release);
			const verdict = verifyMetadataFiles(feeds, release, expectedAssets(VERSION));
			assert.ok(!verdict.ok, `expected failure for: ${label}`);
			assert.match(verdict.errors.join("\n"), pattern);
		});
	}
});

describe("release gate — workflow wiring", () => {
	type Step = {
		name?: string; id?: string; uses?: string; run?: string; if?: string;
		env?: Record<string, string>; with?: Record<string, any>;
	};
	type Job = {
		needs?: string | string[]; if?: string; permissions?: Record<string, string>;
		env?: Record<string, string>; outputs?: Record<string, string>; steps: Step[];
		"runs-on"?: string;
	};
	const yaml = require("js-yaml") as { load(source: string): { jobs: Record<string, Job> } };
	const workflow = yaml.load(fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8"));
	const verify = workflow.jobs.verify!;
	const publish = workflow.jobs.publish!;

	it("can see drafts after the packaging job, only on real tag pushes", () => {
		assert.ok(verify);
		assert.equal(verify.needs, "package");
		assert.equal(verify.if, "github.event_name == 'push'");
		// GitHub's release-list API hides drafts from read-only tokens.
		assert.deepEqual(verify.permissions, { contents: "write" });
		assert.equal(verify.env?.GH_TOKEN, undefined);
	});

	it("exposes the elevated token only to the two API-reading steps", () => {
		const readers = ["List every release, drafts included", "Download the update feed"];
		for (const step of verify.steps) {
			if (readers.includes(step.name ?? "")) assert.equal(step.env?.GH_TOKEN, "${{ github.token }}");
			else assert.equal(step.env?.GH_TOKEN, undefined, String(step.name ?? step.uses));
		}
		assert.equal(verify.steps.filter((step) => step.env?.GH_TOKEN).length, 2);
	});

	it("uses only implicit GET requests, never release-mutating commands", () => {
		const calls: string[] = verify.steps.flatMap((step) =>
			(step.run ?? "").split("\n").filter((line) => /^\s*gh\s/.test(line)),
		);
		assert.equal(calls.length, 2);
		for (const call of calls) {
			assert.match(call, /^\s*gh api /);
			assert.doesNotMatch(call, /(?:\s|^)(?:--(?:method|input|field|raw-field)(?:[=\s]|$)|-[XfF])/);
		}
	});

	it("checks out the tagged revision and runs select + verify", () => {
		const checkout = verify.steps.find((step) => step.uses?.startsWith("actions/checkout"));
		assert.deepEqual(checkout?.with, { ref: "${{ github.sha }}", "persist-credentials": false });
		const select = verify.steps.find((step) => step.run?.includes("verify-release.ts select"));
		const final = verify.steps.find((step) => step.run?.includes("verify-release.ts verify"));
		assert.ok(select && final);
		assert.match(final.run!, /--tag "\$GITHUB_REF_NAME"/);
		// The gate's own job: nothing here may create, edit, publish, or delete.
		for (const step of verify.steps) {
			assert.equal(step.run?.includes("create") ?? false, false, String(step.name));
		}
	});

	it("download step fetches only latest.yml from the selected draft", () => {
		const download = verify.steps.find((step) => step.name === "Download the update feed");
		assert.ok(download?.run);
		assert.ok(download.run.includes("latest.yml"));
		assert.equal(download.run.includes("latest-mac.yml") || download.run.includes("latest-linux.yml"), false);
		assert.match(download.run, /releases\/assets\/\$id/);
	});

	it("hands the draft's release id to the publish job without a token or an API call", () => {
		const expose = verify.steps.find((step) => step.id === "draft_id");
		assert.ok(expose?.run);
		assert.equal(expose.env?.GH_TOKEN, undefined);
		assert.doesNotMatch(expose.run, /(?:^|\s)gh\s/);
		assert.match(expose.run, /draft\.json|DRAFT/);
		assert.match(expose.run, /releaseId/);
		assert.match(expose.run, /release_id=/);
		assert.equal(verify.outputs?.release_id, "${{ steps.draft_id.outputs.release_id }}");
	});

	describe("publish job", () => {
		const step = publish?.steps[0];

		it("runs only after verify, only on tag pushes, with write access to contents alone", () => {
			assert.ok(publish);
			assert.equal(publish.needs, "verify");
			assert.equal(publish.if, "github.event_name == 'push'");
			assert.equal(publish["runs-on"], "ubuntu-24.04");
			assert.deepEqual(publish.permissions, { contents: "write" });
			assert.equal(publish.steps.length, 1);
			assert.equal(step?.uses, "actions/github-script@v9");
			assert.equal(step?.env?.RELEASE_ID, "${{ needs.verify.outputs.release_id }}");
		});

		const source = step?.with?.script as string | undefined;

		/** Execute the REAL action script with an in-memory GitHub API that only knows updateRelease. */
		async function publishRelease(releaseId: string) {
			assert.ok(source);
			const updates: Record<string, unknown>[] = [];
			const unexpected: string[] = [];
			const repos = new Proxy({
				updateRelease: async (options: Record<string, unknown>) => {
					updates.push(JSON.parse(JSON.stringify(options)));
					return { data: {} };
				},
			} as Record<string, unknown>, {
				get(target, name) {
					if (typeof name === "string" && !(name in target)) unexpected.push(name);
					return target[name as string];
				},
			});
			await runInNewContext(`(async () => { ${source} })()`, {
				context: { repo: { owner: "test-owner", repo: "test-repo" } },
				core: { info() {} },
				process: { env: { RELEASE_ID: releaseId } },
				github: { rest: { repos }, paginate: () => unexpected.push("paginate") },
			});
			return { updates, unexpected };
		}

		it("updates the verified draft once: draft false, marked latest, nothing else", async () => {
			const { updates, unexpected } = await publishRelease("123");
			assert.deepEqual(updates, [{
				owner: "test-owner", repo: "test-repo", release_id: 123, draft: false, make_latest: "true",
			}]);
			assert.deepEqual(unexpected, []);
		});

		it("does not rebuild, delete or touch assets", () => {
			assert.ok(source);
			assert.doesNotMatch(source, /createRelease|deleteRelease|[Aa]sset|listReleases|paginate/);
			assert.equal(source.match(/github\.rest\./g)?.length, 1);
		});

		it("refuses a missing or malformed release id before calling the API", async () => {
			for (const bad of ["", "abc", "0", "-5", "1.5"]) {
				const called: Record<string, unknown>[] = [];
				assert.ok(source);
				await assert.rejects(runInNewContext(`(async () => { ${source} })()`, {
					context: { repo: { owner: "o", repo: "r" } },
					core: { info() {} },
					process: { env: { RELEASE_ID: bad } },
					github: { rest: { repos: { updateRelease: async (options: Record<string, unknown>) => { called.push(options); } } } },
				}), /Invalid release id/, bad);
				assert.deepEqual(called, [], bad);
			}
		});
	});
});

describe("release gate — CLI (offline, repo config)", () => {
	// CLI fixtures follow the real package version; pure-core fixtures above
	// intentionally stay at 0.2.0. A release version bump must not break tests.
	const VERSION = (JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
	const TAG = `v${VERSION}`;
	// A file: URL, not a path: a Windows drive path is not a valid --import specifier.
	const tsxImport = import.meta.resolve("tsx");
	function run(args: string[], cwd = repoRoot) {
		return spawnSync(process.execPath, ["--import", tsxImport, script, ...args], {
			cwd, encoding: "utf8", timeout: 60_000,
		});
	}

	function workspace(tagForm: "v" | "bare" = "v", version = VERSION) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-release-gate-"));
		const release = healthyRelease(version, tagForm);
		fs.writeFileSync(path.join(root, "releases.json"), JSON.stringify([release]));
		fs.mkdirSync(path.join(root, "metadata"));
		for (const [name, content] of Object.entries(healthyFeeds(version, release))) {
			fs.writeFileSync(path.join(root, "metadata", name), content);
		}
		return { root, release };
	}

	it("select emits machine JSON for the workflow's download and publish steps", () => {
		const { root, release } = workspace();
		try {
			const result = run(["select", path.join(root, "releases.json"), "--tag", TAG]);
			assert.equal(result.status, 0, String(result.stderr));
			const report = JSON.parse(result.stdout) as {
				releaseId: number; tag: string; matchedTagName: string; warnings: string[];
				assets: Array<{ id: number; name: string; size: number; state: string }>;
			};
			assert.equal(report.releaseId, release.id);
			assert.equal(report.matchedTagName, TAG);
			assert.deepEqual(report.warnings, []);
			assert.deepEqual(report.assets.map((entry) => entry.name), expectedAssets(VERSION).files);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("verify passes the complete draft and exits 0", () => {
		const { root } = workspace();
		try {
			const result = run(["verify", path.join(root, "releases.json"), path.join(root, "metadata"), "--tag", TAG]);
			assert.equal(result.status, 0, String(result.stderr));
			assert.match(result.stdout, /3\/3 expected files present/);
			assert.ok(result.stdout.includes(`OK: draft for ${TAG} is complete`));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("verify fails a draft with a missing blockmap and a stale asset", () => {
		const { root } = workspace();
		try {
			const release = healthyRelease(VERSION);
			release.assets = release.assets.filter((entry) => entry.name !== `LearnHarness-Fork-${VERSION}-x64-setup.exe.blockmap`);
			release.assets.push(asset(9999, "LearnHarness-Fork-0.1.0-x64-setup.exe"));
			fs.writeFileSync(path.join(root, "releases.json"), JSON.stringify([release]));
			const result = run(["verify", path.join(root, "releases.json"), path.join(root, "metadata"), "--tag", TAG]);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /x64-setup\.exe\.blockmap: missing from the release/);
			assert.match(result.stderr, /0\.1\.0-x64-setup\.exe: unexpected asset/);
			assert.match(result.stderr, /do not publish/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("verify fails a latest.yml that names the installer with a space", () => {
		const { root } = workspace();
		try {
			const feedPath = path.join(root, "metadata", "latest.yml");
			const exe = expectedAssets(VERSION).win.exe;
			fs.writeFileSync(feedPath, fs.readFileSync(feedPath, "utf8").split(exe).join(`LearnHarness Fork-${VERSION}-x64-setup.exe`));
			const result = run(["verify", path.join(root, "releases.json"), path.join(root, "metadata"), "--tag", TAG]);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /which is not an asset/);
			assert.match(result.stderr, /do not publish/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("verify fails closed when the tag disagrees with package.json", () => {
		const { root } = workspace();
		try {
			const wrongTag = TAG === "v0.3.0" ? "v0.2.0" : "v0.3.0";
			const result = run(["verify", path.join(root, "releases.json"), path.join(root, "metadata"), "--tag", wrongTag]);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /does not equal "v" \+ package\.json version/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("verify works after a package version bump without changing the tests", () => {
		const futureVersion = "12.3.4";
		const { root } = workspace("v", futureVersion);
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
			fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...pkg, version: futureVersion }));
			fs.copyFileSync(path.join(repoRoot, "electron-builder.yml"), path.join(root, "electron-builder.yml"));
			const result = run(["verify", path.join(root, "releases.json"), path.join(root, "metadata"), "--tag", `v${futureVersion}`], root);
			assert.equal(result.status, 0, String(result.stderr));
			assert.ok(result.stdout.includes(`OK: draft for v${futureVersion} is complete`));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("select warns loudly for the legacy unprefixed draft tag", () => {
		const { root } = workspace("bare");
		try {
			const result = run(["select", path.join(root, "releases.json"), "--tag", TAG]);
			assert.equal(result.status, 0, String(result.stdout));
			assert.ok(result.stderr.includes("WARNING:"));
			assert.ok(result.stderr.includes(`unprefixed tag "${VERSION}"`));
			const report = JSON.parse(result.stdout) as { warnings: string[] };
			assert.equal(report.warnings.length, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
