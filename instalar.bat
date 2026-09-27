@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Instalar Registro de Compras
color 0F

set "REPO=Josmarsanteliz/registro-de-compras"
set "ARCHIVO=Registro-de-Compras-Setup.exe"
set "URL=https://github.com/%REPO%/releases/latest/download/%ARCHIVO%"
set "DEST=%~dp0release\%ARCHIVO%"

echo.
echo   ==============================================
echo    Registro de Compras - Instalador
echo   ==============================================
echo.

if exist "%DEST%" goto yaesta

echo   1 de 2  Descargando la version mas reciente...
echo.
if not exist "%~dp0release" mkdir "%~dp0release"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri '%URL%' -OutFile '%DEST%' -UseBasicParsing; exit 0 } catch { Write-Host ('   Fallo: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"

if errorlevel 1 goto fallo
if not exist "%DEST%" goto fallo

:yaesta
if exist "%DEST%" for %%A in ("%DEST%") do set "PESO=%%~zA"
echo.
echo   Descarga lista (%%PESO%% bytes).
echo.
echo   2 de 2  Abriendo el instalador...
echo.
start "" "%DEST%"
echo   Se abrio el asistente de instalacion.
echo   - Elige la carpeta (o deja la que viene por defecto).
echo   - No necesitas permisos de administrador.
echo   - Tus datos quedan en %%APPDATA%%\Registro de Compras y NO se borran al desinstalar.
echo.
timeout /t 8 >nul
echo   Si se cerro sin instalar, puedes ejecutarlo otra vez desde:
echo     %DEST%
echo.
pause
exit /b 0

:fallo
echo.
echo   ==============================================
echo    No se pudo descargar el instalador
echo   ==============================================
echo.
echo   Que podés hacer:
echo.
echo   A) Copiar a mano el archivo "%ARCHIVO%" en esta carpeta
echo      y ejecutarlo. Lo bajás de:
echo        https://github.com/%REPO%/releases
echo.
echo   B) Si el repositorio es privado, GitHub no deja descargar sin
echo      iniciar sesion. Abrí esa pagina desde un navegador donde
echo      hayas iniciado sesion en GitHub.
echo.
echo   C) Si querés compilarlo desde el codigo, en esta carpeta:
echo        npm.cmd install
echo        npm.cmd run dist
echo.
pause
exit /b 1
