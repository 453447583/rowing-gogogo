@echo off
title Rapid Rush - Public Host (cloudflared)
cd /d "%~dp0"

rem Same TEMP workaround as the LAN launcher: esbuild / node must not touch C:\TEMP
set "TMP=%~dp0.tmp_build"
set "TEMP=%~dp0.tmp_build"
if not exist "%TMP%" mkdir "%TMP%"

rem One process for LAN + online friends -> one leaderboard JSON file.
rem Default ports 3000/3001; change them:  node scripts/public-host.mjs --port 3000 --ws-port 3001
node scripts/public-host.mjs

echo.
echo Host stopped.
pause
