@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM Console em UTF-8: sem isso os acentos das mensagens saem trocados.
chcp 65001 >nul
set PYTHONIOENCODING=utf-8

if not exist .venv\Scripts\python.exe (echo Rode setup.bat primeiro. & exit /b 1)

REM Ajustes locais opcionais (GEMINI_API_KEY, GEMINI_MODEL, ESCUTA_DEVICE). Veja .env.example.
if exist .env (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do if not "%%b"=="" set "%%a=%%b"
)

.venv\Scripts\python server.py
