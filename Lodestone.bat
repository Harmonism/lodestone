@echo off
rem ---------------------------------------------------------------------------
rem Lodestone - double-click this file.
rem
rem It starts a model on this computer and opens Lodestone in your browser. The first
rem run downloads a model (several gigabytes, once). After that it takes seconds.
rem
rem Nothing is sent anywhere. The model runs here, the articles are read from
rem this folder, and your conversations stay in the browser on the device you use.
rem
rem To stop Lodestone, close this window or press Control-C.
rem
rem The installable app (Lodestone Desktop, from harmonism.io) does all of this
rem without a console window. This folder remains for anyone who prefers it.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"
title Lodestone
cls

echo.
echo   Lodestone
echo   %CD%
echo.

rem --- 1. Python -------------------------------------------------------------
set "PY="
where python >nul 2>&1 && python -c "import sys" >nul 2>&1 && set "PY=python"
if not defined PY where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python3 >nul 2>&1 && set "PY=python3"
if not defined PY (
  echo One thing is missing: Python.
  echo.
  echo The download page is opening now. Install Python, and on the first
  echo screen of the installer tick "Add python.exe to PATH". Then
  echo double-click Lodestone again.
  start "" "https://www.python.org/downloads/windows/"
  goto :halt
)

rem --- 2. The articles -------------------------------------------------------
if not exist "app\corpus\corpus.json" (
  echo The articles are missing from this folder.
  echo.
  echo This copy of Lodestone is incomplete. Download it again from
  echo harmonism.io and unzip the whole folder before opening this file.
  goto :halt
)

rem --- 3. Ollama -------------------------------------------------------------
set "OLLAMA="
where ollama >nul 2>&1 && set "OLLAMA=ollama"
if not defined OLLAMA if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not defined OLLAMA (
  echo One thing is missing: Ollama.
  echo Ollama is the free program that runs the model on this computer.
  echo.
  echo The download page is opening now. Install it the ordinary way, then
  echo double-click Lodestone again.
  start "" "https://ollama.com/download"
  goto :halt
)

call :ping_ollama
if errorlevel 1 (
  echo Starting Ollama...
  if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
    start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
  ) else (
    start "" /min "%OLLAMA%" serve
  )
  for /l %%i in (1,1,30) do (
    timeout /t 1 /nobreak >nul
    call :ping_ollama
    if not errorlevel 1 goto :ollama_up
  )
  echo Ollama would not start.
  echo Open Ollama from the Start menu, then double-click Lodestone again.
  goto :halt
)
:ollama_up

rem --- 4. The model ----------------------------------------------------------
rem Chosen by this computer's memory, the same choice Lodestone Desktop makes:
rem only models that hold the whole doctrinal backbone with the conversation
rem beside it, in Lodestone's own mode (thinking off, a 32,000-token window).
rem Under 16 GB of memory no such model fits, and this folder does not offer a
rem smaller one: a confident wrong answer in Lodestone's voice is worse than none.
rem
rem model.txt overrides the choice: put any name Ollama can pull in it.
set "Q35B=hf.co/unsloth/Qwen3.5-35B-A3B-GGUF:Q4_K_M"
set "G4=hf.co/mradermacher/gemma-4-26B-A4B-it-uncensored-heretic-GGUF:Q4_K_M"
set "M14=hf.co/mistralai/Ministral-3-14B-Instruct-2512-GGUF:Q4_K_M"

set "MEMGB="
for /f %%m in ('powershell -NoProfile -Command "[int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)" 2^>nul') do set "MEMGB=%%m"
if not defined MEMGB set "MEMGB=8"
set "AUTO="
if !MEMGB! GEQ 46 (
  set "AUTO=!Q35B!" & set "ABOUT=Qwen 3.5 35B - 22 GB"
) else if !MEMGB! GEQ 30 (
  set "AUTO=!G4!" & set "ABOUT=Gemma 4 26B, uncensored - 17 GB"
) else if !MEMGB! GEQ 15 (
  set "AUTO=!M14!" & set "ABOUT=Ministral 3 14B - 8 GB"
)

