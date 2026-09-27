@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Instalar Registro de Compras
color 0F

set "REPO=Josmarsanteliz/registro-de-compras"
set "ARCHIVO=Registro-de-Compras-Setup.exe"
set "URL=https://github.com/%REPO%/releases/latest/download/%ARCHIVO%"
rem Carpeta propia: nunca reutilizamos release\ (ahi escribe el build) para no ejecutar
rem un binario viejo por accidente.
set "DESTDIR=%LOCALAPPDATA%\Registro de Compras\instalador"
set "DEST=%DESTDIR%\%ARCHIVO%"

echo.
echo   ==========================================================
echo     REGISTRO DE COMPRAS  -  Instalador
echo   ==========================================================
echo.
echo   Version: la mas reciente publicada en GitHub
echo   Destino: %DEST%
echo.

if exist "%DEST%" goto yaesta

echo   1 de 2  Descargando el instalador...
echo.
echo   Son 107 MB: esto puede tardar varios minutos.
echo   Deja esta ventana abierta hasta que diga "listo".
echo.
if not exist "%DESTDIR%" mkdir "%DESTDIR%"

curl.exe -L --fail --progress-bar -o "%DEST%" "%URL%"
if errorlevel 1 goto fallo

if not exist "%DEST%" goto fallo
rem Quita la marca de "descargado de internet" para que Windows no lo bloquee.
powershell -NoProfile -Command "Unblock-File -LiteralPath '%DEST%' -ErrorAction SilentlyContinue"

:yaesta
for %%A in ("%DEST%") do set "PESO=%%~zA"
for %%A in ("%DEST%") do set "FECHA=%%~tA"

echo.
echo   Descarga lista: %PESO% bytes
echo   Archivo: %DEST%
echo   Fecha:   %FECHA%
echo.
echo   2 de 2  Abriendo el instalador...
echo.
start "" "%DEST%"
if errorlevel 1 goto noarranco

echo   Se abrio el asistente de instalacion.
echo.
echo   - Elige la carpeta, o deja la que viene por defecto.
echo   - No necesitas permisos de administrador.
echo   - Tus datos quedan en %APPDATA%\Registro de Compras
echo     y NO se borran al desinstalar.
echo.
echo   ------------------------------------------------------------
echo   Si Windows dice "Windows protegio tu PC" / "SmartScreen":
echo     1) Clic en "Mas informacion"
echo     2) Abajo aparece "Ejecutar de todas formas"
echo     3) Clic ahi
echo   Es normal: el instalador no esta firmado. Pasa solo la
echo   primera vez.
echo   ------------------------------------------------------------
echo.
echo   Esta ventana se cierra sola en 15 segundos.
ping -n 16 127.0.0.1 >nul
echo   Para volver a instalarlo despues, ejecuta de nuevo este
echo   archivo: instalar.bat
exit /b 0

:noarranco
echo.
echo   No se pudo abrir el instalador.
echo   Ejecutalo a mano con doble clic en:
echo     %DEST%
echo.
echo   Si Windows lo bloquea, clic en "Mas informacion" y luego
echo   "Ejecutar de todas formas".
echo.
pause
exit /b 1

:fallo
echo.
echo   ==========================================================
echo     No se pudo descargar el instalador
echo   ==========================================================
echo.
echo   Que podes hacer:
echo.
echo   A) Bajar el archivo a mano. Abre esta pagina, inicia
echo      sesion en GitHub si hace falta, y descarga el .exe:
echo        https://github.com/%REPO%/releases
echo      Al abrirlo: "Mas informacion" y "Ejecutar de todas formas".
echo.
echo   B) Si estas en una maquina con internet lento o sin
echo      permisos para escribir en %LOCALAPPDATA%, descarga el
echo      .exe a mano y ejecutalo haciendo doble clic.
echo.
echo   C) Compilarlo desde el codigo (si clonaste el repo):
echo        npm.cmd install
echo        npm.cmd run dist
echo      El instalador queda en release\%ARCHIVO%
echo.
pause
exit /b 1
