@echo off
title Deteniendo Servidor...
echo Deteniendo la aplicacion de PM2...

cmd /c pm2 stop "bot-lopez"

echo.
echo --------------------------------------------------
echo La aplicacion se ha detenido.
echo Esta ventana se cerrara automaticamente en 3 segundos.
echo --------------------------------------------------
timeout /t 3 >nul