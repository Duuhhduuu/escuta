#!/usr/bin/env bash
# One-time setup: Python venv + mlx-whisper. Model weights download on first use.
set -euo pipefail
cd "$(dirname "$0")"

command -v ffmpeg >/dev/null || { echo "ffmpeg não encontrado. Rode: brew install ffmpeg"; exit 1; }

python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet mlx-whisper
echo "Pronto. Inicie com: ./start.sh"
