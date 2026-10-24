/** No installed app, real provider call, or production dependency tree needed. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeEnv } from "../scripts/smoke-demo-runtime.mjs";

const script = fileURLToPath(new URL("../scripts/smoke-demo-runtime.mjs", import.meta.url));

/**
 * A minimal standalone payload holding only the packages the provider gate
 * imports: the pi engine's provider surface (@earendil-works/pi-ai) plus the
 * Google chain it pulls in at runtime (@google/genai -> google-auth-library
 * -> gcp-metadata -> json-bigint). Fixture packages are shape-only: a real
 * package.json plus a real module file where the import lands.
 */
function withPayload(test: (fixture: {
	root: string;
	write: (relative: string, content: string) => void;
	run: () => ReturnType<typeof spawnSync>;
}) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-provider-payload-test-"));
	const write = (relative: string, content: string) => {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	};
	const pkg = (name: string, extra: Record<string, unknown> = {}) =>
		JSON.stringify({ name, version: "0.0.0-fixture", type: "module", ...extra });
	try {
		write("server.js", "// fixture");
		write("node_modules/@earendil-works/pi-ai/package.json", pkg("@earendil-works/pi-ai", { exports: { "./providers/*": { import: "./dist/providers/*" } } }));
		// The lazy provider seam the gate drives: builtinProviders() constructs
		// the Google provider, and its stream call forces the api's dynamic
		// import chain, exactly as the runtime does.
		write(
			"node_modules/@earendil-works/pi-ai/dist/providers/all.js",
			'export const builtinProviders = () => [{ id: "google", stream: async function* () { yield* (await import("../api/google-generative-ai.js")).googleModels; } }];',
		);
		write(
			"node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js",
			'export const googleModels = [{ type: "error" }];\nexport const GoogleGenAI = (await import("@google/genai")).GoogleGenAI;\n',
		);
		write("node_modules/@google/genai/package.json", pkg("@google/genai", { main: "dist/node/index.mjs" }));
		write("node_modules/@google/genai/dist/node/index.mjs", 'import { GoogleAuth } from "google-auth-library"; export const GoogleGenAI = class { constructor() { void GoogleAuth; } };');
		// CJS shape like the real package: a main entry with a top-level require.
		write("node_modules/google-auth-library/package.json", pkg("google-auth-library", { type: "commonjs", main: "build/src/index.js" }));
		write(
			"node_modules/google-auth-library/build/src/index.js",
			'const { gcpMetadata } = require("gcp-metadata");\nmodule.exports.GoogleAuth = class { constructor() { void gcpMetadata; } };\n',
		);
		write("node_modules/gcp-metadata/package.json", pkg("gcp-metadata", { type: "commonjs", main: "build/src/index.js", dependencies: { "json-bigint": "*" } }));
		write("node_modules/gcp-metadata/build/src/index.js", 'const jb = require("json-bigint");\nmodule.exports.gcpResidency = jb;');
		write("node_modules/json-bigint/package.json", pkg("json-bigint", { type: "commonjs", main: "index.js" }));
		write("node_modules/json-bigint/index.js", "module.exports.fixture = true;");
		test({ root, write, run: () => spawnSync(process.execPath, [script, "--standalone", root, "--gate=provider"], {
			encoding: "utf8", timeout: 10_000,
		}) });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("provider standalone dependency gate", () => {
	it("imports the complete Google chain and does not change the payload", () => {
		withPayload(({ root, run }) => {
			const before = fs.readdirSync(root, { recursive: true });
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			assert.match(String(result.stdout), /provider import ok/);
			assert.deepEqual(fs.readdirSync(root, { recursive: true }), before);
		});
	});

	it("fails when the trace dropped a transitive runtime dependency (gcp-metadata)", () => {
		withPayload(({ root, run }) => {
			fs.rmSync(path.join(root, "node_modules", "gcp-metadata"), { recursive: true, force: true });
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /gcp-metadata|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);
		});
	});

	it("rejects imports outside the payload even when they resolve successfully", () => {
		withPayload(({ write, run }) => {
			const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "lh-provider-outside-"));
			try {
				const external = path.join(sibling, "dependency.mjs");
				fs.writeFileSync(external, "export const outside = true;");
				write(
					"node_modules/gcp-metadata/build/src/index.js",
					`module.exports.gcpResidency = require(${JSON.stringify(external)});`,
				);
				const result = run();
				assert.equal(result.status, 1);
				assert.match(String(result.stderr), /escaped standalone payload/);
			} finally { fs.rmSync(sibling, { recursive: true, force: true }); }
		});
	});
});
