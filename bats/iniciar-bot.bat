@echo off
title Iniciando Servidor...
echo Iniciando la aplicacion con PM2, por favor espere...

:: Navega a la carpeta raiz del proyecto (un nivel arriba del bat)
cd /d "%~dp0.."

:: Elimina el proceso anterior (si existe) para evitar cache
cmd /c pm2 delete "bot-lopez" 2>nul
cmd /c pm2 start index.js --name "bot-lopez"

echo.
echo --------------------------------------------------
echo ¡Aplicacion iniciada con exito!
echo Esta ventana se cerrara automaticamente en 3 segundos.
echo --------------------------------------------------
timeout /t 3 >nul