#!/usr/bin/env bash
# One-time setup: Python venv + a Whisper backend. Model weights download on first use.
set -euo pipefail
cd "$(dirname "$0")"

python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip

if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  command -v ffmpeg >/dev/null || { echo "ffmpeg não encontrado. Rode: brew install ffmpeg"; exit 1; }
  .venv/bin/pip install --quiet mlx-whisper
else
  .venv/bin/pip install --quiet faster-whisper
fi

echo "Pronto. Inicie com: ./start.sh"
