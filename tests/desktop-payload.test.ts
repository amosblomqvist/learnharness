/** Run the real payload-curation script in throwaway repository fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createPluginHost } from "../src/server/plugin-host.ts";
import { createPluginSmokeFixture } from "../scripts/smoke-plugin-runtime.mjs";

const source = fs.readFileSync(new URL("../scripts/build-server.mjs", import.meta.url), "utf8");
const STANDALONE = path.join(".next", "standalone");
const PROMPT = path.join("src", "agent", "system-prompt.md");
const AUTHORING_DOCS = [
	"plugin-authoring.md", "plugin-architecture.md", "plugin-question-contract.md",
	"plugin-problem-contract.md", "plugin-session-extension-contract.md", "plugin-tree-contract.md",
	"plugin-view-context.md", "dialog-overlay-contract.md", "archive/plugin-implementation-history.md",
];

function withPayload(test: (fixture: {
	root: string;
	write: (relative: string, content?: string) => void;
	run: () => ReturnType<typeof spawnSync>;
}) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-payload-test-"));
	const write = (relative: string, content = "fixture") => {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	};
	try {
		write(path.join("scripts", "build-server.mjs"), source);
		write("scripts/build-plugin-authoring.mjs", fs.readFileSync(new URL("../scripts/build-plugin-authoring.mjs", import.meta.url), "utf8"));
		write("package.json", JSON.stringify({ version: "0.4.1" }));
		write("LICENSE", "AGPL-3.0-only fixture");
		write("core-plugins.json", fs.readFileSync(new URL("../core-plugins.json", import.meta.url), "utf8"));
		write("scripts/build-core-plugins.mjs", fs.readFileSync(new URL("../scripts/build-core-plugins.mjs", import.meta.url), "utf8"));
		write("src/core/plugins.ts", fs.readFileSync(new URL("../src/core/plugins.ts", import.meta.url), "utf8"));
		for (const id of JSON.parse(fs.readFileSync(new URL("../core-plugins.json", import.meta.url), "utf8")) as string[]) {
			write(`core-plugins/${id}/manifest.json`, JSON.stringify({ apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", main: "main.js" }));
			write(`core-plugins/${id}/main.js`, "export function activate() {};");
			write(`core-plugins/${id}/assets/font.woff`, "bundled-font");
			write(`core-plugins/${id}/LICENSE`, "bundled-license");
		}
		write(path.join("scripts", "plugin-loader.cjs"), "exports.load = () => {};\n");
		// Declaration generation is tested separately. This fixture tests payload
		// curation, not the TypeScript compiler or the full application sources.
		write(path.join("scripts", "build-plugin-types.mjs"), `import fs from 'node:fs'; import path from 'node:path'; fs.mkdirSync(process.argv[2], {recursive:true}); fs.writeFileSync(path.join(process.argv[2], 'index.d.ts'), 'export interface Example {}'); fs.writeFileSync(path.join(process.argv[2], 'package.json'), JSON.stringify({version:'1.0.0'}));`);
		write(path.join("public", "plugin-loader.js"), "export {};\n");
		for (const file of AUTHORING_DOCS) {
			write(path.join("docs", file), fs.readFileSync(new URL(`../docs/${file}`, import.meta.url), "utf8"));
		}
		for (const id of ["hello-plugin", "managed-agent", "teaching-extension"]) {
			write(`examples/plugins/${id}/README.md`, fs.readFileSync(new URL(`../examples/plugins/${id}/README.md`, import.meta.url), "utf8"));
			write(`examples/plugins/${id}/dist/manifest.json`, JSON.stringify({ apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.3.7", main: "main.js" }));
			write(`examples/plugins/${id}/dist/main.js`, "export function activate() {};");
		}
		for (const file of ["SKILL.md", "README.md"]) write(`skills/learnharness-plugins/${file}`, fs.readFileSync(new URL(`../skills/learnharness-plugins/${file}`, import.meta.url), "utf8"));
		write(path.join(STANDALONE, "server.js"));
		write(path.join(".next", "static", "runtime.js"));
		write(path.join("public", "asset.txt"));
		write(path.join(STANDALONE, PROMPT));
		write(path.join(STANDALONE, "src", "agent", "prompts", "teacher", "20-teaching.md"));
		write(path.join(STANDALONE, "src", "agent", "prompts", "side-chat", "00-base.md"));
		write(path.join(STANDALONE, "src", "agent", "prompts", "side-chat", "90-style.md"));
		test({ root, write, run: () => spawnSync(process.execPath, [path.join(root, "scripts", "build-server.mjs")], {
			cwd: root, encoding: "utf8", timeout: 10_000,
		}) });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("desktop standalone payload", () => {
	it("ships no-build examples that the fixed-dist host discovers without evaluating code", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-example-layout-"));
		const directory = path.join(root, "plugins");
		fs.cpSync(path.resolve("examples/plugins"), directory, { recursive: true });
		const host = createPluginHost({ directory, appVersion: "0.4.1", createServices() { throw Error("disabled examples must not create services"); } });
		try {
			await host.initialize();
			assert.deepEqual(host.list().map(plugin => [plugin.id, plugin.status]), [["hello-plugin", "disabled"], ["managed-agent", "disabled"], ["teaching-extension", "disabled"]]);
			for (const plugin of host.list()) {
				assert.ok(fs.existsSync(path.join(directory, plugin.id, "dist", "manifest.json")));
				assert.equal(fs.existsSync(path.join(directory, plugin.id, "manifest.json")), false);
			}
		} finally { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("seeds packaged smoke fixtures with code in dist and persistent data beside it", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-layout-"));
		const pluginRoot = createPluginSmokeFixture(home);
		const directory = path.join(home, "data", "plugins");
		const host = createPluginHost({ directory, appVersion: "0.4.1", createServices() { throw Error("disabled smoke fixtures must not activate"); } });
		try {
			await host.initialize();
			assert.deepEqual(host.list().map(plugin => [plugin.id, plugin.status]), [["native-smoke", "disabled"], ["native-smoke-picker-settings", "disabled"]]);
			assert.equal(fs.readFileSync(path.join(pluginRoot, "data", "private.json"), "utf8"), '{"private":true}\n');
			assert.equal(fs.existsSync(path.join(pluginRoot, "dist", "data")), false);
			assert.equal(fs.existsSync(path.join(pluginRoot, "data", "activated.txt")), false);
		} finally { await host.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
	});

	it("removes traced authoring sources/installers/dev Electron, preserving runtime modules and native binaries", () => {
		withPayload(({ root, write, run }) => {
			for (const extra of [path.join("dist", "old.app", "nested.dmg"), path.join("node_modules", "electron", "dist", "electron.exe"), path.join("plugins", "rich-code-blocks", "tests", "browser.mjs")]) {
				// BOTH copies exist: curation must not touch the real repo's build/runtime.
				write(extra);
				write(path.join(STANDALONE, extra));
			}
			const runtime = [
				"node_modules/@earendil-works/pi-ai/dist/index.js",
				"node_modules/@earendil-works/pi-agent-core/dist/index.js",
				"node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node",
				"node_modules/@resvg/resvg-js-win32-x64-msvc/resvgjs.win32-x64-msvc.node",
				"node_modules/electron-updater/out/main.js",
			];
			for (const file of runtime) write(path.join(STANDALONE, file));
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			assert.equal(fs.existsSync(path.join(root, STANDALONE, "dist")), false);
			assert.equal(fs.existsSync(path.join(root, STANDALONE, "plugins")), false);
			assert.ok(fs.existsSync(path.join(root, "plugins", "rich-code-blocks", "tests", "browser.mjs")));
			assert.deepEqual(fs.readdirSync(path.join(root, STANDALONE, "core-plugins")).sort(), ["coding-questions", "drawing-pad", "flashcards", "rich-code-blocks"]);
			assert.equal(fs.readFileSync(path.join(root, STANDALONE, "core-plugins", "flashcards", "assets", "font.woff"), "utf8"), "bundled-font");
			assert.equal(fs.existsSync(path.join(root, STANDALONE, "node_modules", "electron")), false);
			assert.ok(fs.existsSync(path.join(root, "dist", "old.app", "nested.dmg")));
			assert.ok(fs.existsSync(path.join(root, "node_modules", "electron", "dist", "electron.exe")));
			for (const file of runtime) assert.ok(fs.existsSync(path.join(root, STANDALONE, file)), file);
			assert.ok(fs.existsSync(path.join(root, STANDALONE, ".next", "static", "runtime.js")));
			assert.ok(fs.existsSync(path.join(root, STANDALONE, "public", "asset.txt")));
			for (const asset of ["scripts/plugin-loader.cjs", "public/plugin-loader.js", "plugin-authoring/docs/plugin-authoring.md", "plugin-authoring/docs/plugin-question-contract.md", "plugin-authoring/docs/plugin-session-extension-contract.md", "plugin-authoring/docs/plugin-tree-contract.md", "plugin-authoring/types/index.d.ts", "plugin-authoring/examples/plugins/hello-plugin/dist/manifest.json", "plugin-authoring/examples/plugins/hello-plugin/dist/main.js", "plugin-authoring/SKILL.md", "plugin-authoring/README.md", "plugin-authoring/bundle.json", "public/plugin-authoring/learnharness-plugins.zip"]) {
				assert.ok(fs.existsSync(path.join(root, STANDALONE, asset)), asset);
			}
		});
	});

	it("ships complete authoring docs with self-contained relative links and heading anchors", () => {
		withPayload(({ root, run }) => {
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			const authoring = path.join(root, STANDALONE, "plugin-authoring");
			const files = [...AUTHORING_DOCS.map(file => `docs/${file}`), "SKILL.md", "README.md"];
			const headings = (text: string) => {
				const seen = new Map<string, number>();
				return [...text.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) => {
					assert.ok(heading);
					const slug = heading.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "").replace(/ /g, "-");
					const count = seen.get(slug) ?? 0;
					seen.set(slug, count + 1);
					return count ? `${slug}-${count}` : slug;
				});
			};
			for (const file of files) {
				const from = path.join(authoring, file);
				assert.ok(fs.existsSync(from), `missing authoring document: ${file}`);
				const text = fs.readFileSync(from, "utf8");
				for (const [, href] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
					assert.ok(href);
					if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
					const [relative, fragment] = href.split("#");
					const target = relative ? path.resolve(path.dirname(from), relative) : from;
					assert.ok(!path.relative(authoring, target).startsWith(".."), `${file}: link escapes authoring bundle: ${href}`);
					assert.ok(fs.existsSync(target), `${file}: missing link target: ${href}`);
					if (fragment) assert.ok(headings(fs.readFileSync(target, "utf8")).includes(decodeURIComponent(fragment)), `${file}: missing heading: ${href}`);
				}
			}
		});
	});

	it("accepts a clean payload and is idempotent", () => {
		withPayload(({ run }) => {
			for (let i = 0; i < 2; i++) {
				const result = run();
				assert.equal(result.status, 0, String(result.stderr));
				assert.match(String(result.stdout), /server payload ready/);
			}
		});
	});

	it("still refuses leaked developer data or keys", () => {
		for (const leaked of ["data/chat.json", "auth.json", ".env", ".env.local"]) {
			withPayload(({ write, run }) => {
				write(path.join(STANDALONE, leaked));
				const result = run();
				assert.equal(result.status, 1, leaked);
				assert.match(String(result.stderr), /REFUSING/);
			});
		}
	});

	it("refuses user data accidentally placed inside a Core plugin", () => {
		withPayload(({ write, run }) => {
			write(path.join("core-plugins", "flashcards", "data", "private.json"));
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /REFUSING.*Core plugin/);
		});
	});

	it("refuses missing or extra Core packages instead of shipping an incomplete/stale set", () => {
		for (const mode of ["missing", "extra"]) withPayload(({ root, write, run }) => {
			if (mode === "missing") fs.rmSync(path.join(root, "core-plugins", "flashcards"), { recursive: true });
			else write("core-plugins/ui-showcase/main.js");
			assert.equal(run().status, 1);
		});
	});

	it("still refuses missing runtime prompt assets, including the side brevity fragment", () => {
		for (const asset of [PROMPT, path.join("src", "agent", "prompts", "side-chat", "90-style.md")]) withPayload(({ root, run }) => {
			fs.rmSync(path.join(root, STANDALONE, asset));
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /prompt asset missing/);
		});
	});
});
