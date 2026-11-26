/** Exercise the real bash bootstrap with local download fixtures on Linux. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const bootstrap = fileURLToPath(new URL("../scripts/bootstrap-linux.sh", import.meta.url));
const version = "v26.13.1";
const archiveName = `node-${version}-linux-x64.tar.xz`;
const tools = ["bash", "sh", "env", "dirname", "readlink", "sed", "head", "cut", "tr", "mktemp", "mkdir", "mv", "rm", "tar", "xz", "sha256sum", "flock", "cat", "grep"];

function which(tool: string) {
	return execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
}

/** A Node.js-shaped tree whose `node` only answers --version, with or without npm. */
function nodeTree(directory: string, { npm = true, nodeVersion = version } = {}) {
	mkdirSync(path.join(directory, "bin"), { recursive: true });
	writeFileSync(path.join(directory, "bin", "node"), `#!/bin/sh\necho ${nodeVersion}\n`);
	chmodSync(path.join(directory, "bin", "node"), 0o755);
	if (npm) {
		const npmDirectory = path.join(directory, "lib", "node_modules", "npm");
		mkdirSync(path.join(npmDirectory, "bin"), { recursive: true });
		writeFileSync(path.join(npmDirectory, "bin", "npm-cli.js"), "console.log('11.20.0');\n");
		writeFileSync(path.join(npmDirectory, "package.json"), JSON.stringify({ name: "npm", version: "11.20.0" }, null, 2));
	}
}

function fixture(t: TestContext, scenario: "install" | "repair" | "cached" | "path" | "checksum" | "redirected") {
	const directory = mkdtempSync(path.join(tmpdir(), "learnharness-bootstrap-test-"));
	t.after(() => {
		assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
		assert.ok(path.basename(directory).startsWith("learnharness-bootstrap-test-"));
		rmSync(directory, { recursive: true, force: true });
	});
	const home = path.join(directory, "home");
	const runtimeRoot = path.join(home, ".local", "share", "LearnHarness", "runtime");
	const runtime = path.join(runtimeRoot, "node26-x64");
	mkdirSync(home);
	if (scenario === "cached") nodeTree(runtime);
	if (scenario === "repair") nodeTree(runtime, { npm: false });
	if (scenario === "path") nodeTree(path.join(directory, "path-node"));
	if (scenario === "redirected") {
		mkdirSync(path.join(directory, "elsewhere"));
		mkdirSync(path.join(home, ".local", "share"), { recursive: true });
		symlinkSync(path.join(directory, "elsewhere"), path.join(home, ".local", "share", "LearnHarness"));
	}

	// The release archive the stub curl serves.
	const release = path.join(directory, "release");
	nodeTree(path.join(release, `node-${version}-linux-x64`));
	const archive = path.join(directory, archiveName);
	execFileSync("tar", ["-cJf", archive, "-C", release, `node-${version}-linux-x64`]);
	const checksum = scenario === "checksum" ? "0".repeat(64) : createHash("sha256").update(readFileSync(archive)).digest("hex");
	writeFileSync(path.join(directory, "SHASUMS256.txt"), [
		`${"1".repeat(64)}  node-${version}-darwin-arm64.tar.xz`,
		`${"2".repeat(64)}  node-${version}-linux-arm64.tar.xz`,
		`${checksum}  ${archiveName}`,
		`${"3".repeat(64)}  node-${version}-win-x64.zip`,
	].join("\n") + "\n");

	// A minimal PATH: the system tools the bootstrap needs plus stubs for curl and uname.
	const bin = path.join(directory, "bin");
	mkdirSync(bin);
	for (const tool of tools) symlinkSync(which(tool), path.join(bin, tool));
	writeFileSync(path.join(bin, "uname"), "#!/bin/sh\necho x86_64\n");
	writeFileSync(path.join(bin, "curl"), `#!/bin/bash
set -e
out="" url=""
while [ $# -gt 0 ]; do
	case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
echo "$url" >> '${directory}/requests.txt'
[ ! -e '${directory}/offline' ] || { echo "offline: $url" >&2; exit 7; }
case "$url" in
	https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt) cat '${directory}/SHASUMS256.txt' > "$out" ;;
	https://nodejs.org/dist/${version}/${archiveName}) cat '${directory}/${archiveName}' > "$out" ;;
	*) exit 22 ;;
esac
`);
	chmodSync(path.join(bin, "uname"), 0o755);
	chmodSync(path.join(bin, "curl"), 0o755);
	if (scenario === "cached" || scenario === "path") writeFileSync(path.join(directory, "offline"), "");

	const pathValue = scenario === "path" ? `${path.join(directory, "path-node", "bin")}:${bin}` : bin;
	return {
		directory, runtime, runtimeRoot,
		offline: () => writeFileSync(path.join(directory, "offline"), ""),
		requests: () => existsSync(path.join(directory, "requests.txt"))
			? readFileSync(path.join(directory, "requests.txt"), "utf8").trim().split("\n") : [],
		run: (args = ["--install-only"], input = "") => spawnSync(path.join(bin, "bash"), [bootstrap, ...args], {
			encoding: "utf8", timeout: 30_000, input,
			env: { HOME: home, PATH: pathValue, LANG: "C", NODE_ENV: "test" },
		}),
	};
}

