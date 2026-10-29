#!/usr/bin/env bash
# Escuta: instalador de terminal (Mac e Linux). Cole no terminal:
#   curl -fsSL https://raw.githubusercontent.com/Duuhhduuu/escuta/main/install.sh | bash
#
# Variáveis opcionais (para automatizar ou testar):
#   ESCUTA_PASTA   onde instalar (padrão: ~/escuta)
#   ESCUTA_SIM=1   não pergunta nada (sem chave do Gemini, com autostart no Mac)
#   ESCUTA_ORIGEM  copia de uma pasta local em vez de baixar do GitHub
set -u

PASTA="${ESCUTA_PASTA:-$HOME/escuta}"
TARBALL="https://github.com/Duuhhduuu/escuta/archive/refs/heads/main.tar.gz"
LARGURA=78
SO="$(uname -s)"; ARQ="$(uname -m)"
LOG="$PASTA/instalacao.log"

# ---------- cores ----------
c() { printf '\033[38;2;%s;%s;%sm' "$1" "$2" "$3"; }
AMB="$(c 255 197 61)"; VER="$(c 76 208 141)"; CIN="$(c 154 166 182)"; VRM="$(c 255 138 122)"
AZU="$(c 142 155 255)"; ESC="$(c 58 67 112)"; BRA=$'\033[1;38;2;246;244;239m'; RST=$'\033[0m'
LIN=$'\033[K'

# O terminal pode vir do pipe (curl | bash): as perguntas leem de /dev/tty.
if [ -r /dev/tty ]; then TTY=/dev/tty; else TTY=/dev/stdin; fi
pergunta() { # texto padrão(s|n) -> 0 = sim
  [ "${ESCUTA_SIM:-0}" = 1 ] && { [ "$2" = s ]; return; }
  local suf="S/n"; [ "$2" = n ] && suf="s/N"
  printf '  %s?%s %s %s[%s]%s ' "$AMB" "$RST" "$1" "$CIN" "$suf" "$RST" > /dev/tty
  local r; read -r r < "$TTY" || r=""
  [ -z "$r" ] && { [ "$2" = s ]; return; }
  case "$r" in [sSyY]*) return 0 ;; *) return 1 ;; esac
}

cabecalho() { # tick
  local cur=" "; [ $(($1 % 2)) -eq 0 ] && cur="${AMB}_${RST}"
  printf '\n'
  printf '  %s╭──────────────────────╮%s%s\n' "$AMB" "$RST" "$LIN"
  printf '  %s│%s  %s▂%s   %s▄%s   %s█%s   %s▄%s   %s┃%s   %s│%s   %sescuta%s%s%s\n' "$AMB" "$RST" "$AMB" "$RST" "$AMB" "$RST" "$AMB" "$RST" "$AMB" "$RST" "$AZU" "$RST" "$AMB" "$RST" "$BRA" "$RST" "$cur" "$LIN"
  printf '  %s╰┬─────────────────────╯%s   %sinstalador · tudo roda na sua máquina%s%s\n' "$AMB" "$RST" "$CIN" "$RST" "$LIN"
  printf '  %s ╵%s%s\n\n' "$AMB" "$RST" "$LIN"
}

# ---------- tela de confirmação ----------
clear
cabecalho 0
printf '  %sO que vai acontecer%s\n' "$BRA" "$RST"
printf '  %s·%s instalar o Escuta em %s%s%s\n' "$CIN" "$RST" "$BRA" "$PASTA" "$RST"
printf '  %s·%s preparar o Python e o Whisper (alguns minutos na primeira vez; baixa até ~2 GB)\n' "$CIN" "$RST"
printf '  %s·%s ligar o servidor local e abrir a extensão no Chrome\n\n' "$CIN" "$RST"
pergunta "Continuar?" s || { printf '\n  Tudo bem, nada foi instalado.\n\n'; exit 0; }
AUTOSTART=0
if [ "$SO" = Darwin ]; then pergunta "Ligar o Escuta sozinho a cada login (sem Terminal aberto)?" s && AUTOSTART=1; fi
CHAVE=""
if [ "${ESCUTA_SIM:-0}" != 1 ]; then
  printf '\n  %sResumos pelo Gemini: pegue uma chave em aistudio.google.com/apikey.%s\n' "$CIN" "$RST" > /dev/tty
  printf '  %sSó o texto já transcrito sai da máquina. Enter para pular e usar o Ollama (local).%s\n' "$CIN" "$RST" > /dev/tty
  printf '  %s?%s Chave do Gemini ' "$AMB" "$RST" > /dev/tty
  read -r CHAVE < "$TTY" || CHAVE=""
  CHAVE="$(printf '%s' "$CHAVE" | tr -d '[:space:]')"
