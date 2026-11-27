# Shared helpers for the Windows launchers (lh-app.ps1, lh-web.ps1, setup.ps1).
# Dot-source this file; it defines functions only.
#
# The launchers run a dedicated clone that follows origin/main, rebuilt only
# when HEAD changes, and serve the production standalone server on 127.0.0.1.
# Data and keys live where the packaged app keeps them (%APPDATA%\LearnHarness Fork).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-LhConfig {
	param(
		[Parameter(Mandatory)][string]$AppDir,
		[Parameter(Mandatory)][int]$Port
	)
	$userData = Join-Path $env:APPDATA 'LearnHarness Fork'
	[pscustomobject]@{
		AppDir      = $AppDir
		Port        = $Port
		Url         = "http://127.0.0.1:$Port"
		RepoUrl     = 'https://github.com/reeschan/learnharness.git'
		Branch      = 'main'
		DataDir     = Join-Path $userData 'data'
		AuthFile    = Join-Path $userData 'auth.json'
		ServerJs    = Join-Path $AppDir '.next\standalone\server.js'
		BuildMarker = Join-Path $AppDir '.next\lh-launcher-build-sha'
		DepsMarker  = Join-Path $AppDir 'node_modules\.lh-launcher-lock-sha'
		PakeDir     = Join-Path $env:LOCALAPPDATA 'LearnHarness Fork Launcher'
		PakeExe     = Join-Path (Join-Path $env:LOCALAPPDATA 'LearnHarness Fork Launcher') 'LearnHarnessFork.exe'
	}
}

function Write-LhStep {
	param([Parameter(Mandatory)][string]$Message)
	Write-Host "[learnharness] $Message" -ForegroundColor Cyan
}

function Write-LhWarn {
	param([Parameter(Mandatory)][string]$Message)
	Write-Host "[learnharness] $Message" -ForegroundColor Yellow
}

# Runs a native command and throws when it exits non-zero. Output goes to the
# host so it never leaks into a caller's return value.
function Invoke-LhNative {
	param(
		[Parameter(Mandatory)][string]$Command,
		[string[]]$Arguments = @()
	)
	& $Command @Arguments | Out-Host
	if ($LASTEXITCODE -ne 0) {
		throw "$Command $($Arguments -join ' ') exited with code $LASTEXITCODE"
	}
}

function Read-LhMarker {
	param([Parameter(Mandatory)][string]$Path)
	if (Test-Path -LiteralPath $Path) { return (Get-Content -LiteralPath $Path -Raw).Trim() }
	return ''
}

function Write-LhMarker {
	param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Value)
	Set-Content -LiteralPath $Path -Value $Value -Encoding ascii
}

function Test-LhPortListening {
	param([Parameter(Mandatory)][int]$Port)
	$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
	return [bool]$listener
}

# Any HTTP response (including 4xx/5xx) means the server is up.
function Test-LhServerResponds {
	param([Parameter(Mandatory)][string]$Url)
	try {
		Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 | Out-Null
		return $true
	} catch [System.Net.WebException] {
		return ($null -ne $_.Exception.Response)
	} catch {
		return $false
	}
}

function New-LhClone {
	param([Parameter(Mandatory)]$Config)
	if (Test-Path -LiteralPath (Join-Path $Config.AppDir '.git')) { return }
	if ((Test-Path -LiteralPath $Config.AppDir) -and (Get-ChildItem -LiteralPath $Config.AppDir -Force | Select-Object -First 1)) {
		throw "$($Config.AppDir) exists and is not a git clone; move it away or pass -AppDir"
	}
	Write-LhStep "Cloning $($Config.RepoUrl) ($($Config.Branch)) into $($Config.AppDir)"
	$parent = Split-Path -Parent $Config.AppDir
	New-Item -ItemType Directory -Force -Path $parent | Out-Null
	Invoke-LhNative git @('clone', '--branch', $Config.Branch, $Config.RepoUrl, $Config.AppDir)
}

# Fast-forwards the clone to origin/<branch>. Skips (with a warning) when the
# network is down, the clone is on another branch, or tracked files changed.
function Update-LhSource {
	param([Parameter(Mandatory)]$Config)
	& git fetch --quiet origin $Config.Branch | Out-Host
	if ($LASTEXITCODE -ne 0) {
		Write-LhWarn 'git fetch failed (offline?); starting the current build'
		return
	}
	$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
	if ($branch -ne $Config.Branch) {
		Write-LhWarn "The clone is on '$branch', not '$($Config.Branch)'; skipping the update"
		return
	}
	# next build rewrites this tracked file on every build; the launcher owns
	# the clone, so drop that change before checking for real edits.
	& git checkout --quiet -- next-env.d.ts | Out-Host
	$dirty = & git status --porcelain --untracked-files=no
	if ($dirty) {
		Write-LhWarn 'The clone has uncommitted changes; skipping the update'
		return
	}
	& git merge --ff-only --quiet "origin/$($Config.Branch)" | Out-Host
	if ($LASTEXITCODE -ne 0) {
		Write-LhWarn "Cannot fast-forward to origin/$($Config.Branch); skipping the update"
	}
}

