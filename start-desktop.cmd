@echo off
setlocal
cd /d "%~dp0"
title RePhiEdit Next - Desktop

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer is required. https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [SETUP] Installing dependencies, please wait...
  call npm install --no-audit --no-fund
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [SETUP] Downloading Electron binary via mirror...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  pushd node_modules\electron
  node install.js
  popd
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron runtime not found in node_modules\electron\dist\electron.exe
  echo         Run this script again, or install dependencies manually:
  echo         npm install
  pause
  exit /b 1
)

echo [RUN] Launching RePhiEdit Next desktop app...
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
"node_modules\electron\dist\electron.exe" "desktop\main.cjs"
if errorlevel 1 pause
endlocal
