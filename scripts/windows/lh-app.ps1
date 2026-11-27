# Opens LearnHarness in the Pake window. Follows origin/main, rebuilds when
# needed, starts the server, and stops it when the window closes (only when
# this launcher started it).
param(
	[string]$AppDir = (Join-Path $env:USERPROFILE 'apps\learnharness'),
	[int]$Port = 3010
)

. (Join-Path $PSScriptRoot 'lh-common.ps1')

Invoke-LhLauncher {
	$config = Get-LhConfig -AppDir $AppDir -Port $Port
	if (-not (Test-Path -LiteralPath $config.PakeExe)) {
		throw "$($config.PakeExe) is missing; run scripts\windows\setup.ps1 first"
	}
	$server = Initialize-LhServer $config
	try {
		Write-LhStep 'Opening the window'
		$window = Start-Process -FilePath $config.PakeExe -PassThru
		Set-LhConsoleWindow Hide
		$window.WaitForExit()
	} finally {
		Stop-LhServer $server
	}
}
