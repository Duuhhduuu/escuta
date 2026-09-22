#!/usr/bin/env bash
# Mac: o servidor sobe sozinho a cada login, sem Terminal aberto, e volta se cair.
# O log vai para server/escuta.log. Para desfazer: ./autostart.sh --remover
set -euo pipefail
cd "$(dirname "$0")"

LABEL=com.escuta.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

stop() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # bootout volta antes do processo sair; bootstrap em cima dele falha.
  for _ in $(seq 50); do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
}

if [ "${1:-}" = "--remover" ]; then
  stop
  rm -f "$PLIST"
  echo "Autostart removido. O servidor foi desligado."
  exit 0
fi

[ -x .venv/bin/python ] || { echo "Rode ./setup.sh primeiro."; exit 1; }
FFMPEG="$(command -v ffmpeg || true)"
[ -n "$FFMPEG" ] || { echo "ffmpeg não encontrado. Rode: brew install ffmpeg"; exit 1; }

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
HERE="$(xml "$(pwd)")"
# O launchd não herda o PATH do shell; sem a pasta do ffmpeg o Whisper não lê o áudio.
PATH_VALUE="$(xml "$(dirname "$FFMPEG"):/usr/bin:/bin:/usr/sbin:/sbin")"

if lsof -tiTCP:8765 -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "Já tem um servidor na porta 8765 (start.sh aberto?). Feche ele e rode de novo."
  exit 1
fi

mkdir -p "$(dirname "$PLIST")"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HERE/.venv/bin/python</string>
    <string>$HERE/server.py</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_VALUE</string>
    <key>ESCUTA_LOG</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

stop
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Pronto. O servidor sobe sozinho a cada login."
echo "Log: $(pwd)/escuta.log"
echo "Reiniciar (depois de mudar o .env): launchctl kickstart -k $DOMAIN/$LABEL"
echo "Desfazer: ./autostart.sh --remover"
