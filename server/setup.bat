@echo off
REM One-time setup no Windows: venv + faster-whisper. Os pesos baixam na primeira transcricao.
setlocal
cd /d "%~dp0"

where py >nul 2>&1 && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>&1 || (echo Python 3 nao encontrado. Instale em https://python.org e marque "Add to PATH". & exit /b 1)

%PY% -m venv .venv || exit /b 1
.venv\Scripts\python -m pip install --quiet --upgrade pip || exit /b 1
.venv\Scripts\python -m pip install --quiet faster-whisper || exit /b 1

REM Com placa NVIDIA: cuBLAS/cuDNN vem por pip, nao estao no PATH do Windows.
REM Sem eles o ctranslate2 enxerga a GPU mas quebra na hora de calcular.
where nvidia-smi >nul 2>&1
if errorlevel 1 goto :sem_gpu
echo Placa NVIDIA encontrada. Instalando cuBLAS/cuDNN (uns 700 MB)...
.venv\Scripts\python -m pip install --quiet nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
if errorlevel 1 echo Aviso: nao instalou as libs CUDA. A transcricao vai usar a CPU.
:sem_gpu

echo Pronto. Inicie com: start.bat
