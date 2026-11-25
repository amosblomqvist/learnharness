import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const registration = fileURLToPath(new URL("../scripts/register-windows-launchers.ps1", import.meta.url));
const driver = String.raw`
param($Registration, $LocalAppData, $Startup, $Original, $Moved)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:LOCALAPPDATA = $LocalAppData
$bin = Join-Path $LocalAppData 'LearnHarness\bin'
. $Registration
$registry = [Microsoft.Win32.Registry]::CurrentUser
$keyName = 'Software\LearnHarnessRegistrationTest-' + [guid]::NewGuid().ToString('N')
$key = $registry.CreateSubKey($keyName)
try {
    $key.SetValue('Path', '%SystemRoot%\System32;', 'ExpandString')
    $added = Register-LearnHarnessWindowsLaunchers $Original $Startup $key
    $shortcutPath = Join-Path $Startup 'LearnHarness.lnk'
    $firstModified = (Get-Item -LiteralPath $shortcutPath).LastWriteTimeUtc.Ticks
    $again = Register-LearnHarnessWindowsLaunchers $Original $Startup $key
    $updated = Register-LearnHarnessWindowsLaunchers $Moved $Startup $key
    $lastModified = (Get-Item -LiteralPath $shortcutPath).LastWriteTimeUtc.Ticks
    $env:Path = "$Bin;$env:Path"
    $terminalOutput = & learn
    $terminalExit = $LASTEXITCODE
    $cmdOutput = & $env:ComSpec /d /c learn
    $cmdExit = $LASTEXITCODE
    $env:LH_TEST_SIGN_IN_OUTPUT = Join-Path $LocalAppData 'sign-in.txt'
    $process = Start-Process -FilePath $shortcutPath -WindowStyle Hidden -PassThru -Wait
    try {
        $signInOutput = [IO.File]::ReadAllText($env:LH_TEST_SIGN_IN_OUTPUT)
        $signInExit = $process.ExitCode
    } finally { $process.Dispose() }
    [pscustomobject]@{
        Added = $added; Again = $again; Updated = $updated
        Path = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        PathKind = [string]$key.GetValueKind('Path')
        SameShortcut = $firstModified -eq $lastModified
        TerminalOutput = $terminalOutput; TerminalExit = $terminalExit
        CmdOutput = $cmdOutput; CmdExit = $cmdExit
        SignInOutput = $signInOutput; SignInExit = $signInExit
    } | ConvertTo-Json -Compress
} finally {
    $key.Dispose()
    $registry.DeleteSubKey($keyName)
}
`;

test("registers the Windows CLI and sign-in shortcut once and updates both after a checkout move", { skip: process.platform !== "win32" }, t => {
	const fixture = mkdtempSync(path.join(tmpdir(), "learnharness-registration-test-"));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	const localAppData = path.join(fixture, "Local AppData 学");
	const bin = path.join(localAppData, "LearnHarness", "bin");
	const startup = path.join(fixture, "Startup 学");
	const original = path.join(fixture, "Original", "workspace", "scripts", "bootstrap-windows.ps1");
	const moved = path.join(fixture, "Learner's Moved Checkout 学", "workspace", "scripts", "bootstrap-windows.ps1");
	for (const bootstrap of [original, moved]) {
		mkdirSync(path.dirname(bootstrap), { recursive: true });
		const output = bootstrap === moved ? "moved checkout" : "original checkout";
		writeFileSync(bootstrap, `
if ($env:LH_TEST_SIGN_IN_OUTPUT) {
    [IO.File]::WriteAllText($env:LH_TEST_SIGN_IN_OUTPUT, '${output}')
}
Write-Output '${output}'
exit 0
`);
	}
	mkdirSync(startup);
	const script = path.join(fixture, "driver.ps1");
	writeFileSync(script, driver);
	const result = spawnSync(path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
		"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
		"-Registration", registration, "-LocalAppData", localAppData, "-Startup", startup, "-Original", original, "-Moved", moved,
	], {
		cwd: fixture,
		encoding: "utf8",
		env: { ...process.env, LH_DATA_DIR: path.join(fixture, "data"), LH_AUTH_FILE: path.join(fixture, "auth.json") },
		timeout: 30_000,
		windowsHide: true,
	});
	assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		Added: true, Again: false, Updated: false,
		Path: `%SystemRoot%\\System32;${bin}`, PathKind: "ExpandString",
		SameShortcut: true,
		TerminalOutput: "moved checkout", TerminalExit: 0,
		CmdOutput: "moved checkout", CmdExit: 0,
		SignInOutput: "moved checkout", SignInExit: 0,
	});
});