const downloads = [
	"https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt",
	`https://nodejs.org/dist/${version}/${archiveName}`,
];

function leftovers(runtimeRoot: string) {
	return existsSync(runtimeRoot) ? readdirSync(runtimeRoot).filter(name => name.startsWith("setup-")) : [];
}

describe("Linux launcher runtime bootstrap", { skip: process.platform !== "linux" }, () => {
	for (const scenario of ["install", "repair"] as const) {
		it(`${scenario === "install" ? "installs without existing Node/npm" : "repairs a runtime missing npm"} and reuses it offline`, t => {
			const f = fixture(t, scenario);
			const first = f.run();
			assert.equal(first.status, 0, first.stderr + first.stdout);
			assert.match(first.stdout, new RegExp(`Using ${version} with npm from ${f.runtime}/bin`));
			assert.deepEqual(f.requests(), downloads);
			assert.ok(existsSync(path.join(f.runtime, "lib", "node_modules", "npm", "bin", "npm-cli.js")));
			assert.deepEqual(leftovers(f.runtimeRoot), []);
			f.offline();
			const second = f.run();
			assert.equal(second.status, 0, second.stderr);
			assert.doesNotMatch(second.stdout, /Downloading/);
			assert.deepEqual(f.requests(), downloads, "the second launch made no requests");
		});
	}

	it("rejects a checksum mismatch before extraction or execution", t => {
		const f = fixture(t, "checksum");
		const result = f.run();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /failed its SHA-256 check\. Nothing was installed/);
		assert.equal(existsSync(f.runtime), false);
		assert.deepEqual(leftovers(f.runtimeRoot), [], "the download stage is removed");
	});

	it("waits for Enter after a failure only when asked to", t => {
		const f = fixture(t, "checksum");
		const paused = f.run(["--install-only", "--pause-on-error"], "\n");
		assert.equal(paused.status, 1);
		assert.match(paused.stdout, /could not finish successfully[\s\S]*Press Enter to close\./);
		assert.doesNotMatch(f.run().stdout, /Press Enter/);
	});

	it("refuses a redirected managed runtime folder without downloading or modifying it", t => {
		const f = fixture(t, "redirected");
		const result = f.run();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Refusing a redirected LearnHarness runtime path/);
		assert.deepEqual(f.requests(), []);
		assert.deepEqual(readdirSync(path.join(f.directory, "elsewhere")), []);
	});

	for (const scenario of ["cached", "path"] as const) {
		it(`uses a working ${scenario === "cached" ? "managed" : "PATH"} runtime without network access`, t => {
			const f = fixture(t, scenario);
			const result = f.run();
			assert.equal(result.status, 0, result.stderr);
			const expected = scenario === "cached" ? f.runtime : realpathSync(path.join(f.directory, "path-node"));
			assert.match(result.stdout, new RegExp(`Using ${version} with npm from ${expected}/bin`));
			assert.deepEqual(f.requests(), []);
		});
	}

	it("skips a PATH Node that is not 26.x and installs the managed runtime instead", t => {
		const f = fixture(t, "install");
		nodeTree(path.join(f.directory, "old-node"), { nodeVersion: "v24.1.0" });
		const result = spawnSync(path.join(f.directory, "bin", "bash"), [bootstrap, "--install-only"], {
			encoding: "utf8", timeout: 30_000,
			env: { HOME: path.join(f.directory, "home"), PATH: `${path.join(f.directory, "old-node", "bin")}:${path.join(f.directory, "bin")}`, LANG: "C", NODE_ENV: "test" },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, new RegExp(`from ${f.runtime}/bin`));
	});

	it("rejects unknown arguments", t => {
		const result = fixture(t, "cached").run(["--bogus"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Usage: learn \[restart\]/);
	});
});
