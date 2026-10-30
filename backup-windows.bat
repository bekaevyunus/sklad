@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist backups mkdir backups
set D=%date:~-4%-%date:~3,2%-%date:~0,2%
copy /y "data\sklad.db" "backups\sklad-%D%.db" >nul
if errorlevel 1 (echo Не удалось сделать копию.) else (echo Копия сохранена: backups\sklad-%D%.db)
echo Скопируйте папку backups на флешку или в облако.
pause
