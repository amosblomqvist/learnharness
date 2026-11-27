import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { applyCheckExceptions, lockedPackages, maliciousDependencies, parseCheckExceptions, scanReleaseFiles, type CatalogFinding } from "../src/server/community-plugin-checks.ts";
import { checkCommunityCatalog, OSV_BATCH_URL } from "../scripts/check-community-catalog.ts";
import { zip } from "./community-zip.ts";

// Secret-shaped fixtures are assembled at runtime so the repository never holds one.
const fake = (prefix: string, length: number, alphabet = "a1B2c3D4e5") => prefix + alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
const files = (entries: Record<string, string | Buffer>) => new Map(Object.entries(entries).map(([name, value]) => [name, Buffer.from(value)]));
const rules = (findings: CatalogFinding[]) => findings.map(finding => `${finding.rule} ${finding.file}`);

test("ordinary bundled plugin code passes every content rule", () => {
	const minified = 'var a=Object.defineProperty;function b(c){return c.evaluate?c.evaluate():c.eval(c.expression)}const medieval=x=>x;export{b as activate};';
	const image = `const icon="data:image/png;base64,${"iVBORw0KGgo".repeat(600)}";`;
	const font = `@font-face{src:url(data:font/woff2;base64,${"d09GMgABAAAA".repeat(500)})}`;
	const labels = 'const keys=[{env:"OPENAI_API_KEY",label:"OpenAI"}];setTimeout(()=>run(),5);';
	assert.deepEqual(scanReleaseFiles(files({ "main.js": minified + image, "backend.cjs": labels, "styles.css": font, "manifest.json": "{}", "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]) })), []);
});

test("native code is flagged by file signature or file type", () => {
	const findings = scanReleaseFiles(files({
		"helper.bin": Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]),
		"assets/tool": Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0]),
		"assets/module.wasm": Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0]),
		"assets/run.exe": "MZ fake",
		"helper.node": "not really native",
		"assets/setup.sh": "#!/bin/sh\necho hi\n",
	}));
	assert.deepEqual(findings.map(finding => [finding.file, finding.detail]), [
		["assets/module.wasm", "WebAssembly file signature"],
		["assets/run.exe", "PE file signature"],
		["assets/setup.sh", "native or executable file type"],
		["assets/tool", "Mach-O file signature"],
		["helper.bin", "ELF file signature"],
		["helper.node", "native or executable file type"],
	]);
	assert.ok(findings.every(finding => finding.rule === "native-binary"));
});

test("dynamic code, obfuscator names and encoded blobs are flagged in scripts only", () => {
	const names = Array.from({ length: 20 }, (_, i) => `_0x${(0x1a2b + i).toString(16)}`).join(",");
	const findings = scanReleaseFiles(files({
		"a.js": 'eval(atob("Y29uc29sZS5sb2coMSk="))',
		"b.cjs": 'const f=new Function("return this")();window.eval(s);(0,eval)(s);',
		"c.mjs": 'Function("return 1")();setInterval("tick()",10);',
		"d.js": `var ${names};`,
		"e.js": `const p="${"QUJD".repeat(1100)}";`,
		"f.js": `const h="${"0f".repeat(2100)}";`,
		"notes.md": "eval(x) and new Function(y) in documentation are not code",
	}));
	assert.deepEqual(findings.map(finding => `${finding.file} ${finding.detail.replace(/ at offset .*/, "")}`), [
		"a.js eval(",
		"b.cjs eval(",
		"b.cjs new Function(",
		"c.mjs Function(\"…\")",
		"c.mjs string timer",
		"d.js 20 obfuscator-style _0x names",
		"e.js 4400-character encoded blob",
		"f.js 4200-character encoded blob",
	]);
	assert.ok(findings.every(finding => finding.rule === "obfuscation"));
	assert.equal(scanReleaseFiles(files({ "g.js": `var ${names.split(",").slice(0, 19).join(",")};` })).length, 0);
});

