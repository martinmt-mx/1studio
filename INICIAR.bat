@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title 1Studio - Tablero de Control

echo.
echo  ==========================================
echo    1Studio - preparando todo...
echo  ==========================================
echo.

rem ================= 1. Node.js =================
where node >nul 2>nul
if errorlevel 1 goto :sin_node

rem ================= 2. Dependencias de Node =================
if exist "node_modules\express\package.json" goto :node_ok
echo [Node]    Instalando dependencias - solo la primera vez...
call npm install --no-audit --no-fund
if errorlevel 1 goto :error_npm
:node_ok
echo [Node]    OK

rem ================= 3. yt-dlp =================
if exist "yt-dlp.exe" goto :ytdlp_actualizar
echo [yt-dlp]  Descargando yt-dlp.exe desde GitHub...
curl -L --fail --silent --show-error -o "yt-dlp.exe.part" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
if errorlevel 1 goto :ytdlp_fallo
move /y "yt-dlp.exe.part" "yt-dlp.exe" >nul
echo [yt-dlp]  OK
goto :python

:ytdlp_actualizar
echo [yt-dlp]  Buscando actualizaciones...
"yt-dlp.exe" -U >nul 2>nul
echo [yt-dlp]  OK
goto :python

:ytdlp_fallo
if exist "yt-dlp.exe.part" del /q "yt-dlp.exe.part" >nul 2>nul
echo [yt-dlp]  AVISO: no se pudo descargar. El descargador de clips quedara desactivado.

rem ================= 4. Python + faster-whisper =================
:python
set "PY="
python -c "import sys" >nul 2>nul
if not errorlevel 1 set "PY=python"
if defined PY goto :py_ok
py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY goto :sin_python

:py_ok
set "STUDIO_PYTHON=%PY%"
%PY% -c "import faster_whisper" >nul 2>nul
if not errorlevel 1 goto :cuda
echo [Python]  Instalando faster-whisper - solo la primera vez, puede tardar unos minutos...
%PY% -m pip install --upgrade faster-whisper
if errorlevel 1 goto :whisper_fallo

:cuda
rem Si hay GPU NVIDIA, instala cuBLAS/cuDNN para que Whisper use CUDA
where nvidia-smi >nul 2>nul
if errorlevel 1 goto :whisper_ok
%PY% -c "import nvidia.cublas, nvidia.cudnn" >nul 2>nul
if not errorlevel 1 goto :whisper_ok
echo [Python]  GPU NVIDIA detectada: instalando librerias CUDA para Whisper - solo la primera vez...
%PY% -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
if errorlevel 1 echo [Python]  AVISO: no se pudieron instalar las librerias CUDA. Whisper usara la CPU.

:whisper_ok
echo [Python]  OK - faster-whisper listo
goto :arrancar

:whisper_fallo
echo [Python]  AVISO: no se pudo instalar faster-whisper. El analizador solo medira duracion y picos.
goto :arrancar

:sin_python
echo [Python]  AVISO: Python no esta instalado. El analizador quedara desactivado.
echo           Instalalo desde https://www.python.org marcando "Add python.exe to PATH".

rem ================= 5. Arrancar =================
:arrancar
echo.
node server.js
echo.
echo El servidor se detuvo.
pause
exit /b 0

:sin_node
echo ERROR: Node.js no esta instalado. Descargalo de https://nodejs.org y vuelve a abrir este archivo.
pause
exit /b 1

:error_npm
echo ERROR: no se pudieron instalar las dependencias de Node. Revisa tu conexion a internet.
pause
exit /b 1
