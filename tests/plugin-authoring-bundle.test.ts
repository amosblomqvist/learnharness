import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { AUTHORING_DOCS, AUTHORING_EXAMPLES, buildPluginAuthoring, createAuthoringZip } from "../scripts/build-plugin-authoring.mjs";

/** Independent bitwise CRC and ZIP reader, not the production encoder. */
function checksum(bytes: Buffer) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function unzip(bytes: Buffer) {
	const result = new Map<string, Buffer>();
	let offset = 0;
	while (bytes.readUInt32LE(offset) === 0x04034b50) {
		assert.equal(bytes.readUInt16LE(offset + 6), 0x800);
		assert.equal(bytes.readUInt16LE(offset + 8), 0);
		assert.equal(bytes.readUInt16LE(offset + 10), 0);
		assert.equal(bytes.readUInt16LE(offset + 12), 33);
		const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26);
		assert.equal(bytes.readUInt32LE(offset + 22), size);
		assert.equal(bytes.readUInt16LE(offset + 28), 0);
		const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
		const data = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
		assert.equal(checksum(data), bytes.readUInt32LE(offset + 14));
		assert.equal(result.has(name), false);
		result.set(name, data);
		offset += 30 + nameLength + size;
	}
	const centralOffset = offset;
	for (const [name, data] of result) {
		assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
		assert.equal(bytes.readUInt32LE(offset + 16), checksum(data));
		assert.equal(bytes.readUInt32LE(offset + 24), data.length);
		const length = bytes.readUInt16LE(offset + 28);
		assert.equal(bytes.subarray(offset + 46, offset + 46 + length).toString(), name);
		const local = bytes.readUInt32LE(offset + 42);
		assert.equal(bytes.readUInt32LE(local), 0x04034b50);
		assert.equal(bytes.subarray(local + 30, local + 30 + length).toString(), name);
		offset += 46 + length;
	}
	assert.equal(bytes.readUInt32LE(offset), 0x06054b50);
	assert.equal(bytes.readUInt16LE(offset + 8), result.size);
	assert.equal(bytes.readUInt16LE(offset + 10), result.size);
	assert.equal(bytes.readUInt32LE(offset + 12), offset - centralOffset);
	assert.equal(bytes.readUInt32LE(offset + 16), centralOffset);
	assert.equal(offset + 22, bytes.length);
	return result;
}
function fixture(run: (root: string) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-authoring-test-"));
	const source = path.resolve(import.meta.dirname, "..");
	const write = (relative: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text);
	};
	try {
		write("package.json", JSON.stringify({ version: "9.8.7" }));
		write("LICENSE", fs.readFileSync(path.join(source, "LICENSE"), "utf8"));
		for (const doc of AUTHORING_DOCS) write(`docs/${doc}`, fs.readFileSync(path.join(source, "docs", doc), "utf8"));
		for (const file of ["SKILL.md", "README.md"]) write(`skills/learnharness-plugins/${file}`, fs.readFileSync(path.join(source, "skills/learnharness-plugins", file), "utf8"));
		for (const id of AUTHORING_EXAMPLES) fs.cpSync(path.join(source, "examples/plugins", id), path.join(root, "examples/plugins", id), { recursive: true });
		write("scripts/build-plugin-types.mjs", `import fs from 'node:fs';const p=process.argv[2];fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/package.json',JSON.stringify({name:'learnharness-plugin-api',version:'1.0.0'}));fs.writeFileSync(p+'/index.d.ts','export interface Example {}');`);
		write("docs/not-authoring.md", "not bundled"); write("data/private.json", "AUTHORING_PRIVATE_SENTINEL_9b1f"); write("auth.json", "AUTHORING_PRIVATE_SENTINEL_9b1f");
		write("examples/plugins/unrelated/dist/manifest.json", "not bundled");
		run(root);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

it("produces the complete rooted skill, matching versions, current example layout and no repository-only files", () => fixture(root => {
	const built = buildPluginAuthoring({ root });
	assert.deepEqual(built.metadata, { appVersion: "9.8.7", pluginApiVersion: 1, sdkVersion: "1.0.0" });
	const entries = unzip(fs.readFileSync(built.archive));
	assert.equal(entries.size, built.entries);
	for (const name of ["SKILL.md", "README.md", "LICENSE", "bundle.json", "types/index.d.ts", ...AUTHORING_DOCS.map((doc: string) => `docs/${doc}`)]) assert.ok(entries.has(`learnharness-plugins/${name}`), name);
	const skill = entries.get("learnharness-plugins/SKILL.md")!.toString();
	assert.match(skill, /\(\.\/docs\/plugin-authoring.md\)/); assert.match(skill, /\(\.\/examples\/plugins\/\)/);
	assert.doesNotMatch(skill, /\.\.\/\.\.\//);
	for (const id of AUTHORING_EXAMPLES) {
		const name = `learnharness-plugins/examples/plugins/${id}/dist/manifest.json`;
		const exported = JSON.parse(entries.get(name)!.toString());
		assert.equal(exported.minAppVersion, "9.8.7");
		const original = JSON.parse(fs.readFileSync(path.join(root, "examples/plugins", id, "dist/manifest.json"), "utf8"));
		assert.notEqual(original.minAppVersion, "9.8.7", "never rewrite source manifests");
		delete exported.minAppVersion; delete original.minAppVersion; assert.deepEqual(exported, original);
	}
	for (const [name, bytes] of entries) {
		assert.doesNotMatch(name, /(?:^|\/)(?:data|node_modules|skills|unrelated)\//);
		assert.doesNotMatch(name, /auth\.json|not-authoring|example-ui\.test/);
		assert.equal(bytes.includes(Buffer.from("AUTHORING_PRIVATE_SENTINEL_9b1f")), false);
		assert.deepEqual(bytes, fs.readFileSync(path.join(built.directory, name.slice("learnharness-plugins/".length))));
	}
	// All Markdown links, including example README links, stay inside this extracted skill.
	for (const [name, bytes] of entries) if (name.endsWith(".md")) {
		for (const [, href] of bytes.toString().matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
			if (!href || /^(?:https?:|mailto:|#)/.test(href)) continue;
			const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), href.split("#")[0]!));
			assert.ok(target.startsWith("learnharness-plugins/"), `${name}: ${href}`);
			assert.ok(entries.has(target) || [...entries.keys()].some(key => key.startsWith(target.replace(/\/$/, "") + "/")), `${name}: ${href}`);
		}
	}
}));

it("regenerates deterministic dev and standalone archives without stale expanded files", () => fixture(root => {
	const initial = buildPluginAuthoring({ root }), bytes = fs.readFileSync(initial.archive);
	fs.writeFileSync(path.join(initial.directory, "stale.txt"), "stale");
	const again = buildPluginAuthoring({ root });
	assert.deepEqual(fs.readFileSync(again.archive), bytes);
	assert.equal(fs.existsSync(path.join(again.directory, "stale.txt")), false);
	const packaged = buildPluginAuthoring({ root, standalone: true });
	assert.deepEqual(fs.readFileSync(packaged.archive), bytes);
	assert.equal(packaged.directory, path.join(root, ".next/standalone/plugin-authoring"));
}));

it("refuses unsafe example contents, source symlinks and output symlinks without changing their targets", () => {
	for (const mode of ["data", "credentials", "source-link", "output-link", "dangling-output-link"]) fixture(root => {
		const dist = path.join(root, "examples/plugins/hello-plugin/dist");
		const outside = path.join(root, "keep.txt"); fs.writeFileSync(outside, "preserve");
		if (mode === "data") fs.mkdirSync(path.join(dist, "data"));
		if (mode === "credentials") fs.writeFileSync(path.join(dist, ".env.local"), "private");
		if (mode === "source-link") fs.symlinkSync(outside, path.join(dist, "linked.js"));
		if (mode.includes("output-link")) {
			fs.mkdirSync(path.join(root, "public"));
			fs.symlinkSync(mode.startsWith("dangling") ? path.join(root, "missing") : root, path.join(root, "public/plugin-authoring"), "dir");
		}
		assert.throws(() => buildPluginAuthoring({ root }), /Refusing/);
		assert.equal(fs.readFileSync(outside, "utf8"), "preserve");
	});
});
it("ZIP writer refuses traversal, ambiguous paths and duplicate entries", () => {
	for (const name of ["../escape", "learnharness-plugins/../escape", "learnharness-plugins/./a", "learnharness-plugins//a", "learnharness-plugins/a\\b", "/absolute"]) assert.throws(() => createAuthoringZip([{ name, data: Buffer.from("a") }]), /Invalid/);
	assert.throws(() => createAuthoringZip([{ name: "learnharness-plugins/a", data: Buffer.from("a") }, { name: "learnharness-plugins/a", data: Buffer.from("b") }]), /Invalid/);
	assert.equal(unzip(createAuthoringZip([{ name: "learnharness-plugins/é.md", data: Buffer.from("hello") }])).get("learnharness-plugins/é.md")!.toString(), "hello");
});
