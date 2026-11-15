import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import ts from "typescript";
import { createPluginApiReference, writePluginApiReference } from "../scripts/build-plugin-api-reference.mjs";

function fixture(run: (root: string, write: (file: string, text: string) => void) => void) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-api-reference-test-")));
	const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
	try { run(root, write); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

it("indexes aliased public exports, nested members, overloads, inheritance and supporting declarations without runtime-helper claims", () => fixture((root, write) => {
	write("index.d.ts", 'export type { Api as PublicApi } from "./contracts.ts"; export type * from "./ui.ts";');
	write("contracts.d.ts", '/** Own API. */ export interface Api extends Base { readonly events: { on(listener: (event: Event) => void): () => void }; send<T>(value: T): Promise<T>; send(value: string): string; optional?: boolean } interface Base { inherited: string } type Event = { type: "ok"; value: number } | { type: "error"; message: string }; export declare function privateRuntimeHelper(): void;');
	write("ui.d.ts", 'declare const brand: unique symbol; export interface Target { readonly [brand]: true } export interface Widget<T> { update(value: Partial<T>): void; dispose(): void }');
	const reference = createPluginApiReference({ sdk: root });
	assert.match(reference.pages.get("README.md")!, /\[PublicApi\]\(contracts.md#api\)/);
	assert.doesNotMatch(reference.pages.get("README.md")!, /privateRuntimeHelper/);
	assert.match(reference.pages.get("contracts.md")!, /exported as `PublicApi`/);
	const api = reference.inventory.find((entry: { name: string }) => entry.name === "Api")!;
	assert.deepEqual(api.exports, ["PublicApi"]);
	assert.equal(api.members.filter((member: { key: string }) => member.key === "send").length, 2);
	assert.ok(api.members.some((member: { key: string }) => member.key === "events.on"));
	assert.match(reference.pages.get("contracts.md")!, /### Api events.on/);
	assert.match(reference.pages.get("contracts.md")!, /\*\*Returns:\*\* `\(\) => void`/);
	for (const name of ["Base", "Event", "brand"]) assert.ok(reference.inventory.some((entry: { name: string; public: boolean }) => entry.name === name && !entry.public));
	assert.deepEqual([...createPluginApiReference({ sdk: root }).pages], [...reference.pages]);
}));

it("does not follow declaration imports outside the SDK", () => fixture((root, write) => {
	write("outside.d.ts", "export interface Private { SECRET_PRIVATE_SENTINEL: string }");
	write("sdk/index.d.ts", 'import type { Private } from "../outside.ts"; export interface Public { value: Private }');
	assert.throws(() => createPluginApiReference({ sdk: path.join(root, "sdk") }), /Refusing.*outside or missing SDK/);
}));

it("refuses source and output links and writing over the input SDK", () => fixture((root, write) => {
	write("sdk/index.d.ts", "export interface Api { readonly value: string }");
	write("keep.txt", "preserve");
	fs.symlinkSync(path.join(root, "keep.txt"), path.join(root, "sdk/linked.d.ts"));
	assert.throws(() => createPluginApiReference({ sdk: path.join(root, "sdk") }), /Refusing.*symlink/);
	fs.unlinkSync(path.join(root, "sdk/linked.d.ts"));
	assert.throws(() => writePluginApiReference({ sdk: path.join(root, "sdk"), output: path.join(root, "sdk") }), /Refusing/);
	fs.mkdirSync(path.join(root, "output")); fs.symlinkSync(path.join(root, "keep.txt"), path.join(root, "output/README.md"));
	assert.throws(() => writePluginApiReference({ sdk: path.join(root, "sdk"), output: path.join(root, "output") }), /Refusing.*symlink/);
	assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "preserve");
}));

it("the committed reference covers every real SDK public type/member and exactly matches fresh generation", () => fixture(root => {
	const sdk = path.join(root, "sdk");
	const build = spawnSync(process.execPath, [path.resolve("scripts/build-plugin-types.mjs"), sdk], { encoding: "utf8" });
	assert.equal(build.status, 0, build.stderr);
	const reference = createPluginApiReference({ sdk });
	// Independent export traversal and AST member inventory; do not rely on the generator's count.
	const program = ts.createProgram([path.join(sdk, "index.d.ts")], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
	const checker = program.getTypeChecker(), file = program.getSourceFile(path.join(sdk, "index.d.ts"))!;
	const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(file)!);
	let count = 0;
	for (const exported of exports) {
		const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
		for (const declaration of symbol.declarations ?? []) {
			if (!ts.isInterfaceDeclaration(declaration) && !ts.isTypeAliasDeclaration(declaration)) continue;
			count++;
			const entry = reference.inventory.find((entry: { name: string; exports: string[] }) => entry.name === declaration.name.text && entry.exports.includes(exported.name));
			assert.ok(entry, exported.name);
			const text = reference.pages.get(entry.module + ".md")!;
			assert.ok(text.includes("## " + declaration.name.text), exported.name);
			const methodNames: string[] = [];
			function visit(node: ts.Node) {
				if (ts.isMethodSignature(node)) methodNames.push(node.name.getText());
				ts.forEachChild(node, visit);
			}
			visit(declaration);
			for (const name of methodNames) assert.ok(entry.members.some((member: { key: string }) => member.key === name || member.key.endsWith("." + name)), `${exported.name}.${name}`);
		}
	}
	assert.ok(count >= 140, "an accidentally empty/partial SDK must not pass coverage");
	assert.equal(reference.inventory.reduce((n: number, entry: { exports: string[] }) => n + entry.exports.length, 0), count);
	const committed = path.resolve("docs/plugin-api");
	assert.deepEqual(fs.readdirSync(committed).sort(), [...reference.pages.keys()].sort());
	for (const [filename, text] of reference.pages) assert.equal(fs.readFileSync(path.join(committed, filename), "utf8"), text, `Regenerate stale reference: ${filename}`);
	for (const entry of reference.inventory) for (const member of entry.members) assert.ok(reference.pages.get(entry.module + ".md")!.includes(member.signature), `${entry.name}.${member.key}`);
}));
