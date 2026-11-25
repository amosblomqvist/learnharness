if (!('LearnHarness.WindowsLaunchers' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-launcher-interop.cs')
}

function Register-LearnHarnessWindowsLaunchers(
    [string]$Bootstrap,
    [string]$StartupDirectory,
    [Microsoft.Win32.RegistryKey]$EnvironmentKey
) {
    $marker = 'LearnHarness source checkout launcher'
    $binDirectory = Join-Path $env:LOCALAPPDATA 'LearnHarness\bin'
    $shim = Join-Path $BinDirectory 'learn.cmd'
    $shimScript = Join-Path $BinDirectory 'launch-checkout.ps1'
    $shortcutPath = Join-Path $StartupDirectory 'LearnHarness.lnk'
    $shortcutExists = Test-Path -LiteralPath $shortcutPath
    if ($shortcutExists -and [LearnHarness.WindowsLaunchers]::ReadShortcutDescription($shortcutPath) -ne $marker) {
        throw "A different startup shortcut already uses $shortcutPath."
    }
    foreach ($file in @($shim, $shimScript)) {
        if ((Test-Path -LiteralPath $file) -and -not [IO.File]::ReadAllText($file).Contains($marker)) {
            throw "A different launcher already uses $file."
        }
    }

    [void][IO.Directory]::CreateDirectory($BinDirectory)
    # Keep the checkout path out of the batch file so cmd's code page cannot change it.
    $escapedBootstrap = $Bootstrap.Replace("'", "''")
    $shimScriptContents = @"
# $marker
& '$escapedBootstrap'
exit `$LASTEXITCODE
"@
    if (!(Test-Path -LiteralPath $shimScript) -or [IO.File]::ReadAllText($shimScript) -cne $shimScriptContents) {
        [IO.File]::WriteAllText($shimScript, $shimScriptContents, [Text.Encoding]::UTF8)
    }
    $shimContents = @'
@echo off
rem LearnHarness source checkout launcher
setlocal EnableExtensions DisableDelayedExpansion
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-checkout.ps1"
exit /b %errorlevel%
'@
    if (!(Test-Path -LiteralPath $shim) -or [IO.File]::ReadAllText($shim) -cne $shimContents) {
        [IO.File]::WriteAllText($shim, $shimContents, [Text.Encoding]::ASCII)
    }

    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& (Join-Path $env:LOCALAPPDATA ''LearnHarness\bin\launch-checkout.ps1''); exit $LASTEXITCODE"'
    # The shortcut stays the same when the checkout moves. Windows owns its enabled state.
    if (!$shortcutExists) {
        [LearnHarness.WindowsLaunchers]::CreateShortcut($shortcutPath, $powerShell, $arguments, $marker)
    }

    # Keep the original registry value type and any unexpanded variables it contains.
    $userPath = $EnvironmentKey.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $pathKind = if ($null -eq $userPath) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $EnvironmentKey.GetValueKind('Path') }
    foreach ($entry in ([string]$userPath -split ';')) {
        $directory = $entry.Trim().Trim('"')
        if ($pathKind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) {
            $directory = [Environment]::ExpandEnvironmentVariables($directory)
        }
        if ($directory.TrimEnd('\', '/') -eq $BinDirectory.TrimEnd('\', '/')) { return $false }
    }
    $separator = if ($userPath -and !$userPath.EndsWith(';')) { ';' } else { '' }
    $EnvironmentKey.SetValue('Path', "$userPath$separator$BinDirectory", $pathKind)
    return $true
}
