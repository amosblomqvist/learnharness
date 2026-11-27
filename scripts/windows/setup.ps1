# One-time setup for the Windows launchers:
#   1. clone origin/main into -AppDir (default %USERPROFILE%\apps\learnharness)
#   2. build the Pake window (needs Rust and Visual Studio Build Tools)
#   3. create "LearnHarness Fork" and "LearnHarness Fork (Web)" shortcuts on
#      the desktop and in the Start menu
#
# The shortcuts run the launchers inside -ScriptsDir (default: the clone's
# scripts\windows), so pulling origin/main also updates the launchers.
# Rerun with -RebuildPake after changing -Port.
param(
	[string]$AppDir = (Join-Path $env:USERPROFILE 'apps\learnharness'),
	[int]$Port = 3010,
	[string]$ScriptsDir = '',
	[switch]$RebuildPake
)

. (Join-Path $PSScriptRoot 'lh-common.ps1')

$config = Get-LhConfig -AppDir $AppDir -Port $Port
if (-not $ScriptsDir) { $ScriptsDir = Join-Path $config.AppDir 'scripts\windows' }

New-LhClone $config
foreach ($name in @('lh-app.ps1', 'lh-web.ps1', 'lh-common.ps1')) {
	if (-not (Test-Path -LiteralPath (Join-Path $ScriptsDir $name))) {
		throw "$ScriptsDir has no $name; pass -ScriptsDir pointing at scripts\windows"
	}
}
$icon = Join-Path $config.AppDir 'build\icon.ico'

if ($RebuildPake -or -not (Test-Path -LiteralPath $config.PakeExe)) {
	if (-not (Get-Command pake -ErrorAction SilentlyContinue)) {
		Write-LhStep 'Installing pake-cli (npm install -g)'
		Invoke-LhNative npm @('install', '-g', 'pake-cli', '--no-audit', '--no-fund')
	}
	$work = Join-Path ([System.IO.Path]::GetTempPath()) ("lh-pake-" + [guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Force -Path $work | Out-Null
	Push-Location -LiteralPath $work
	try {
		Write-LhStep "Building the Pake window for $($config.Url) (the first Rust build takes several minutes)"
		Invoke-LhNative pake @(
			$config.Url,
			'--name', 'LearnHarnessFork',
			'--title', 'LearnHarness Fork',
			'--identifier', 'com.reeschan.learnharness.pake',
			'--icon', $icon,
			'--width', '1280', '--height', '860',
			'--no-restore-last-url',
			'--enable-find',
			'--keep-binary'
		)
		# --keep-binary writes the raw exe next to the .msi; the .msi is not used.
		$exe = Get-ChildItem -LiteralPath $work -Recurse -Filter '*.exe' | Select-Object -First 1
		if ($null -eq $exe) { throw "pake produced no .exe under $work" }
		New-Item -ItemType Directory -Force -Path $config.PakeDir | Out-Null
		Copy-Item -LiteralPath $exe.FullName -Destination $config.PakeExe -Force
		Write-LhStep "Installed $($config.PakeExe)"
	} finally {
		Pop-Location
		Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
	}
}

function New-LhShortcut {
	param([string]$Path, [string]$Script, [string]$Description)
	$shell = New-Object -ComObject WScript.Shell
	$link = $shell.CreateShortcut($Path)
	$link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
	$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Script`" -AppDir `"$($config.AppDir)`" -Port $($config.Port)"
	$link.WorkingDirectory = $config.AppDir
	$link.IconLocation = "$icon,0"
	$link.Description = $Description
	$link.Save()
	Write-LhStep "Created $Path"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'LearnHarness Fork'
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
foreach ($dir in @($desktop, $startMenu)) {
	New-LhShortcut (Join-Path $dir 'LearnHarness Fork.lnk') (Join-Path $ScriptsDir 'lh-app.ps1') 'Update to origin/main and open LearnHarness in its own window'
	New-LhShortcut (Join-Path $dir 'LearnHarness Fork (Web).lnk') (Join-Path $ScriptsDir 'lh-web.ps1') 'Update to origin/main and open LearnHarness in the browser'
}
Write-LhStep 'Done. The first launch runs npm ci and next build, which takes a few minutes.'
