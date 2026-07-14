@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PID_FILE=%CD%\.tws-audio-relay.pid"
set "OUT_LOG=%CD%\.tws-audio-relay.out.log"
set "ERR_LOG=%CD%\.tws-audio-relay.err.log"
set "PORT=4312"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 18+ and try again.
  exit /b 1
)

if not exist "node_modules\qrcode" (
  echo Installing dependencies...
  where pnpm >nul 2>nul
  if not errorlevel 1 (
    call pnpm install || exit /b 1
  ) else (
    where corepack >nul 2>nul
    if not errorlevel 1 (
      call corepack pnpm install || exit /b 1
    ) else (
      where npm >nul 2>nul
      if not errorlevel 1 (
        call npm install || exit /b 1
      ) else (
        echo [ERROR] pnpm, corepack or npm was not found.
        exit /b 1
      )
    )
  )
)

if exist "%PID_FILE%" (
  set /p EXISTING_PID=<"%PID_FILE%"
  powershell -NoProfile -Command "try { Get-Process -Id %EXISTING_PID% -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }"
  if not errorlevel 1 (
    echo TWS Audio Relay is already running.
    start "" "http://localhost:%PORT%"
    exit /b 0
  )
  del "%PID_FILE%" >nul 2>nul
)

echo Starting TWS Audio Relay...
for /f %%I in ('powershell -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory '.' -RedirectStandardOutput '.tws-audio-relay.out.log' -RedirectStandardError '.tws-audio-relay.err.log' -PassThru; $p.Id"') do set "SERVER_PID=%%I"

if not defined SERVER_PID (
  echo [ERROR] Failed to start the server.
  exit /b 1
)

> "%PID_FILE%" echo %SERVER_PID%

powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(15); while((Get-Date)-lt $deadline){ try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%PORT%/health' | Out-Null; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if errorlevel 1 (
  echo [ERROR] Server did not become ready.
  echo Logs: %OUT_LOG% and %ERR_LOG%
  exit /b 1
)

start "" "http://localhost:%PORT%"

echo.
echo Server is ready.
echo Computer: http://localhost:%PORT%
echo iPhone:   open the QR code from the page or the local Wi-Fi address shown there
echo Logs:     %OUT_LOG% and %ERR_LOG%
echo.
exit /b 0
