@echo off
title WhaleLife
cd /d "%~dp0"
set "NODE=%~dp0runtime\node-v24.22.1-win-x64\node.exe"
if not exist "%NODE%" (
  set "NODE=node"
)
"%NODE%" -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)" >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 or later, then run npm ci. See README.md.
  pause
  exit /b 1
)
"%NODE%" core\index.ts
if errorlevel 1 pause
