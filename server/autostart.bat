@echo off
REM Liga ou desliga o Escuta no login do Windows (pasta Inicializar).
REM   autostart.bat            instala
REM   autostart.bat /remover   desinstala
setlocal
set "ALVO=%~dp0.venv\Scripts\pythonw.exe"
set "ARGS=server.py"
set "PASTA=%~dp0"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Escuta.lnk"

if /i "%~1"=="/remover" goto :remover

if not exist "%ALVO%" (echo Rode setup.bat primeiro. & exit /b 1)

powershell -NoProfile -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "$s = $w.CreateShortcut($env:LNK);" ^
  "$s.TargetPath = $env:ALVO;" ^
  "$s.Arguments = $env:ARGS;" ^
  "$s.WorkingDirectory = $env:PASTA;" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'Servidor local do Escuta';" ^
  "$s.Save()"
if errorlevel 1 (echo Nao consegui criar o atalho. & exit /b 1)
echo Instalado. O servidor sobe sozinho a cada login, sem janela.
echo O log fica em: %~dp0escuta.log
echo Para desfazer: autostart.bat /remover
exit /b 0

:remover
if exist "%LNK%" (del "%LNK%" & echo Removido. O servidor nao sobe mais sozinho.) else (echo Nao estava instalado.)
exit /b 0
