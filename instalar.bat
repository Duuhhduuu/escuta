@echo off
setlocal
title Escuta - instalacao
set "ESCUTA_PASTA=%~dp0"
set "ESCUTA_ORIGEM=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
