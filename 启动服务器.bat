@echo off
title 激流勇进 - 局域网主机
cd /d "%~dp0"

rem Workaround: esbuild writes temp files into %TEMP% and deletes them at the end.
rem Antivirus may lock those files -> "remove ...esbuild-xxx: Access is denied" build failure.
rem Redirect temp dir into the project folder so builds never touch the system TEMP.
set "TMP=%~dp0.tmp_build"
set "TEMP=%~dp0.tmp_build"
if not exist "%TMP%" mkdir "%TMP%"

echo ========================================
echo   正在构建并启动激流勇进服务器...
echo ========================================

rem 构建最新代码
call npm run build
if errorlevel 1 (
    echo.
    echo [错误] 构建失败，请检查代码或 node_modules
    pause
    exit /b 1
)

echo.
echo 构建完成，启动服务器...
echo.
node server/server.js

echo.
echo 服务器已停止。
pause
