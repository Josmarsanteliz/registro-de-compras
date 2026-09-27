@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Registro de Compras
set "LOG=%USERPROFILE%\Desktop\registro-compras-launch.log"
echo [%date% %time%] intento de inicio desde doble clic >> "%LOG%"
if not exist "node_modules\electron\dist\electron.exe" goto needinstall
"%~dp0node_modules\electron\dist\electron.exe" .
set "CODE=%errorlevel%"
echo [%date% %time%] electron termino con codigo %CODE% >> "%LOG%"
exit /b %CODE%
:needinstall
echo [%date% %time%] FALTA node_modules\electron >> "%LOG%"
echo.
echo   Falta la instalacion de Electron. Ejecuta esto una sola vez:
echo     npm.cmd install
echo.
pause
exit /b 1