import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set storage before the test processes import config.ts. Even an inherited
// LH_DATA_DIR/LH_AUTH_FILE may point to real user data, so always replace both.
const root = path.resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "lh-tests-"));
const args = process.argv.slice(2);
const files = args.length > 0 ? args : readdirSync(path.join(root, "tests"))
	.filter((name) => /\.test\.tsx?$/.test(name))
	.sort()
	.map((name) => path.join(root, "tests", name));
try {
	const env = {
		...process.env,
		NODE_ENV: "test",
		LH_DATA_DIR: path.join(temporaryRoot, "data"),
		LH_AUTH_FILE: path.join(temporaryRoot, "auth.json"),
	};
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
		cwd: root, env, stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	// Only remove the exact scratch directory created by this invocation.
	if (path.dirname(temporaryRoot) !== path.resolve(tmpdir()) || !path.basename(temporaryRoot).startsWith("lh-tests-")) {
		throw new Error("Unexpected test scratch directory");
	}
	rmSync(temporaryRoot, { recursive: true, force: true });
}
