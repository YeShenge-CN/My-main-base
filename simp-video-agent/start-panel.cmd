@echo off
rem ---------------------------------------------------------------
rem  Simp Video Agent - double-click launcher (Windows)
rem
rem  What it does:
rem    1. cd to this script's folder (works from any location)
rem    2. build the bundles on the very first run
rem    3. start the panel server (which also opens Chrome)
rem
rem  Optional argument: path to a project/document json.
rem    start-panel.cmd out\showcase.json
rem
rem  NOTE: this file is intentionally ASCII-only. cmd.exe reads the
rem  file with the *current* code page; mixing Chinese text in here
rem  is a reliable way to get garbled output. The Chinese UI text
rem  comes from node, after 'chcp 65001' below.
rem ---------------------------------------------------------------
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"

title Simp Video Agent
echo ===============================================
echo   Simp Video Agent
echo   folder: %CD%
echo ===============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node.js 20 or newer, then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "packages\agent-tools\dist\serve-panel.mjs" (
  echo [setup] First run: installing dependencies and building bundles...
  call pnpm install || goto :failed
  call pnpm --filter @sva/agent-tools build:cli || goto :failed
  echo [setup] done.
  echo.
)

set "DOC=%~1"
if "%DOC%"=="" set "DOC=out\showcase.json"
if not exist "%DOC%" (
  echo [warn] document not found: %DOC%
  echo        falling back to out\panel-demo.json
  set "DOC=out\panel-demo.json"
)

echo [run] document: %DOC%
echo [run] the browser should open by itself. Keep this window open;
echo       closing it stops the server.
echo.
node "packages\agent-tools\dist\serve-panel.mjs" --doc "%DOC%"

echo.
echo [stop] server exited.
pause
exit /b 0

:failed
echo.
echo [ERROR] setup failed. Read the messages above.
pause
exit /b 1
