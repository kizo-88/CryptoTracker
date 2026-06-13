@echo off
title CryptoTracker Backend
cd /d "%~dp0"

echo ============================================================
echo   CryptoTracker backend  -^>  http://localhost:3000
echo   (keep this window open; close it to stop the server)
echo ============================================================
echo.

if not exist "node_modules" (
  echo Installing dependencies (first run)...
  call npm install
  echo.
)

call npm start

echo.
echo Backend stopped.
pause
