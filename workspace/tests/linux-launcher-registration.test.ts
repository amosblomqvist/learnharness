/** The Linux `learn` command written after a successful double-click launch. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const register = fileURLToPath(new URL("../scripts/register-linux-launcher.sh", import.meta.url));

function fixture(t: TestContext) {
	const directory = mkdtempSync(path.join(tmpdir(), "learnharness-register-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const home = path.join(directory, "home");
	mkdirSync(home);
	const shim = path.join(home, ".local", "bin", "learn");
	/** A stand-in bootstrap in a checkout path with a space and a single quote. */
	const checkout = (name: string) => {
		const scripts = path.join(directory, name, "workspace", "scripts");
		mkdirSync(scripts, { recursive: true });
		const bootstrap = path.join(scripts, "bootstrap-linux.sh");
		writeFileSync(bootstrap, `printf '%s|' "${name}" "$@" > '${directory}/ran.txt'\n`);
		return bootstrap;
	};
	const run = (bootstrap: string, pathValue = `${path.join(home, ".local", "bin")}:/usr/bin:/bin`) =>
		spawnSync("bash", [register, bootstrap], { encoding: "utf8", env: { HOME: home, PATH: pathValue, NODE_ENV: "test" } });
	const learn = (...args: string[]) => {
		const result = spawnSync(shim, args, { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin", NODE_ENV: "test" } });
		assert.equal(result.status, 0, result.stderr);
		return readFileSync(path.join(directory, "ran.txt"), "utf8");
	};
	return { directory, shim, checkout, run, learn };
}

test("registers the Linux learn command once and updates it after a checkout move", { skip: process.platform !== "linux" }, t => {
	const f = fixture(t);
	const first = f.checkout("Learn Harness's checkout");
	const result = f.run(first);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "", "no PATH hint when ~/.local/bin is on PATH");
	assert.equal(statSync(f.shim).mode & 0o777, 0o755);
	assert.match(readFileSync(f.shim, "utf8"), /^#!\/bin\/sh\n# LearnHarness source checkout launcher\n/);
	assert.equal(f.learn("restart", "two words"), "Learn Harness's checkout|restart|two words|");

	const contents = readFileSync(f.shim, "utf8");
	const mtime = statSync(f.shim).mtimeMs;
	assert.equal(f.run(first).status, 0);
	assert.equal(readFileSync(f.shim, "utf8"), contents);
	assert.equal(statSync(f.shim).mtimeMs, mtime, "an up-to-date command is not rewritten");

	const moved = f.checkout("moved");
	assert.equal(f.run(moved).status, 0);
	assert.equal(f.learn(), "moved|");
});

test("refuses to replace a learn command it did not write", { skip: process.platform !== "linux" }, t => {
	const f = fixture(t);
	const bootstrap = f.checkout("checkout");
	mkdirSync(path.dirname(f.shim), { recursive: true });
	writeFileSync(f.shim, "#!/bin/sh\necho someone else\n");
	chmodSync(f.shim, 0o755);
	const foreign = f.run(bootstrap);
	assert.equal(foreign.status, 1);
	assert.match(foreign.stderr, /A different launcher already uses/);
	assert.equal(readFileSync(f.shim, "utf8"), "#!/bin/sh\necho someone else\n");

	rmSync(f.shim);
	const target = path.join(f.directory, "target");
	writeFileSync(target, "# LearnHarness source checkout launcher\n");
	symlinkSync(target, f.shim);
	assert.equal(f.run(bootstrap).status, 1, "a linked command is refused even with the marker");
	assert.equal(readFileSync(target, "utf8"), "# LearnHarness source checkout launcher\n");
});

test("hints when ~/.local/bin is not on PATH and rejects a relative bootstrap", { skip: process.platform !== "linux" }, t => {
	const f = fixture(t);
	const result = f.run(f.checkout("checkout"), "/usr/bin:/bin");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Add .*\.local\/bin to your PATH/);
	assert.ok(existsSync(f.shim));
	const relative = f.run("workspace/scripts/bootstrap-linux.sh");
	assert.equal(relative.status, 1);
	assert.match(relative.stderr, /must be absolute/);
});