test("leaked credentials are flagged and masked", () => {
	const keys = {
		anthropic: fake("sk-" + "ant-api03-", 40),
		github: fake("gh" + "p_", 36),
		aws: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
		google: fake("AI" + "za", 35, "Sy-x_Q7v"),
		deepgram: "0123456789abcdef0123456789abcdef01234567",
		assigned: "abcd1234efgh5678ijkl",
	};
	const pem = "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";
	const findings = scanReleaseFiles(files({
		"backend.cjs": `const a="${keys.anthropic}",g="${keys.github}",w="${keys.aws}";`,
		"main.js": `fetch(u,{headers:{Authorization:"Token "+"${keys.deepgram}"}}) // deepgram\nconst cfg={OPENAI_API_KEY:"${keys.assigned}"};`,
		"README.md": `Maps key ${keys.google}\n${pem}`,
	}));
	assert.deepEqual(findings.map(finding => `${finding.file} ${finding.detail.replace(/ at offset .*/, "")}`), [
		"backend.cjs Anthropic key sk-a…",
		"backend.cjs GitHub token ghp_…",
		"backend.cjs AWS access key AKIA…",
		"main.js Deepgram key 0123…",
		"main.js hard-coded credential abcd…",
		"README.md Google API key AIza…",
		"README.md private key ----…",
	]);
	for (const value of Object.values(keys)) assert.ok(!JSON.stringify(findings).includes(value), "a finding must never print the whole secret");
});

test("lockfiles list every installed package once, dev dependencies included", () => {
	assert.deepEqual(lockedPackages({ lockfileVersion: 3, packages: {
		"": { name: "plugin", version: "1.0.0" },
		"node_modules/esbuild": { version: "0.28.2", dev: true },
		"node_modules/@scope/pkg": { version: "2.0.0" },
		"node_modules/a/node_modules/esbuild": { version: "0.28.2" },
		"node_modules/aliased": { name: "real-name", version: "1.2.3" },
		"node_modules/linked": { link: true, resolved: "packages/linked" },
		"packages/linked": { version: "0.0.1" },
		"node_modules/from-git": { version: "git+https://example.invalid/x.git" },
	} }), [
		{ name: "@scope/pkg", version: "2.0.0" },
		{ name: "esbuild", version: "0.28.2" },
		{ name: "real-name", version: "1.2.3" },
	]);
	assert.deepEqual(lockedPackages({ lockfileVersion: 1, dependencies: { left: { version: "1.0.0", dependencies: { right: { version: "2.0.0" } } } } }), [
		{ name: "left", version: "1.0.0" },
		{ name: "right", version: "2.0.0" },
	]);
	assert.throws(() => lockedPackages({ lockfileVersion: 3 }), /no packages or dependencies/);
});

test("only OSV malware advisories count as malicious dependencies", () => {
	const packages = [{ name: "fine", version: "1.0.0" }, { name: "bad", version: "6.6.6" }, { name: "old-cve", version: "0.1.0" }];
	assert.deepEqual(maliciousDependencies(packages, { results: [{}, { vulns: [{ id: "MAL-2025-1234" }, { id: "GHSA-xxxx" }] }, { vulns: [{ id: "GHSA-yyyy" }] }] }), [
		{ rule: "malicious-dependency", file: "package-lock.json", detail: "bad@6.6.6: MAL-2025-1234" },
	]);
	assert.throws(() => maliciousDependencies(packages, { results: [{}] }), /Unexpected OSV response/);
});

test("exceptions need a reason and excuse only matching findings; unused ones are stale", () => {
	assert.throws(() => parseCheckExceptions({ schemaVersion: 1, exceptions: [{ id: "x", version: "1.0.0", rule: "secret", reason: " " }] }), /Invalid catalog check exception/);
	assert.throws(() => parseCheckExceptions({ schemaVersion: 1, exceptions: [{ id: "x", version: "1.0.0", rule: "unknown", reason: "r" }] }), /Invalid catalog check exception/);
	const exceptions = parseCheckExceptions({ schemaVersion: 1, exceptions: [
		{ id: "p", version: "1.0.0", rule: "obfuscation", file: "main.js", reason: "Bundled expression parser uses new Function" },
		{ id: "p", version: "1.0.0", rule: "secret", reason: "Never matches" },
	] });
	const result = applyCheckExceptions([{ id: "p", version: "1.0.0", findings: [
		{ rule: "obfuscation", file: "main.js", detail: "new Function( at offset 1" },
		{ rule: "obfuscation", file: "backend.cjs", detail: "eval( at offset 2" },
	] }], exceptions);
	assert.deepEqual(result.excused.map(finding => finding.file), ["main.js"]);
	assert.deepEqual(result.failures.map(finding => finding.file), ["backend.cjs"]);
	assert.deepEqual(result.stale.map(exception => exception.rule), ["secret"]);
});

