@echo off
REM Instalacao completa do Escuta no Windows, de uma vez so.
REM Instala o servidor, configura os resumos, liga o autostart e sobe o servidor.
setlocal
cd /d "%~dp0server"
title Escuta - instalacao

echo.
echo  =========================================
echo    Escuta - instalacao
echo  =========================================
echo.

echo  [1/4] Instalando o servidor (na primeira vez demora alguns minutos)...
call "%~dp0server\setup.bat" || goto :erro
echo.

echo  [2/4] Resumos das mensagens
if exist .env goto :env_pronto
echo.
echo    Os resumos podem usar o Gemini (nuvem) ou o Ollama (local).
echo    Chave do Gemini: https://aistudio.google.com/apikey
echo    Cole a chave e tecle Enter, ou so tecle Enter para pular.
echo.
set "CHAVE="
set /p "CHAVE=   Chave: "
if defined CHAVE (
  > .env echo GEMINI_API_KEY=%CHAVE%
  echo    Gemini configurado.
) else (
  echo    Pulado. Para resumir, instale o Ollama em ollama.com/download
)
goto :env_fim
:env_pronto
echo    Ja existe um .env configurado. Nao mexi nele.
:env_fim
echo.

echo  [3/4] Configurando para abrir sozinho toda vez que ligar o PC...
call "%~dp0server\autostart.bat" || goto :erro
echo.

echo  [4/4] Ligando o servidor agora...
start "" /D "%~dp0server" "%~dp0server\.venv\Scripts\pythonw.exe" server.py
for /l %%i in (1,1,40) do (
  curl.exe -s -m 5 http://127.0.0.1:8765/health >nul 2>&1
  if not errorlevel 1 goto :no_ar
  ping -n 2 127.0.0.1 >nul
)
echo    O servidor nao respondeu. Veja o log em: %~dp0server\escuta.log
goto :fim

:no_ar
echo    Servidor no ar.
echo.
echo  =========================================
echo    Falta so um passo, que e manual:
echo  =========================================
echo.
echo    1. No Chrome, abra:  chrome://extensions
echo    2. Ligue o "Modo do desenvolvedor" (canto superior direito)
echo    3. Clique em "Carregar sem compactacao"
echo    4. Escolha a pasta que vai abrir agora
echo.
echo    Depois disso, abra o WhatsApp Web: cada mensagem de voz
echo    ganha um botao Transcrever.
echo.
start "" explorer "%~dp0extension"
goto :fim

:erro
echo.
echo    A instalacao parou por causa do erro acima.

:fim
echo.
pause
