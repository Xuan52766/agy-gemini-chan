@echo off
pushd "%~dp0.."
node scripts\setup-sidecar.mjs %*
if errorlevel 1 (
  echo.
  echo [setup] Failed with exit code %ERRORLEVEL%.
  pause
  exit /b %ERRORLEVEL%
)
echo.
echo [setup] Done. You can open this folder in Antigravity 2.0 now.
pause