fi

# ---------- etapas ----------
PEND=("Procurar o Python" "Instalar o Escuta e o ambiente" "Baixar o modelo Whisper" "Configurar o resumo (Gemini ou Ollama)" "Iniciar o servidor em 127.0.0.1:8765" "Abrir a extensão no navegador")
FAZ=("Procurando o Python" "Instalando o Escuta e o ambiente" "Baixando o modelo Whisper" "Configurando o resumo (Gemini ou Ollama)" "Iniciando o servidor" "Abrindo a extensão")
ESTADO=(pend pend pend pend pend pend)
FEITO=("" "" "" "" "" "")
DET=("" "" "" "" "" "")
ROD0=""; ROD1=""

linha() { # i
  local i=$1 ic t txt det="${DET[$1]}" len pad
  case "${ESTADO[$i]}" in
    ok)    ic="${VER}✓${RST}"; txt="${FEITO[$i]}"; t="${BRA}${txt}${RST}" ;;
    aviso) ic="${AMB}!${RST}"; txt="${FEITO[$i]}"; t="${BRA}${txt}${RST}" ;;
    erro)  ic="${VRM}✗${RST}"; txt="${PEND[$i]}";  t="${BRA}${txt}${RST}" ;;
    agora) ic="${AMB}›${RST}"; txt="${FAZ[$i]}";   t="${BRA}${txt}${RST}" ;;
    *)     ic="${CIN}·${RST}"; txt="${PEND[$i]}";  t="${CIN}${txt}${RST}" ;;
  esac
  len=$(printf '%s' "$txt" | wc -m | tr -d ' ')
  pad=$((LARGURA - 4 - len - ${#det})); [ $pad -lt 1 ] && pad=1
  printf '  %s  %s%*s%s%s%s%s\n' "$ic" "$t" "$pad" "" "$CIN" "$det" "$RST" "$LIN"
}

desenhar() { # tick
  local feitas=0 agora=0 i segs pct n barra="" esq dir cur=" "
  for i in 0 1 2 3 4 5; do
    case "${ESTADO[$i]}" in ok|aviso) feitas=$((feitas + 1)) ;; agora) agora=1 ;; esac
  done
  segs=$((feitas * 2 + agora)); [ $segs -gt 12 ] && segs=12
  pct=$(( (segs * 100 + 6) / 12 ))
  n=$((feitas + agora)); [ $n -lt 1 ] && n=1; [ $n -gt 6 ] && n=6
  for i in $(seq 0 11); do
    if [ $i -lt $segs ]; then barra+="${AMB}━━━━━${RST} "; else barra+="${ESC}━━━━━${RST} "; fi
  done
  esq="Etapa $n de 6"; dir="${pct}%"
  [ $(($1 % 2)) -eq 0 ] && cur="${AMB}▁${RST}"
  printf '\033[H'
  cabecalho "$1"
  for i in 0 1 2 3 4 5; do linha $i; done
  printf '%s\n' "$LIN"
  printf '  %s%s%s%*s%s%s%s%s\n' "$CIN" "$esq" "$RST" $((LARGURA - 2 - ${#esq} - ${#dir})) "" "$AMB" "$dir" "$RST" "$LIN"
  printf '  %s%s\n%s\n' "$barra" "$LIN" "$LIN"
  printf '  %s%s\n' "$ROD0" "$LIN"
  printf '  %s %s%s\n' "$ROD1" "$cur" "$LIN"
  printf '%s\n\033[J' "$LIN"
}

fmt() { local s=$1; if [ "$s" -lt 60 ]; then printf '%ss' "$s"; else printf '%sm %ss' $((s / 60)) $((s % 60)); fi; }

TICK=0
# Roda "$cmd" em segundo plano, redesenha enquanto espera. Fica com o resultado em RES_*.
# O comando deixa linhas "feito=..." / "det=..." / "aviso=1" / "erro=..." em $RES.
RES="$(mktemp)"
etapa() { # indice funcao
  local i=$1 ini; ini=$(date +%s)
  ESTADO[$i]=agora; ROD0="${CIN}${FAZ[$i]}...${RST}"; : > "$RES"
  "$2" >> "$LOG" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do desenhar $TICK; TICK=$((TICK + 1)); sleep 0.3; done
  wait "$pid"; local rc=$?
  local feito det aviso erro
  feito="$(sed -n 's/^feito=//p' "$RES" | tail -1)"; det="$(sed -n 's/^det=//p' "$RES" | tail -1)"
  aviso="$(sed -n 's/^aviso=//p' "$RES" | tail -1)"; erro="$(sed -n 's/^erro=//p' "$RES" | tail -1)"
  if [ $rc -eq 0 ]; then
    ESTADO[$i]=ok; [ -n "$aviso" ] && ESTADO[$i]=aviso
    FEITO[$i]="$feito"
    DET[$i]="${det:-$(fmt $(( $(date +%s) - ini )))}"
    ROD0=""
    return 0
  fi
  ESTADO[$i]=erro
  ROD0="${BRA}${erro:-A etapa falhou.}${RST}"; ROD1="${CIN}Detalhes em $LOG${RST}"
  desenhar 0; printf '\n'
  exit 1
}

# ---------- trabalho de cada etapa ----------
PY=python3
e1() {
  local v
  for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then
      v="$("$cand" -c 'import sys;print("%d.%d.%d" % sys.version_info[:3]) if sys.version_info>=(3,9) else sys.exit(1)' 2>/dev/null)" && {
        echo "py=$cand" > "$PASTA/.py"; echo "feito=Python ${v%.*} encontrado" > "$RES"; echo "det=$v" >> "$RES"; return 0; }
    fi
  done
  if [ "$SO" = Darwin ] && command -v brew >/dev/null 2>&1; then
    brew install python >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && {
      echo "py=python3" > "$PASTA/.py"; echo "feito=Python instalado" > "$RES"; return 0; }
  fi
  echo "erro=Python não encontrado. Instale em python.org e rode de novo." > "$RES"; return 1
}

e2() {
  if [ -n "${ESCUTA_ORIGEM:-}" ]; then
    if [ "$(cd "$ESCUTA_ORIGEM" && pwd)" != "$(cd "$PASTA" && pwd)" ]; then
      (cd "$ESCUTA_ORIGEM" && tar --exclude=.venv --exclude=.git --exclude=.env --exclude=instalacao.log -cf - .) | tar -xf - -C "$PASTA" || { echo "erro=Não consegui copiar o Escuta." > "$RES"; return 1; }
    fi
  else
    curl -fsSL "$TARBALL" | tar -xz --strip-components=1 -C "$PASTA" || { echo "erro=Não consegui baixar o Escuta. Confira a internet e rode de novo." > "$RES"; return 1; }
  fi
  if [ "$SO" = Darwin ] && [ "$ARQ" = arm64 ] && ! command -v ffmpeg >/dev/null 2>&1; then
    command -v brew >/dev/null 2>&1 && brew install ffmpeg
  fi
  chmod +x "$PASTA"/server/*.sh
  (cd "$PASTA/server" && ./setup.sh) || { echo "erro=A instalação do ambiente Python falhou." > "$RES"; return 1; }
  echo "feito=Ambiente criado" > "$RES"
}

e3() {
  local py="$PASTA/server/.venv/bin/python" modelo nome det
  if [ "$SO" = Darwin ] && [ "$ARQ" = arm64 ]; then
    "$py" -c "from huggingface_hub import snapshot_download as d; d('mlx-community/whisper-large-v3-turbo')" || { echo "erro=Não consegui baixar o modelo Whisper. Confira a internet." > "$RES"; return 1; }
    nome=turbo; det="~1,6 GB"
  else
    if command -v nvidia-smi >/dev/null 2>&1; then modelo=large-v3-turbo; nome=turbo; det="~1,6 GB"; else modelo=small; nome=small; det="~0,5 GB"; fi
    "$py" -c "from faster_whisper.utils import download_model; download_model('$modelo')" || { echo "erro=Não consegui baixar o modelo Whisper. Confira a internet." > "$RES"; return 1; }
  fi
  echo "feito=Whisper $nome baixado" > "$RES"; echo "det=$det" >> "$RES"
}

e4() {
  local envf="$PASTA/server/.env"
  if [ -n "$CHAVE" ] && [ ! -f "$envf" ]; then printf 'GEMINI_API_KEY=%s\n' "$CHAVE" > "$envf"; fi
  if [ -f "$envf" ] && grep -Eq '^GEMINI_API_KEY=[^[:space:]]' "$envf"; then
    echo "feito=Resumo pelo Gemini" > "$RES"; echo "det=Gemini" >> "$RES"; return 0; fi
  if command -v ollama >/dev/null 2>&1 || curl -fs -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "feito=Resumo pelo Ollama" > "$RES"; echo "det=Ollama" >> "$RES"; return 0; fi
  echo "feito=Resumo: falta o Ollama ou uma chave do Gemini" > "$RES"; echo "det=ollama.com/download" >> "$RES"; echo "aviso=1" >> "$RES"
}

no_ar() { curl -fs -m 3 http://127.0.0.1:8765/health >/dev/null 2>&1; }
e5() {
  if ! no_ar; then
    if [ "$AUTOSTART" = 1 ]; then (cd "$PASTA/server" && ./autostart.sh) || true; fi
    if ! no_ar; then (cd "$PASTA/server" && nohup ./start.sh >> escuta.log 2>&1 &) ; fi
    for _ in $(seq 60); do no_ar && break; sleep 1; done
  fi
  no_ar || { echo "erro=O servidor não respondeu. Veja $PASTA/server/escuta.log" > "$RES"; return 1; }
  echo "feito=Servidor no ar" > "$RES"; echo "det=127.0.0.1:8765" >> "$RES"
}

e6() {
  local ext="$PASTA/extension"
  if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$ext" | pbcopy
  elif command -v wl-copy >/dev/null 2>&1; then printf '%s' "$ext" | wl-copy
  elif command -v xclip >/dev/null 2>&1; then printf '%s' "$ext" | xclip -selection clipboard; fi
  if [ "$SO" = Darwin ]; then
    open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
    open "$ext" 2>/dev/null || true
  else
    for b in google-chrome google-chrome-stable chromium chromium-browser; do
      command -v "$b" >/dev/null 2>&1 && { nohup "$b" "chrome://extensions" >/dev/null 2>&1 & break; }
    done
    command -v xdg-open >/dev/null 2>&1 && xdg-open "$ext" >/dev/null 2>&1 &
  fi
  echo "feito=Extensão pronta para carregar" > "$RES"; echo "det=caminho copiado" >> "$RES"
}

# ---------- vai ----------
mkdir -p "$PASTA"; echo "Escuta instalador $(date)" > "$LOG"
printf '\033[?25l'; trap 'printf "\033[?25h%s" "$RST"; rm -f "$RES"' EXIT
clear
etapa 0 e1
PY="$(sed -n 's/^py=//p' "$PASTA/.py")"; rm -f "$PASTA/.py"
etapa 1 e2
etapa 2 e3
etapa 3 e4
etapa 4 e5
etapa 5 e6
ROD0="${BRA}Tudo pronto.${RST}"
ROD1="${CIN}Chrome: Modo do desenvolvedor > Carregar sem compactação > cole o caminho. Depois, WhatsApp Web e F5.${RST}"
for t in 0 1 2 3 4 5; do desenhar $t; sleep 0.3; done
printf '\n'
