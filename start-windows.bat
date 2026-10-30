@echo off
chcp 65001 >nul
title Склад — сервер
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите версию LTS с https://nodejs.org и запустите этот файл снова.
  pause
  exit /b 1
)

set PORT=3000
set DATA_DIR=%~dp0data

if not exist "%DATA_DIR%\sklad.db" (
  echo Первый запуск. Создаём владельца.
  set /p ADMIN_NAME=Имя для входа [admin]:
  set /p ADMIN_PASSWORD=Придумайте пароль:
)
if "%ADMIN_NAME%"=="" set ADMIN_NAME=admin

node --disable-warning=ExperimentalWarning server.js
echo.
echo Сервер остановлен.
pause
