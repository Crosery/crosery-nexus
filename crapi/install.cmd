@echo off
rem crapi installer for cmd.exe (double-click also works).
rem   install.cmd            install, then enter the interactive setup
rem   install.cmd sk-xxx     install and configure with this API key
rem Pure ASCII on purpose: cmd.exe reads .cmd files in the OEM code page.
setlocal
if not "%~1"=="" set "CRAPI_KEY=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='%CRAPI_PS1_URL%'; if (-not $u) { $u='https://cdn.crosery.com/crapi/install.ps1'; try { (irm https://cdn.crosery.com/crapi/VERSION -TimeoutSec 2 | Out-Null) } catch { $u='https://ghfast.top/https://raw.githubusercontent.com/crosery/crapi/main/install.ps1' } }; irm $u | iex"
echo.
pause
endlocal
