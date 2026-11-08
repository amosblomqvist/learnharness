/** Emit a portable, type-only API tree. Nothing is published and there is no
 * plugin runtime dependency on application internals. Use imports as types. */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");
const output = path.resolve(process.argv[2] ?? path.join(ROOT, "dist", "plugin-sdk"));
if (output === ROOT || ROOT.startsWith(output + path.sep)) throw new Error("Refusing to emit API declarations over the source tree or its ancestors");
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-types-"));
try {
	const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
	const result = spawnSync(process.execPath, [tsc,
		"--declaration", "--emitDeclarationOnly", "--noEmit", "false", "--incremental", "false",
		"--target", "ES2022", "--lib", "ES2023,DOM,DOM.Iterable", "--module", "ESNext", "--moduleResolution", "bundler",
		"--strict", "--noUncheckedIndexedAccess", "--verbatimModuleSyntax", "--skipLibCheck", "--allowImportingTsExtensions",
		"--esModuleInterop", "--resolveJsonModule", "--types", "node", "--rootDir", ROOT, "--outDir", stage,
		path.join(ROOT, "src", "core", "plugins.ts"), path.join(ROOT, "src", "core", "plugin-agents.ts"), path.join(ROOT, "src", "core", "plugin-ui.ts"), path.join(ROOT, "src", "core", "plugin-questions.ts"), path.join(ROOT, "src", "core", "plugin-submissions.ts"), path.join(ROOT, "src", "core", "plugin-problems.ts"), path.join(ROOT, "src", "core", "plugin-view-context.ts"),
	], { cwd: ROOT, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Plugin API declaration emission failed (${result.status})`);
	fs.writeFileSync(path.join(stage, "index.d.ts"), 'export type * from "./src/core/plugins.ts";\nexport type * from "./src/core/plugin-agents.ts";\nexport type * from "./src/core/plugin-ui.ts";\nexport type * from "./src/core/plugin-tree.ts";\nexport type * from "./src/core/plugin-questions.ts";\nexport type * from "./src/core/plugin-submissions.ts";\nexport type * from "./src/core/plugin-problems.ts";\nexport type * from "./src/core/plugin-view-context.ts";\n');
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({
		name: "learnharness-plugin-api", version: "1.0.0", private: true, type: "module", types: "./index.d.ts",
		exports: { ".": { types: "./index.d.ts" } },
		peerDependencies: {
			"@earendil-works/pi-agent-core": pkg.dependencies["@earendil-works/pi-agent-core"],
			"@earendil-works/pi-ai": pkg.dependencies["@earendil-works/pi-ai"], typebox: pkg.dependencies.typebox,
		},
	}, null, "\t") + "\n");
	fs.writeFileSync(path.join(stage, "README.md"), "# LearnHarness plugin API v1 — local types\n\nGenerated from the public source contracts. Type-only imports; no runtime exports.\nSee docs/plugin-authoring.md in the LearnHarness repository. This is not a published npm package.\n");
	fs.mkdirSync(output, { recursive: true });
	fs.cpSync(stage, output, { recursive: true });
	console.log("[plugin-types] declarations ready:", output);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
