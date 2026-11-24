# Bootstrap the Windows checkout without requiring Node, npm, or administrator access.
[CmdletBinding()]
param([switch]$InstallOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$workspace = Split-Path -Parent $PSScriptRoot

# Returns the Node.js version when the directory holds a usable Node 26 with npm, otherwise $null.
function Test-NodeInstallation([string]$Directory) {
    $nodeExecutable = Join-Path $Directory 'node.exe'
    $npmCli = Join-Path $Directory 'node_modules\npm\bin\npm-cli.js'
    $npmManifest = Join-Path $Directory 'node_modules\npm\package.json'
    if (!(Test-Path -LiteralPath $nodeExecutable -PathType Leaf) -or
        !(Test-Path -LiteralPath $npmCli -PathType Leaf) -or
        !(Test-Path -LiteralPath $npmManifest -PathType Leaf)) { return $null }
    try {
        $nodeVersion = & $nodeExecutable --version 2>$null
        if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v26\.\d+\.\d+$') { return $null }
        # Reading npm's manifest avoids starting a second Node.js process on every launch.
        $npmVersion = (Get-Content -LiteralPath $npmManifest -Raw | ConvertFrom-Json).version
        if ($npmVersion -notmatch '^\d+\.\d+\.\d+$') { return $null }
        return $nodeVersion
    } catch { return $null }
}

function Assert-ManagedPath([string]$Target) {
    $fullTarget = [IO.Path]::GetFullPath($Target)
    $base = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
    $prefix = [IO.Path]::GetFullPath($runtimeRoot).TrimEnd('\') + '\'
    if (!$fullTarget.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase) -or
        !$fullTarget.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the LearnHarness runtime folder: $fullTarget"
    }
    for ($current = $fullTarget; $current.Length -ge $base.Length; $current = Split-Path -Parent $current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing a redirected LearnHarness runtime path: $current"
        }
    }
}

function Remove-ManagedDirectory([string]$Target) {
    Assert-ManagedPath $Target
    # Inspect one directory level at a time so enumeration never follows a junction.
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Target)
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -LiteralPath ($pending.Pop()) -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to remove a runtime directory containing a redirected path: $($item.FullName)"
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
    Remove-Item -LiteralPath $Target -Recurse -Force
}

