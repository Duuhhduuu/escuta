#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

[ -x .venv/bin/python ] || { echo "Rode ./setup.sh primeiro."; exit 1; }

# Optional local settings (GEMINI_API_KEY, GEMINI_MODEL). See .env.example.
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

exec .venv/bin/python server.py
