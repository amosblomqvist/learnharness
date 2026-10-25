/** Run the real payload-curation script in throwaway repository fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const source = fs.readFileSync(new URL("../scripts/build-server.mjs", import.meta.url), "utf8");
// The fixture owns every input/output path. Resolve the real helper at its
// source location so its Next tracer dependency comes from this checkout.
const fixtureSource = source.replace('from "./standalone-traces.mjs"', `from ${JSON.stringify(new URL("../scripts/standalone-traces.mjs", import.meta.url).href)}`);
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
		write(path.join("scripts", "build-server.mjs"), fixtureSource);
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
		for (const leaked of ["data/chat.json", "auth.json", ".env", ".env.local", ".env.production.local"]) {
			withPayload(({ write, run }) => {
				write(path.join(STANDALONE, leaked));
				const result = run();
				assert.equal(result.status, 1, leaked);
				assert.match(String(result.stderr), /REFUSING/);
			});
		}
	});

	it("filters traced private files on Windows and POSIX paths while preserving source data and provider catalogs", () => {
		withPayload(({ root, write, run }) => {
			const privateFiles = ["data/chats/lesson.json", "data/graph/nodes.jsonl", "auth.json", ".env.production.local"];
			const providerCatalog = "node_modules/@earendil-works/pi-ai/dist/providers/data/models.json";
			for (const file of [...privateFiles, providerCatalog]) {
				write(file, `original:${file}`);
				write(path.join(STANDALONE, file), `original:${file}`);
			}
			const trace = path.join(".next", "server", "app", "page.js.nft.json");
			const relative = (file: string) => path.relative(path.dirname(trace), file).replace(/\\/g, "/");
			write(trace, JSON.stringify({ version: 1, files: [...privateFiles.map((file, i) => i % 2 ? relative(file).replace(/\//g, "\\") : relative(file)), relative(providerCatalog)] }));
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			for (const file of privateFiles) {
				assert.equal(fs.readFileSync(path.join(root, file), "utf8"), `original:${file}`, "the original private file must stay untouched");
				assert.equal(fs.existsSync(path.join(root, STANDALONE, file)), false, file);
			}
			assert.equal(fs.existsSync(path.join(root, STANDALONE, "data")), false);
			const repaired = JSON.parse(fs.readFileSync(path.join(root, trace), "utf8"));
			assert.deepEqual(repaired.files, [relative(providerCatalog)]);
			assert.equal(fs.readFileSync(path.join(root, STANDALONE, providerCatalog), "utf8"), `original:${providerCatalog}`);
			assert.equal(run().status, 0, "trace repair is idempotent");
		});
	});

	it("traces the missing Next bootstrap module and its transitive runtime dependencies", () => {
		withPayload(({ root, write, run }) => {
			const bootstrap = "node_modules/next/dist/server/lib/router-utils/filesystem.js";
			const metadata = "node_modules/next/dist/lib/metadata/get-metadata-route.js";
			const helper = "node_modules/next/dist/lib/metadata/runtime-helper.js";
			write("node_modules/next/package.json", '{"name":"next","version":"fixture"}');
			write(bootstrap, 'module.exports = require("../../../lib/metadata/get-metadata-route");');
			write(path.join(STANDALONE, bootstrap), 'module.exports = require("../../../lib/metadata/get-metadata-route");');
			write(metadata, 'module.exports = require("./runtime-helper");');
			write(helper, 'module.exports = "metadata loaded";');
			write(path.join(".next", "next-server.js.nft.json"), JSON.stringify({ version: 1, files: [] }));
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			const probe = spawnSync(process.execPath, ["--input-type=module", "--eval", `import value from ${JSON.stringify(pathToFileURL(path.join(root, STANDALONE, bootstrap)).href)}; if (value !== "metadata loaded") process.exit(1);`], { encoding: "utf8", timeout: 10_000 });
			assert.equal(probe.status, 0, String(probe.stderr));
			const trace = JSON.parse(fs.readFileSync(path.join(root, ".next", "next-server.js.nft.json"), "utf8"));
			assert.ok(trace.files.some((file: string) => file.replace(/\\/g, "/").endsWith("/metadata/runtime-helper.js")));
		});
	});

	it("refuses a traced data copy redirected through a symlink or Windows junction", () => {
		withPayload(({ root, write, run }) => {
			write("data/chat.json", "source data");
			fs.symlinkSync(path.join(root, "data"), path.join(root, STANDALONE, "data"), process.platform === "win32" ? "junction" : "dir");
			write(".next/server/app/page.js.nft.json", JSON.stringify({ version: 1, files: ["../../../data/chat.json"] }));
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /REFUSING/);
			assert.equal(fs.readFileSync(path.join(root, "data", "chat.json"), "utf8"), "source data");
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
