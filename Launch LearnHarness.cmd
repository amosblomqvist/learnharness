@echo off
setlocal EnableExtensions DisableDelayedExpansion
title LearnHarness
pushd "%~dp0"
if errorlevel 1 goto directory_error

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0workspace\scripts\bootstrap-windows.ps1"
set "launcher_exit=%errorlevel%"
if not "%launcher_exit%"=="0" (
    echo.
    echo LearnHarness could not finish successfully. See the error above.
    pause
)
popd
exit /b %launcher_exit%

:directory_error
echo Could not open the LearnHarness folder.
pause
exit /b 1

