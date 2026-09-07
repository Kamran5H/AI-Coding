@echo off
title AI Coding App
cd /d "%~dp0"

if not exist node_modules (
  echo First run - installing dependencies...
  call npm install
)

echo.
echo   Starting AI Coding App...
echo   Opening http://localhost:8787 in your browser.
echo   Keep this window open while you use the app. Close it to stop.
echo.

rem open the browser a moment after the server boots
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8787"

node server.js
pause