test("the checker verifies each pinned release, scans it, and checks its lockfile", async () => {
	const manifest = (id: string) => JSON.stringify({ id, version: "1.0.0", name: id, minAppVersion: "0.7.0", apiVersion: 1, main: "main.js", backend: "backend.cjs" });
	const pkg = (id: string, main = "export function activate() {}") => zip([["manifest.json", manifest(id)], ["main.js", main], ["backend.cjs", "exports.activate = () => {};"]], true);
	const packages = { clean: pkg("clean"), sneaky: pkg("sneaky", 'eval(atob("eA=="));export function activate() {}'), handmade: pkg("handmade"), tampered: pkg("tampered") };
	const release = (id: keyof typeof packages, sha256 = createHash("sha256").update(packages[id]).digest("hex")) =>
		({ id, name: id, author: "Example", description: "Fixture", repository: `example/${id}`, releases: [{ version: "1.0.0", apiVersion: 1, minAppVersion: "0.7.0", publishedAt: "2026-11-26T01:00:00Z", tag: "v1.0.0", asset: `${id}.zip`, sha256 }] });
	const feed = { schemaVersion: 1, plugins: [release("clean"), release("sneaky"), release("handmade"), release("tampered", "0".repeat(64))] };
	const raw: Record<string, string> = {
		"example/clean/v1.0.0/package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } }),
		"example/sneaky/v1.0.0/package.json": "{}",
		"example/tampered/v1.0.0/package.json": "{}",
	};
	const osvQueries: unknown[] = [];
	const fetcher: typeof fetch = async (input, options) => {
		const url = String(input);
		if (url === OSV_BATCH_URL) {
			const body = JSON.parse(String(options?.body));
			osvQueries.push(body);
			return Response.json({ results: body.queries.map(() => ({ vulns: [{ id: "MAL-2026-0001" }] })) });
		}
		const asset = url.match(/^https:\/\/github\.com\/example\/(\w+)\/releases\/download\/v1\.0\.0\/\w+\.zip$/);
		if (asset) return new Response(Uint8Array.from(packages[asset[1] as keyof typeof packages]));
		const file = url.replace("https://raw.githubusercontent.com/", "");
		return file in raw ? new Response(raw[file]) : new Response("Not found", { status: 404 });
	};
	const exceptions = { schemaVersion: 1, exceptions: [
		{ id: "clean", version: "1.0.0", rule: "malicious-dependency", reason: "Fixture: the advisory was withdrawn upstream" },
		{ id: "handmade", version: "1.0.0", rule: "secret", reason: "Fixture: stale" },
	] };
	const result = await checkCommunityCatalog({ feed, exceptions, fetch: fetcher });
	assert.deepEqual(osvQueries, [{ queries: [{ package: { name: "left-pad", ecosystem: "npm" }, version: "1.3.0" }] }]);
	assert.deepEqual(result.excused.map(finding => `${finding.id} ${finding.rule}`), ["clean malicious-dependency"]);
	assert.deepEqual(result.failures.map(finding => `${finding.id} ${finding.rule} ${finding.detail.replace(/ at offset .*/, "")}`), [
		"sneaky obfuscation eval(",
		"sneaky missing-lockfile package.json without package-lock.json at example/sneaky@v1.0.0",
		"tampered release-invalid checksum: The release ZIP does not match the catalog checksum",
		"tampered missing-lockfile package.json without package-lock.json at example/tampered@v1.0.0",
	]);
	assert.deepEqual(result.stale.map(exception => exception.id), ["handmade"]);
});

test("the checker stops when a lockfile cannot be fetched for a reason other than absence", async () => {
	const body = zip([["manifest.json", JSON.stringify({ id: "p", version: "1.0.0", name: "p", minAppVersion: "0.7.0", apiVersion: 1, main: "main.js" })], ["main.js", "export function activate() {}"]], true);
	const feed = { schemaVersion: 1, plugins: [{ id: "p", name: "p", author: "a", description: "d", repository: "example/p", releases: [{ version: "1.0.0", apiVersion: 1, minAppVersion: "0.7.0", publishedAt: "2026-11-26T01:00:00Z", tag: "v1.0.0", asset: "p.zip", sha256: createHash("sha256").update(body).digest("hex") }] }] };
	const fetcher: typeof fetch = async input => String(input).startsWith("https://github.com/") ? new Response(Uint8Array.from(body)) : new Response("unavailable", { status: 503 });
	await assert.rejects(checkCommunityCatalog({ feed, exceptions: { schemaVersion: 1, exceptions: [] }, fetch: fetcher }), /Could not fetch package-lock.json for p@1.0.0/);
});
