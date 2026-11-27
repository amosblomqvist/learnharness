# Opens LearnHarness in the default browser. Follows origin/main, rebuilds
# when needed, and runs the server in this console: closing the console
# stops it. When a server already runs, it only opens the browser.
param(
	[string]$AppDir = (Join-Path $env:USERPROFILE 'apps\learnharness'),
	[int]$Port = 3010
)

. (Join-Path $PSScriptRoot 'lh-common.ps1')

Invoke-LhLauncher {
	$config = Get-LhConfig -AppDir $AppDir -Port $Port
	$server = Initialize-LhServer $config
	Write-LhStep "Opening $($config.Url) in the browser"
	Start-Process $config.Url
	if ($null -eq $server) { return }
	Write-LhStep 'The server runs in this window; close it to stop the server'
	Set-LhConsoleWindow Minimize
	try {
		$server.WaitForExit()
	} finally {
		Stop-LhServer $server
	}
}
