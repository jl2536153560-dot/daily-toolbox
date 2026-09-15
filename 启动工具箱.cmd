@echo off
setlocal
cd /d "%~dp0"
set "TOOLBOX_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "TOOLBOX_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "node_modules\vite\bin\vite.js" (
  echo Dependencies are missing. Please follow README.md to install them first.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:5173/ in your browser.
echo Keep this window open. Press Ctrl+C to stop.
"%TOOLBOX_NODE%" node_modules\vite\bin\vite.js --host 127.0.0.1 --port 5173 --strictPort
if errorlevel 1 pause
