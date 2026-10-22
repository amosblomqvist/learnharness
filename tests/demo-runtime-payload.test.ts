/** No display, real browser, installed app, or production dependency tree needed. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatProbeError, probeEnv } from "../scripts/smoke-demo-runtime.mjs";

const script = fileURLToPath(new URL("../scripts/smoke-demo-runtime.mjs", import.meta.url));

function withPayload(test: (fixture: {
	root: string;
	write: (relative: string, content: string) => void;
	run: () => ReturnType<typeof spawnSync>;
}) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-demo-payload-test-"));
	const write = (relative: string, content: string) => {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	};
	try {
		write("server.js", "// fixture");
		write("node_modules/puppeteer-core/package.json", JSON.stringify({ name: "puppeteer-core", type: "module", main: "lib/index.js" }));
		write("node_modules/puppeteer-core/lib/index.js", 'import "./browser-data/browser-data.js"; export default { connect() {} };');
		test({ root, write, run: () => spawnSync(process.execPath, [script, "--standalone", root], {
			encoding: "utf8", timeout: 10_000,
		}) });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("demo standalone dependency gate", () => {
	it("imports a complete payload and does not change it", () => {
		withPayload(({ root, write, run }) => {
			write("node_modules/puppeteer-core/lib/browser-data/browser-data.js", "export const fixture = true;");
			const before = fs.readdirSync(root, { recursive: true });
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			assert.match(String(result.stdout), /puppeteer-core import ok/);
			assert.deepEqual(fs.readdirSync(root, { recursive: true }), before);
		});
	});

	it("fails when a transitive runtime subdirectory is missing", () => {
		withPayload(({ root, run }) => {
			const before = fs.readdirSync(root, { recursive: true });
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /ERR_MODULE_NOT_FOUND/);
			assert.match(String(result.stderr), /browser-data/);
			assert.deepEqual(fs.readdirSync(root, { recursive: true }), before);
		});
	});

	it("rejects imports outside the payload even when they resolve successfully", () => {
		withPayload(({ write, run }) => {
			// A sibling file, not just a missing file: resolution succeeds but confinement must fail.
			const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "lh-demo-outside-"));
			try {
				const external = path.join(sibling, "dependency.mjs");
				fs.writeFileSync(external, "export const outside = true;");
				write("node_modules/puppeteer-core/lib/index.js", `import ${JSON.stringify(pathToFileURL(external).href)}; export default { connect() {} };`);
				const result = run();
				assert.equal(result.status, 1);
				assert.match(String(result.stderr), /dependency escaped standalone payload/);
			} finally { fs.rmSync(sibling, { recursive: true, force: true }); }
		});
	});

	it("cannot substitute the checkout's Puppeteer for an absent payload package", () => {
		withPayload(({ root, run }) => {
			fs.rmSync(path.join(root, "node_modules"), { recursive: true });
			const result = run();
			assert.equal(result.status, 1);
			assert.doesNotMatch(String(result.stdout), /import ok/);
		});
	});

	it("preserves nested fetch/socket causes without dumping headers or environment", () => {
		const socket = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", address: "127.0.0.1", port: 54321 });
		const cause = new AggregateError([socket], "connection failed");
		const error = Object.assign(new TypeError("fetch failed", { cause }), { headers: { authorization: "private-header" }, env: { TOKEN: "private-token" } });
		const output = formatProbeError(error);
		assert.match(output, /fetch failed/);
		assert.match(output, /connection failed/);
		assert.match(output, /ECONNREFUSED/);
		assert.match(output, /127\.0\.0\.1/);
		assert.match(output, /54321/);
		assert.doesNotMatch(output, /private-header|private-token|authorization|TOKEN/);
	});

	it("strips secrets and uses only scratch data/auth/profile locations", () => {
		const original = { PATH: "/bin", API_KEY: "fake", GH_TOKEN: "fake", MY_SECRET: "fake", PASSWORD: "fake", NODE_OPTIONS: "--require anything", NODE_PATH: "/outside", ELECTRON_RUN_AS_NODE: "1", LH_DEV_URL: "http://localhost", LH_DATA_DIR: "/real", LH_AUTH_FILE: "/real/auth.json", GOOGLE_APPLICATION_CREDENTIALS: "/real/google.json", AWS_SHARED_CREDENTIALS_FILE: "/real/aws", AWS_PROFILE: "real-profile", CLOUDSDK_CONFIG: "/real/gcloud" };
		const env = probeEnv(original, "/scratch");
		for (const key of ["API_KEY", "GH_TOKEN", "MY_SECRET", "PASSWORD", "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "LH_DEV_URL", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_SHARED_CREDENTIALS_FILE", "AWS_PROFILE", "CLOUDSDK_CONFIG"]) assert.equal(key in env, false, key);
		assert.equal(env.PATH, "/bin");
		assert.equal(env.LH_DATA_DIR, path.join("/scratch", "data"));
		assert.equal(env.LH_AUTH_FILE, path.join("/scratch", "auth.json"));
		assert.equal(env.LH_IGNORE_ENV_KEYS, "1");
		assert.equal(env.HOME, "/scratch");
		assert.equal(original.API_KEY, "fake");
	});
});
