@echo off
setlocal EnableExtensions
title tws-audio-relay launcher

call :main
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Script finished with code %EXIT_CODE%.
  echo Press any key to close this window.
  pause >nul
)
exit /b %EXIT_CODE%

:main
cd /d "%~dp0"

set "PID_FILE=%CD%\.tws-audio-relay.pid"
set "OUT_LOG=%CD%\.tws-audio-relay.out.log"
set "ERR_LOG=%CD%\.tws-audio-relay.err.log"
set "PORT=4312"
set "NODE_EXE="

if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin" (
  set "PATH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;%PATH%"
)
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback" (
  set "PATH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;%PATH%"
)
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\override" (
  set "PATH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\override;%PATH%"
)

if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
) else (
  for /f "delims=" %%I in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%I"
  )
)

if not defined NODE_EXE (
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
for /f %%I in ('powershell -NoProfile -Command "$p = Start-Process -FilePath $env:NODE_EXE -ArgumentList 'server.mjs' -WorkingDirectory $pwd.Path -RedirectStandardOutput '.tws-audio-relay.out.log' -RedirectStandardError '.tws-audio-relay.err.log' -PassThru; $p.Id"') do set "SERVER_PID=%%I"

if not defined SERVER_PID (
  echo [ERROR] Failed to start the server.
  exit /b 1
)

> "%PID_FILE%" echo %SERVER_PID%

powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(15); while((Get-Date)-lt $deadline){ try { $r = Invoke-WebRequest -UseBasicParsing ('http://127.0.0.1:%PORT%/health') -TimeoutSec 3; if($r.StatusCode -eq 200){ exit 0 } } catch { Start-Sleep -Milliseconds 500 }; try { Get-Process -Id %SERVER_PID% -ErrorAction Stop | Out-Null } catch { exit 2 } }; exit 1"
if errorlevel 1 (
  echo [ERROR] Server did not become ready.
  echo Logs: %OUT_LOG% and %ERR_LOG%
  powershell -NoProfile -Command "Stop-Process -Id %SERVER_PID% -Force -ErrorAction SilentlyContinue"
  del "%PID_FILE%" >nul 2>nul
  exit /b 1
)

start "" "http://localhost:%PORT%"

echo.
echo Server is ready.
echo Computer: http://localhost:%PORT%
echo iPhone:   open the QR code from the page or the local Wi-Fi address shown there
echo Logs:     %OUT_LOG% and %ERR_LOG%
echo.
echo Press any key to close this launcher. The server will keep running in the background.
pause >nul
exit /b 0
