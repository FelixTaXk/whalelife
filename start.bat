@echo off
title WhaleLife
cd /d "%~dp0"
set "NODE=%~dp0runtime\node-v24.22.1-win-x64\node.exe"
if not exist "%NODE%" (
  echo Node 24 runtime missing. See README.md.
  pause
  exit /b 1
)
"%NODE%" core\index.ts
if errorlevel 1 pause
