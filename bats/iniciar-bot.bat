@echo off
title Iniciando Servidor...
echo Iniciando la aplicacion con PM2, por favor espere...

:: Navega a la carpeta raiz del proyecto (un nivel arriba del bat)
cd /d "%~dp0.."

:: Verifica si ya existe y la reinicia, si no, la arranca desde cero
cmd /c pm2 restart "bot-lopez" || cmd /c pm2 start index.js --name "bot-lopez"

echo.
echo --------------------------------------------------
echo ¡Aplicacion iniciada con exito!
echo Esta ventana se cerrara automaticamente en 3 segundos.
echo --------------------------------------------------
timeout /t 3 >nul