# One hash over the root lockfile and every source plugin's lockfile.
function Get-LhLockHash {
	param([Parameter(Mandatory)]$Config)
	$locks = @(Join-Path $Config.AppDir 'package-lock.json')
	$locks += Get-ChildItem -Path (Join-Path $Config.AppDir 'plugins\*\package-lock.json') -ErrorAction SilentlyContinue |
		Sort-Object FullName | ForEach-Object { $_.FullName }
	$lines = $locks | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
	$bytes = [System.Text.Encoding]::ASCII.GetBytes(($lines -join "`n"))
	$sha = [System.Security.Cryptography.SHA256]::Create()
	try { return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
	finally { $sha.Dispose() }
}

# Same steps as CI: npm ci, then the source plugins' dependencies.
function Update-LhDependencies {
	param([Parameter(Mandatory)]$Config)
	$lockHash = Get-LhLockHash $Config
	$nodeModules = Join-Path $Config.AppDir 'node_modules'
	if ((Test-Path -LiteralPath $nodeModules) -and ((Read-LhMarker $Config.DepsMarker) -eq $lockHash)) { return }
	Write-LhStep 'Installing dependencies (npm ci, plugins:setup)'
	Invoke-LhNative npm @('ci', '--no-audit', '--no-fund')
	Invoke-LhNative npm @('run', 'plugins:setup')
	Write-LhMarker $Config.DepsMarker $lockHash
}

function Update-LhBuild {
	param([Parameter(Mandatory)]$Config)
	$head = (& git rev-parse HEAD).Trim()
	if ((Test-Path -LiteralPath $Config.ServerJs) -and ((Read-LhMarker $Config.BuildMarker) -eq $head)) { return }
	Write-LhStep "Building $($head.Substring(0, 8)) (next build; this takes a few minutes)"
	# Empty stdin (not a TTY) keeps next build from showing its interactive
	# upgrade menu, which would edit package.json and stop the fast-forward.
	$null | npm run build | Out-Host
	if ($LASTEXITCODE -ne 0) { throw "npm run build exited with code $LASTEXITCODE" }
	Invoke-LhNative node @('scripts/build-server.mjs')
	Write-LhMarker $Config.BuildMarker $head
}

# Clone if needed, follow origin/main, and rebuild when HEAD changed.
function Update-LhApp {
	param([Parameter(Mandatory)]$Config)
	New-LhClone $Config
	Push-Location -LiteralPath $Config.AppDir
	try {
		Update-LhSource $Config
		Update-LhDependencies $Config
		Update-LhBuild $Config
	} finally {
		Pop-Location
	}
}

# Starts the standalone server attached to this console and waits until it
# answers. Returns the node process.
function Start-LhServer {
	param([Parameter(Mandatory)]$Config, [int]$TimeoutSeconds = 120)
	New-Item -ItemType Directory -Force -Path $Config.DataDir | Out-Null
	$env:PORT = [string]$Config.Port
	$env:HOSTNAME = '127.0.0.1'
	$env:NODE_ENV = 'production'
	$env:LH_DATA_DIR = $Config.DataDir
	$env:LH_AUTH_FILE = $Config.AuthFile
	Write-LhStep "Starting the server on $($Config.Url)"
	$standalone = Split-Path -Parent $Config.ServerJs
	$proc = Start-Process -FilePath 'node' -ArgumentList @('server.js') -WorkingDirectory $standalone -NoNewWindow -PassThru
	$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
	while (-not (Test-LhServerResponds $Config.Url)) {
		if ($proc.HasExited) { throw "The server exited with code $($proc.ExitCode)" }
		if ((Get-Date) -gt $deadline) {
			Stop-LhServer $proc
			throw "The server did not answer within $TimeoutSeconds seconds"
		}
		Start-Sleep -Milliseconds 500
	}
	return $proc
}

function Stop-LhServer {
	param($Process)
	if ($null -eq $Process -or $Process.HasExited) { return }
	Write-LhStep 'Stopping the server'
	& taskkill.exe /PID $Process.Id /T /F | Out-Null
}

# Updates and starts the server unless one already listens on the port.
# Returns the node process this call started, or $null when it reused one.
function Initialize-LhServer {
	param([Parameter(Mandatory)]$Config)
	if (Test-LhPortListening $Config.Port) {
		Write-LhStep "A server already listens on port $($Config.Port); using it without updating"
		return $null
	}
	Update-LhApp $Config
	return Start-LhServer $Config
}

Add-Type -Namespace LhLauncher -Name Console -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@

# 0 = hide, 6 = minimize.
function Set-LhConsoleWindow {
	param([Parameter(Mandatory)][ValidateSet('Hide', 'Minimize')][string]$State)
	$code = if ($State -eq 'Hide') { 0 } else { 6 }
	[LhLauncher.Console]::ShowWindow([LhLauncher.Console]::GetConsoleWindow(), $code) | Out-Null
}

# Keeps the console open on failure so the error can be read.
function Invoke-LhLauncher {
	param([Parameter(Mandatory)][scriptblock]$Body)
	try {
		& $Body
	} catch {
		Write-Host ''
		Write-Host "[learnharness] $($_.Exception.Message)" -ForegroundColor Red
		Read-Host 'Press Enter to close'
		exit 1
	}
}