function Install-NodeRuntime([string]$Architecture, [string]$Destination) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Write-Host '[launcher] Node.js 26 with npm is needed. Installing it for your Windows account...'
    Write-Host "[launcher] Runtime folder: $Destination"
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
    $release = $releases | Where-Object {
        $_.version -match '^v26\.\d+\.\d+$' -and $_.files -contains "win-$Architecture-zip"
    } | Sort-Object { [version]$_.version.Substring(1) } -Descending | Select-Object -First 1
    if (!$release) { throw "No official Node.js 26 Windows $Architecture ZIP release was found." }

    $archiveBase = "node-$($release.version)-win-$Architecture"
    $archiveName = "$archiveBase.zip"
    $baseUrl = "https://nodejs.org/dist/$($release.version)"
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -TimeoutSec 30).Content
    $pattern = '(?m)^([a-fA-F0-9]{64})\s+' + [regex]::Escape($archiveName) + '\r?$'
    $checksum = [regex]::Match([string]$checksums, $pattern)
    if (!$checksum.Success) { throw "The official checksum for $archiveName was not found." }

    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    $stage = Join-Path $runtimeRoot ('setup-' + [guid]::NewGuid().ToString('N'))
    Assert-ManagedPath $stage
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $archive = Join-Path $stage $archiveName
        Write-Host "[launcher] Downloading Node.js $($release.version) with npm from nodejs.org..."
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archiveName" -OutFile $archive -TimeoutSec 180
        $hasher = [Security.Cryptography.SHA256]::Create()
        $archiveStream = [IO.File]::OpenRead($archive)
        try { $actualChecksum = [BitConverter]::ToString($hasher.ComputeHash($archiveStream)).Replace('-', '') }
        finally {
            $archiveStream.Dispose()
            $hasher.Dispose()
        }
        if ($actualChecksum -ne $checksum.Groups[1].Value) {
            throw 'The Node.js download failed its SHA-256 check. Nothing was installed. Try launching again.'
        }
        $unpacked = Join-Path $stage 'unpacked'
        Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
        $candidate = Join-Path $unpacked $archiveBase
        if (!(Test-NodeInstallation $candidate)) { throw 'The downloaded Node.js/npm installation could not be verified.' }

        Assert-ManagedPath $candidate
        Assert-ManagedPath $Destination
        $backup = Join-Path $runtimeRoot ('previous-' + [guid]::NewGuid().ToString('N'))
        Assert-ManagedPath $backup
        $hadPrevious = Test-Path -LiteralPath $Destination
        if ($hadPrevious) { Move-Item -LiteralPath $Destination -Destination $backup }
        try { Move-Item -LiteralPath $candidate -Destination $Destination }
        catch {
            if ($hadPrevious) { Move-Item -LiteralPath $backup -Destination $Destination }
            throw
        }
        if ($hadPrevious) { Remove-ManagedDirectory $backup }
        Write-Host "[launcher] Installed Node.js $($release.version) and npm."
    } finally {
        Assert-ManagedPath $stage
        if (Test-Path -LiteralPath $stage) { Remove-ManagedDirectory $stage }
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This launcher is for Windows only.' }
    $nodeDirectory = $null
    foreach ($command in @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)) {
        $directory = Split-Path -Parent $command.Source
        $nodeVersion = Test-NodeInstallation $directory
        if ($nodeVersion) { $nodeDirectory = $directory; break }
    }

    if (!$nodeDirectory) {
        if (!$env:LOCALAPPDATA) { throw 'The Windows LOCALAPPDATA folder could not be found.' }
        $runtimeRoot = Join-Path $env:LOCALAPPDATA 'LearnHarness\runtime'
        $processor = $env:PROCESSOR_ARCHITEW6432
        if (!$processor) { $processor = $env:PROCESSOR_ARCHITECTURE }
        $architecture = switch ($processor) {
            'AMD64' { 'x64' }
            'ARM64' { 'arm64' }
            default { throw "Node.js 26 requires 64-bit Windows (x64 or ARM64); found $processor." }
        }
        $nodeDirectory = Join-Path $runtimeRoot "node26-$architecture"
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $mutex = [Threading.Mutex]::new($false, "Global\LearnHarness.Node26.$sid.$architecture")
        $locked = $false
        try {
            try { $locked = $mutex.WaitOne([TimeSpan]::FromMinutes(10)) }
            catch [Threading.AbandonedMutexException] { $locked = $true }
            if (!$locked) { throw 'Another LearnHarness Node.js setup is still in progress.' }
            Assert-ManagedPath $nodeDirectory
            Assert-ManagedPath (Join-Path $nodeDirectory 'node.exe')
            Assert-ManagedPath (Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js')
            Assert-ManagedPath (Join-Path $nodeDirectory 'node_modules\npm\package.json')
            $nodeVersion = Test-NodeInstallation $nodeDirectory
            if (!$nodeVersion) {
                Install-NodeRuntime $architecture $nodeDirectory
                $nodeVersion = Test-NodeInstallation $nodeDirectory
                if (!$nodeVersion) { throw 'The installed Node.js/npm runtime could not be verified.' }
            }
        } finally {
            if ($locked) { $mutex.ReleaseMutex() }
            $mutex.Dispose()
        }
    }

    $nodeExecutable = Join-Path $nodeDirectory 'node.exe'
    $npmCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
    $env:PATH = "$nodeDirectory;$env:PATH"
    Write-Host "[launcher] Using $nodeVersion with npm from $nodeDirectory"
    if ($InstallOnly) { exit 0 }
    $env:npm_execpath = $npmCli
    Push-Location -LiteralPath $workspace
    try {
        & $nodeExecutable (Join-Path $PSScriptRoot 'launch-windows-desktop.mjs')
        $appExit = $LASTEXITCODE
    } finally { Pop-Location }
    exit $appExit
} catch {
    Write-Host "[launcher] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '[launcher] Setup could not complete. Check your internet connection and the error above, then double-click the launcher again.'
    exit 1
}
