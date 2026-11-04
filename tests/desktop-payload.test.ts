/** Run the real payload-curation script in throwaway repository fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const source = fs.readFileSync(new URL("../scripts/build-server.mjs", import.meta.url), "utf8");
const STANDALONE = path.join(".next", "standalone");
const PROMPT = path.join("src", "agent", "system-prompt.md");

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
		write(path.join("scripts", "plugin-loader.cjs"), "exports.load = () => {};\n");
		// Declaration generation is tested separately. This fixture tests payload
		// curation, not the TypeScript compiler or the full application sources.
		write(path.join("scripts", "build-plugin-types.mjs"), `import fs from 'node:fs'; import path from 'node:path'; fs.mkdirSync(process.argv[2], {recursive:true}); fs.writeFileSync(path.join(process.argv[2], 'index.d.ts'), 'export interface Example {}');`);
		write(path.join("public", "plugin-loader.js"), "export {};\n");
		write(path.join("docs", "plugin-authoring.md"));
		write(path.join("docs", "plugin-architecture.md"));
		write(path.join("docs", "plugin-question-contract.md"));
		write(path.join("docs", "plugin-session-extension-contract.md"));
		write(path.join("docs", "plugin-tree-contract.md"));
		write(path.join("examples", "plugins", "hello-plugin", "manifest.json"));
		write(path.join("examples", "plugins", "hello-plugin", "main.js"));
		write(path.join("skills", "learnharness-plugins", "SKILL.md"));
		write(path.join(STANDALONE, "server.js"));
		write(path.join(".next", "static", "runtime.js"));
		write(path.join("public", "asset.txt"));
		write(path.join(STANDALONE, PROMPT));
		write(path.join(STANDALONE, "src", "agent", "prompts", "teacher", "20-teaching.md"));
		test({ root, write, run: () => spawnSync(process.execPath, [path.join(root, "scripts", "build-server.mjs")], {
			cwd: root, encoding: "utf8", timeout: 10_000,
		}) });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("desktop standalone payload", () => {
	it("removes only traced installers/dev Electron, preserving runtime dist/ and native binaries", () => {
		withPayload(({ root, write, run }) => {
			for (const extra of [path.join("dist", "old.app", "nested.dmg"), path.join("node_modules", "electron", "dist", "electron.exe")]) {
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
			assert.equal(fs.existsSync(path.join(root, STANDALONE, "node_modules", "electron")), false);
			assert.ok(fs.existsSync(path.join(root, "dist", "old.app", "nested.dmg")));
			assert.ok(fs.existsSync(path.join(root, "node_modules", "electron", "dist", "electron.exe")));
			for (const file of runtime) assert.ok(fs.existsSync(path.join(root, STANDALONE, file)), file);
			assert.ok(fs.existsSync(path.join(root, STANDALONE, ".next", "static", "runtime.js")));
			assert.ok(fs.existsSync(path.join(root, STANDALONE, "public", "asset.txt")));
			for (const asset of ["scripts/plugin-loader.cjs", "public/plugin-loader.js", "plugin-authoring/docs/plugin-authoring.md", "plugin-authoring/docs/plugin-question-contract.md", "plugin-authoring/docs/plugin-session-extension-contract.md", "plugin-authoring/docs/plugin-tree-contract.md", "plugin-authoring/types/index.d.ts", "plugin-authoring/examples/plugins/hello-plugin/main.js", "plugin-authoring/skills/learnharness-plugins/SKILL.md"]) {
				assert.ok(fs.existsSync(path.join(root, STANDALONE, asset)), asset);
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

	it("refuses user data accidentally placed inside a bundled plugin", () => {
		withPayload(({ write, run }) => {
			write(path.join("bundled-plugins", "example", "data", "private.json"));
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /REFUSING.*bundled plugin/);
		});
	});

	it("still refuses a missing runtime prompt asset", () => {
		withPayload(({ root, run }) => {
			fs.rmSync(path.join(root, STANDALONE, PROMPT));
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /prompt asset missing/);
		});
	});
});
