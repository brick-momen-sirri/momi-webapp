@echo off
setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
set "NODE_BIN=C:\Users\momen.sirri\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"

if exist "%NODE_BIN%\node.exe" (
  set "PATH=%NODE_BIN%;%PATH%"
)

if not defined NODE_OPTIONS (
  set "NODE_OPTIONS=--max-old-space-size=1024"
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js or run this from the Codex environment where the bundled Node.js exists.
  pause
  exit /b 1
)

if not exist "%ROOT%node_modules\.bin\vite.CMD" (
  echo Missing frontend dependencies.
  echo Run pnpm install or npm install in:
  echo %ROOT%
  pause
  exit /b 1
)

if not exist "%ROOT%node_modules\.bin\tsx.CMD" (
  echo Missing backend runner dependency: tsx.
  echo Run pnpm install or npm install in:
  echo %ROOT%
  pause
  exit /b 1
)

set "HOST=0.0.0.0"
set "COMFY_SERVERS="
for /l %%P in (8201,1,8220) do (
  if defined COMFY_SERVERS (
    set "COMFY_SERVERS=!COMFY_SERVERS!,http://127.0.0.1:%%P"
  ) else (
    set "COMFY_SERVERS=http://127.0.0.1:%%P"
  )
)
set "LAN_IP=YOUR-PC-IP"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1 -ExpandProperty IPAddress"`) do set "LAN_IP=%%I"

echo Starting Momi Animation web app...
echo Backend:  http://127.0.0.1:3333
echo Frontend: http://127.0.0.1:8190
echo LAN URL:  http://%LAN_IP%:8190
echo.

start "Momi Backend - 3333" /D "%ROOT%backend" cmd /k ""%ROOT%node_modules\.bin\tsx.CMD" src\index.ts"

timeout /t 2 /nobreak >nul

start "Momi Web App - 8190" /D "%ROOT%" cmd /k ""%ROOT%node_modules\.bin\vite.CMD" --host 0.0.0.0 --port 8190 --strictPort"

timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8190/"

echo Done. Keep the Backend and Web App windows open while using the app.
pause
