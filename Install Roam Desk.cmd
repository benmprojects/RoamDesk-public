@echo off
rem Double-click to install or update Roam Desk. Add -DesktopControl to also install screen, mouse and keyboard control.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-RoamDesk.ps1" %*
echo.
pause
