@echo off
pushd "%~dp0.."
node scripts\update.mjs %*
if errorlevel 1 (
  echo.
  echo [update] Stopped with exit code %ERRORLEVEL%.
  pause
  exit /b %ERRORLEVEL%
)
echo.
echo [update] Completed. Please disable and re-enable Gemini-chan Sidecar in Antigravity.
pause
