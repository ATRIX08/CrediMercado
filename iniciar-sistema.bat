@echo off
cd /d "%~dp0backend"
start "" cmd /c "timeout /t 2 /nobreak >nul && start "" http://127.0.0.1:3000"
echo CrediMercado iniciando...
echo.
echo Quando aparecer "CrediMercado rodando", acesse:
echo http://127.0.0.1:3000
echo.
echo Deixe esta janela aberta enquanto usa o sistema.
echo.
npm start
pause
