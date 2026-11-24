/** Exercise the real PowerShell bootstrap with local download fixtures on Windows. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const bootstrap = fileURLToPath(new URL("../scripts/bootstrap-windows.ps1", import.meta.url));
const payload = "local download fixture";
const checksum = createHash("sha256").update(payload).digest("hex");
const driver = String.raw`
param([string]$Bootstrap, [string]$RuntimeNode, [string]$FixtureHome, [string]$Scenario, [string]$Checksum)
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = $FixtureHome
$env:PATH = "$env:SystemRoot\System32"
$env:PROCESSOR_ARCHITEW6432 = 'AMD64'
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
if ($Scenario -eq 'path') { $env:PATH = (Join-Path $FixtureHome 'path-node') + ';' + $env:PATH }
function global:Invoke-RestMethod {
    param($Uri, $TimeoutSec)
    if ($Scenario -in @('cached', 'path')) { throw 'Cached runtime tried to access the network.' }
    Add-Content -LiteralPath (Join-Path $FixtureHome 'requests.txt') -Value $Uri
    # Ignore a newer unsupported major and select the latest stable 26.x.
    @(
        [pscustomobject]@{version='v27.0.0'; files=@('win-x64-zip')},
        [pscustomobject]@{version='v26.13.0'; files=@('win-x64-zip')},
        [pscustomobject]@{version='v26.13.1'; files=@('win-x64-zip')}
    )
}
function global:Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec)
    Add-Content -LiteralPath (Join-Path $FixtureHome 'requests.txt') -Value $Uri
    if ($Uri.EndsWith('SHASUMS256.txt')) {
        $expected = $Checksum
        if ($Scenario -eq 'checksum') { $expected = '0' * 64 }
        return [pscustomobject]@{Content="$expected  node-v26.13.1-win-x64.zip"}
    }
    [IO.File]::WriteAllText($OutFile, 'local download fixture', [Text.Encoding]::ASCII)
}
function global:Expand-Archive {
    param($LiteralPath, $DestinationPath)
    Add-Content -LiteralPath (Join-Path $FixtureHome 'extracted.txt') -Value $LiteralPath
    $candidate = Join-Path $DestinationPath 'node-v26.13.1-win-x64'
    $npm = Join-Path $candidate 'node_modules\npm\bin'
    New-Item -ItemType Directory -Path $npm -Force | Out-Null
    New-Item -ItemType HardLink -Path (Join-Path $candidate 'node.exe') -Value $RuntimeNode | Out-Null
    Set-Content -LiteralPath (Join-Path $npm 'npm-cli.js') -Value "console.log('11.20.0');" -Encoding Ascii
}
& $Bootstrap -InstallOnly
exit $LASTEXITCODE
`;

function nodeFixture(directory: string, npm = true) {
	mkdirSync(directory, { recursive: true });
	try { linkSync(process.execPath, path.join(directory, "node.exe")); }
	catch { copyFileSync(process.execPath, path.join(directory, "node.exe")); }
	if (npm) {
		const bin = path.join(directory, "node_modules", "npm", "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(path.join(bin, "npm-cli.js"), "console.log('11.20.0');\n");
	}
}

function fixture(scenario: string) {
	const directory = mkdtempSync(path.join(tmpdir(), "learnharness-bootstrap-test-"));
	const runtime = path.join(directory, "LearnHarness", "runtime", "node26-x64");
	if (scenario === "cached") nodeFixture(runtime);
	if (scenario === "repair") nodeFixture(runtime, false);
	if (scenario === "path") nodeFixture(path.join(directory, "path-node"));
	const script = path.join(directory, "driver.ps1");
	writeFileSync(script, driver);
	return {
		directory, runtime,
		run: () => spawnSync(path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
			"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
			"-Bootstrap", bootstrap, "-RuntimeNode", process.execPath,
			"-FixtureHome", directory, "-Scenario", scenario, "-Checksum", checksum,
		], { encoding: "utf8", timeout: 30000, windowsHide: true }),
		cleanup: () => {
			assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
			assert.ok(path.basename(directory).startsWith("learnharness-bootstrap-test-"));
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

describe("Windows launcher runtime bootstrap", { skip: process.platform !== "win32" || !process.versions.node.startsWith("26.") }, () => {
	for (const scenario of ["install", "repair"]) {
		it(`${scenario === "install" ? "installs without existing Node/npm" : "repairs a runtime missing npm"} and reuses it offline`, t => {
			const test = fixture(scenario); t.after(test.cleanup);
			const first = test.run();
			assert.equal(first.status, 0, first.stdout + first.stderr);
			assert.ok(existsSync(path.join(test.runtime, "node.exe")));
			assert.ok(existsSync(path.join(test.runtime, "node_modules", "npm", "bin", "npm-cli.js")));
			assert.deepEqual(readdirSync(path.dirname(test.runtime)), ["node26-x64"], "staging/backup folders were not cleaned up");
			const requests = readFileSync(path.join(test.directory, "requests.txt"), "utf8");
			assert.match(requests, /https:\/\/nodejs\.org\/dist\/v26\.13\.1\/node-v26\.13\.1-win-x64\.zip/);
			const second = test.run();
			assert.equal(second.status, 0, second.stdout + second.stderr);
			assert.equal(readFileSync(path.join(test.directory, "requests.txt"), "utf8"), requests, "repeat launch downloaded again");
		});
	}

	it("rejects a checksum mismatch before extraction or execution", t => {
		const test = fixture("checksum"); t.after(test.cleanup);
		const result = test.run();
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /failed its SHA-256 check/);
		assert.equal(existsSync(test.runtime), false);
		assert.equal(existsSync(path.join(test.directory, "extracted.txt")), false);
		assert.deepEqual(readdirSync(path.dirname(test.runtime)), []);
	});

	for (const scenario of ["cached", "path"]) {
		it(`uses a working ${scenario === "cached" ? "managed" : "PATH"} runtime without network access`, t => {
			const test = fixture(scenario); t.after(test.cleanup);
			const result = test.run();
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.match(result.stdout, /Using v26\./);
			assert.equal(existsSync(path.join(test.directory, "requests.txt")), false);
		});
	}
});
