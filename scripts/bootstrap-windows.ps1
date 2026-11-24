# Bootstrap the Windows checkout without requiring Node, npm, or administrator access.
[CmdletBinding()]
param([switch]$InstallOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Test-NodeInstallation([string]$Directory) {
    $nodeExecutable = Join-Path $Directory 'node.exe'
    $npmCli = Join-Path $Directory 'node_modules\npm\bin\npm-cli.js'
    if (!(Test-Path -LiteralPath $nodeExecutable -PathType Leaf) -or
        !(Test-Path -LiteralPath $npmCli -PathType Leaf)) { return $false }
    try {
        $nodeVersion = & $nodeExecutable --version 2>$null
        if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v26\.\d+\.\d+$') { return $false }
        $npmVersion = & $nodeExecutable $npmCli --version 2>$null
        return ($LASTEXITCODE -eq 0 -and $npmVersion -match '^\d+\.\d+\.\d+$')
    } catch { return $false }
}

function Assert-ManagedPath([string]$Target) {
    $fullTarget = [IO.Path]::GetFullPath($Target)
    $prefix = [IO.Path]::GetFullPath($runtimeRoot).TrimEnd('\') + '\'
    if (!$fullTarget.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the LearnHarness runtime folder: $fullTarget"
    }
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
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $checksum.Groups[1].Value) {
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
        if ($hadPrevious) { Remove-Item -LiteralPath $backup -Recurse -Force }
        Write-Host "[launcher] Installed Node.js $($release.version) and npm."
    } finally {
        Assert-ManagedPath $stage
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This launcher is for Windows only.' }
    $nodeDirectory = $null
    foreach ($command in @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)) {
        $directory = Split-Path -Parent $command.Source
        if (Test-NodeInstallation $directory) { $nodeDirectory = $directory; break }
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
        if (!(Test-NodeInstallation $nodeDirectory)) { Install-NodeRuntime $architecture $nodeDirectory }
    }

    $nodeExecutable = Join-Path $nodeDirectory 'node.exe'
    $npmCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
    $env:PATH = "$nodeDirectory;$env:PATH"
    Write-Host "[launcher] Using $(& $nodeExecutable --version) with npm from $nodeDirectory"
    if ($InstallOnly) { exit 0 }
    Push-Location -LiteralPath $repoRoot
    try {
        & $nodeExecutable $npmCli run desktop:windows
        $appExit = $LASTEXITCODE
    } finally { Pop-Location }
    exit $appExit
} catch {
    Write-Host "[launcher] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '[launcher] Setup could not complete. Check your internet connection and the error above, then double-click the launcher again.'
    exit 1
}