set "MODEL="
if exist "model.txt" set /p MODEL=<model.txt
if defined MODEL for /f "tokens=* delims= " %%a in ("!MODEL!") do set "MODEL=%%a"
set "REPLACE="
if not defined MODEL set "REPLACE=1"
rem The previous launcher wrote its own pick here. Those were vendor weights
rem that refuse on contested ground; they are replaced unless chosen again.
if /i "!MODEL!"=="qwen3:32b" set "REPLACE=1"
if /i "!MODEL!"=="qwen3:14b" set "REPLACE=1"
if /i "!MODEL!"=="qwen3:8b"  set "REPLACE=1"
if /i "!MODEL!"=="hf.co/mradermacher/gemma-3-12b-it-norm-preserved-biprojected-abliterated-GGUF:Q4_K_M" set "REPLACE=1"
if /i "!MODEL!"=="hf.co/mradermacher/Qwen3.5-9B-heretic-v2-GGUF:Q4_K_M" set "REPLACE=1"
if /i "!MODEL!"=="hf.co/mradermacher/gemma-4-26B-A4B-it-uncensored-heretic-GGUF:Q8_0" set "REPLACE=1"
if defined REPLACE (
  if defined MODEL echo   Replacing the earlier default ^(!MODEL!^) with a model that holds Lodestone's doctrine.
  set "MODEL=!AUTO!"
  if defined AUTO >model.txt echo !AUTO!
) else (
  set "ABOUT=!MODEL! (from model.txt)"
)
if not defined MODEL (
  echo.
  echo This computer has !MEMGB! GB of memory, and Lodestone needs 16 GB to think on it.
  echo No model small enough to fit here holds Lodestone's doctrine. Open
  echo https://harmonism.io/lodestone-app/ instead: it keeps your memory on this
  echo computer and thinks through a free harmonism.io account or your own
  echo OpenRouter key. To try a model of your own choosing anyway, put its name
  echo in model.txt and double-click Lodestone again.
  start "" "https://harmonism.io/lodestone-app/"
  goto :halt
)

set "HAVE="
for /f "tokens=1" %%h in ('"%OLLAMA%" list 2^>nul') do (
  if /i "%%h"=="!MODEL!" set "HAVE=1"
  if /i "%%h"=="!MODEL!:latest" set "HAVE=1"
)
if not defined HAVE (
  echo.
  echo Downloading the model - !ABOUT!
  echo This happens once. Leave this window open; it can take a while.
  echo.
  "%OLLAMA%" pull !MODEL!
  if errorlevel 1 (
    echo.
    echo The model could not be downloaded.
    echo Check the internet connection and double-click Lodestone again.
    echo If Ollama says it does not know this kind of model, update Ollama
    echo from ollama.com. To use a different model, put its name in model.txt.
    goto :halt
  )
)

rem --- 5. Serve it -----------------------------------------------------------
for /f %%p in ('powershell -NoProfile -Command "8765..8789 ^| Where-Object { -not (Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue) } ^| Select-Object -First 1" 2^>nul') do set "PORT=%%p"
if not defined PORT set "PORT=8765"

echo.
echo Lodestone is starting - !ABOUT!
echo Your browser will open in a moment. To use Lodestone on your phone, look for
echo the second address below and type it into the phone's browser - the phone
echo and this computer must be on the same Wi-Fi.
echo.

rem The browser opens only once the server is actually answering.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 600;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:!PORT!/ ^| Out-Null; Start-Process http://localhost:!PORT!/; break}catch{Start-Sleep 1}}"
%PY% tools\serve.py --port !PORT! --lan --model !MODEL! --check
if errorlevel 3 (
  echo.
  echo This model does not work with the Ollama on this computer.
  echo Updating Ollama from ollama.com fixes this in most cases. Otherwise,
  echo put another model's name in model.txt ^(the models Lodestone Desktop offers
echo are listed at harmonism.io/lodestone-desktop^)
  echo and double-click Lodestone again.
  start "" "https://ollama.com/download"
)

:halt
echo.
pause
exit /b

:ping_ollama
powershell -NoProfile -Command "try{ (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:11434/api/version) | Out-Null; exit 0 } catch { exit 1 }"
exit /b %errorlevel%
