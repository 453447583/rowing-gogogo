@echo off
title Rapid Rush - Home Server + Leaderboard Bridge
cd /d "%~dp0"

rem Keep esbuild / node temp files inside the project (C:/TEMP is often full)
set "TMP=%~dp0.tmp_build"
set "TEMP=%~dp0.tmp_build"
if not exist "%TMP%" mkdir "%TMP%"

rem Shared secret guarding /lb-api/*  -- must equal LEADERBOARD_TOKEN on Render.
rem Put the token on a single line in server\data\bridge-token.txt
if exist "server\data\bridge-token.txt" set /p LEADERBOARD_TOKEN=<server\data\bridge-token.txt

rem Render endpoint that receives our current cpolar URL (optional but recommended).
rem Put e.g. https://your-app.onrender.com/lb-api/register in server\data\bridge-register.txt
if exist "server\data\bridge-register.txt" set /p LB_REGISTER_URL=<server\data\bridge-register.txt

if "%LEADERBOARD_TOKEN%"=="" echo [warn] no token found - /lb-api/* stays disabled
if "%LB_REGISTER_URL%"=="" echo [warn] no register url - public address will not be pushed to Render

rem Build only when there is nothing to serve (LAN friends load these files)
if not exist "dist\index.html" (
    echo [build] dist missing, building...
    call npm run build
    if errorlevel 1 (
        echo [error] build failed - run "npm install" first
        pause
        exit /b 1
    )
)

node server\server.js

echo.
echo Server stopped.
pause
