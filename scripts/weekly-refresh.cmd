@echo off
REM Еженедельное автообновление данных дашборда: выгрузка из Graph API в БД (файл или Turso).
REM Запускается планировщиком Windows. Токен и настройки БД берутся из .env.local.
cd /d "C:\Users\bigva\OneDrive\Desktop\PROJECTS\meta-ads-dashboard"
echo [%date% %time%] sync... >> data\refresh.log
call node scripts\sync.mjs >> data\refresh.log 2>&1
call node scripts\sync-google.mjs >> data\refresh.log 2>&1
call node scripts\sync-yandex.mjs >> data\refresh.log 2>&1
if %errorlevel%==0 (
  echo [%date% %time%] OK >> data\refresh.log
) else (
  echo [%date% %time%] FAILED >> data\refresh.log
)
