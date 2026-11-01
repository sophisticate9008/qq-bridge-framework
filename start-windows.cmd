@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24.12 or newer from https://nodejs.org/
  pause
  exit /b 1
)
node dist\scripts\windows-launcher.js
set "QQBRIDGE_LAUNCH_RESULT=%ERRORLEVEL%"
if not "%QQBRIDGE_LAUNCH_RESULT%"=="0" pause
exit /b %QQBRIDGE_LAUNCH_RESULT%
