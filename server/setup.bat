@echo off
REM One-time setup no Windows: venv + faster-whisper. Os pesos baixam na primeira transcricao.
REM Pode rodar de novo a vontade: pula tudo que ja estiver instalado.
setlocal
cd /d "%~dp0"

if exist .venv\Scripts\python.exe goto :venv_ok
where py >nul 2>&1 && (set PY=py -3) || (set PY=python)
REM O instalador (Setup.exe) passa o Python que ele mesmo achou ou instalou.
if defined ESCUTA_PY set PY=%ESCUTA_PY%
%PY% --version >nul 2>&1 || (echo Python 3 nao encontrado. Instale em https://python.org e marque "Add to PATH". & exit /b 1)
echo    Criando o ambiente Python...
%PY% -m venv .venv || exit /b 1
.venv\Scripts\python -m pip install --quiet --upgrade pip || exit /b 1
goto :venv_fim
:venv_ok
echo    Ambiente Python ja existe.
:venv_fim

.venv\Scripts\python -m pip show faster-whisper >nul 2>&1
if not errorlevel 1 goto :fw_ok
echo    Instalando o faster-whisper...
.venv\Scripts\python -m pip install --quiet faster-whisper || exit /b 1
goto :fw_fim
:fw_ok
echo    faster-whisper ja instalado.
:fw_fim

REM Com placa NVIDIA: cuBLAS/cuDNN vem por pip, nao estao no PATH do Windows.
REM Sem eles o ctranslate2 enxerga a GPU mas quebra na hora de calcular.
where nvidia-smi >nul 2>&1
if errorlevel 1 goto :sem_placa
.venv\Scripts\python -m pip show nvidia-cublas-cu12 >nul 2>&1
if not errorlevel 1 goto :cuda_ok
echo    Placa NVIDIA encontrada. Instalando cuBLAS/cuDNN (uns 700 MB)...
.venv\Scripts\python -m pip install --quiet nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
if errorlevel 1 echo    Aviso: nao instalou as libs CUDA. A transcricao vai usar a CPU.
goto :sem_gpu
:cuda_ok
echo    Bibliotecas CUDA ja instaladas.
goto :sem_gpu

:sem_placa
echo    Nenhuma placa NVIDIA encontrada. A transcricao vai rodar no processador.
echo    Funciona, mas e mais lento: nesse caso a extensao ja escolhe sozinha
echo    um modelo mais leve (Small), umas 2,5x mais rapido que o Turbo na CPU.
:sem_gpu

echo    Pronto. Inicie com: start.bat
