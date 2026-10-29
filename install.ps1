# Escuta: instalador de terminal (Windows). Cole no PowerShell:
#   irm https://raw.githubusercontent.com/Duuhhduuu/escuta/main/install.ps1 | iex
#
# Variáveis opcionais (para automatizar ou testar):
#   ESCUTA_PASTA     onde instalar (padrão: ~\escuta)
#   ESCUTA_SIM=1     não pergunta nada (sem chave do Gemini, com autostart)
#   ESCUTA_ORIGEM    copia de uma pasta local em vez de baixar do GitHub
#   ESCUTA_AUTOSTART=0  não liga o servidor com o Windows

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# Liga as sequências ANSI no console clássico do Windows 10.
try {
  Add-Type -Namespace Escuta -Name Vt -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
'@
  $h = [Escuta.Vt]::GetStdHandle(-11); $m = 0
  if ([Escuta.Vt]::GetConsoleMode($h, [ref]$m)) { [void][Escuta.Vt]::SetConsoleMode($h, $m -bor 4) }
} catch {}

$CSI = [char]27
function Cor($r, $g, $b) { "${CSI}[38;2;${r};${g};${b}m" }
$AMB = Cor 255 197 61; $VER = Cor 76 208 141; $CIN = Cor 154 166 182; $VRM = Cor 255 138 122
$AZU = Cor 142 155 255; $ESC = Cor 58 67 112; $BRA = "${CSI}[1;38;2;246;244;239m"; $RST = "${CSI}[0m"

$Pasta = if ($env:ESCUTA_PASTA) { $env:ESCUTA_PASTA } else { Join-Path $env:USERPROFILE 'escuta' }
$Sim = $env:ESCUTA_SIM -eq '1'
$Zip = 'https://github.com/Duuhhduuu/escuta/archive/refs/heads/main.zip'
$Largura = 78

function Cabecalho($tick) {
  $cur = if ($tick % 2 -eq 0) { "${AMB}_${RST}" } else { ' ' }
  @(
    '',
    "  ${AMB}╭──────────────────────╮${RST}",
    "  ${AMB}│${RST}  ${AMB}▂${RST}   ${AMB}▄${RST}   ${AMB}█${RST}   ${AMB}▄${RST}   ${AZU}┃${RST}   ${AMB}│${RST}   ${BRA}escuta${RST}${cur}",
    "  ${AMB}╰┬─────────────────────╯${RST}   ${CIN}instalador · tudo roda na sua máquina${RST}",
    "  ${AMB} ╵${RST}",
    ''
  )
}

# ---------- tela de confirmação ----------
function Pergunta($texto, $padraoSim) {
  if ($Sim) { return $padraoSim }
  $sufixo = if ($padraoSim) { 'S/n' } else { 's/N' }
  $r = Read-Host "  ${AMB}?${RST} $texto ${CIN}[$sufixo]${RST}"
  if (-not $r) { return $padraoSim }
  return ($r -match '^[sSyY]')
}

Clear-Host
Cabecalho 0 | ForEach-Object { Write-Host $_ }
Write-Host "  ${BRA}O que vai acontecer${RST}"
Write-Host "  ${CIN}·${RST} instalar o Escuta em ${BRA}$Pasta${RST}"
Write-Host "  ${CIN}·${RST} preparar o Python e o Whisper (alguns minutos na primeira vez; baixa até ~2 GB)"
Write-Host "  ${CIN}·${RST} ligar o servidor local e abrir a extensão no Chrome"
Write-Host "  ${CIN}·${RST} se faltar o Python 3, instalo por você (winget)"
Write-Host ''
if (-not (Pergunta 'Continuar?' $true)) { Write-Host "`n  Tudo bem, nada foi instalado.`n"; return }
$Autostart = if ($env:ESCUTA_AUTOSTART -eq '0') { $false } else { Pergunta 'Ligar o Escuta sozinho quando o Windows iniciar (sem janela)?' $true }
$Chave = ''
if (-not $Sim) {
  Write-Host ''
  Write-Host "  ${CIN}Resumos pelo Gemini: pegue uma chave em aistudio.google.com/apikey.${RST}"
  Write-Host "  ${CIN}Só o texto já transcrito sai da máquina. Enter para pular e usar o Ollama (local).${RST}"
  $Chave = (Read-Host "  ${AMB}?${RST} Chave do Gemini").Trim()
}

# ---------- etapas ----------
$Etapas = @(
  @{ Pend = 'Procurar o Python';                         Faz = 'Procurando o Python' },
  @{ Pend = 'Instalar o Escuta e o ambiente';            Faz = 'Instalando o Escuta e o ambiente' },
  @{ Pend = 'Baixar o modelo Whisper';                   Faz = 'Baixando o modelo Whisper' },
  @{ Pend = 'Configurar o resumo (Gemini ou Ollama)';    Faz = 'Configurando o resumo (Gemini ou Ollama)' },
  @{ Pend = 'Iniciar o servidor em 127.0.0.1:8765';      Faz = 'Iniciando o servidor' },
  @{ Pend = 'Abrir a extensão no navegador';             Faz = 'Abrindo a extensão' }
)
foreach ($e in $Etapas) { $e.Estado = 'pend'; $e.Feito = ''; $e.Det = '' }
$Rodape = @('', '')

function Linha($e) {
  $t = ''; $d = $e.Det
  switch ($e.Estado) {
    'ok'   { $ic = "${VER}✓${RST}"; $t = "${BRA}$($e.Feito)${RST}"; $len = $e.Feito.Length }
    'aviso'{ $ic = "${AMB}!${RST}"; $t = "${BRA}$($e.Feito)${RST}"; $len = $e.Feito.Length }
    'erro' { $ic = "${VRM}✗${RST}"; $t = "${BRA}$($e.Feito)${RST}"; $len = $e.Feito.Length }
    'agora'{ $ic = "${AMB}›${RST}"; $t = "${BRA}$($e.Faz)${RST}"; $len = $e.Faz.Length }
    default{ $ic = "${CIN}·${RST}"; $t = "${CIN}$($e.Pend)${RST}"; $len = $e.Pend.Length }
  }
  $pad = [Math]::Max(1, $Largura - 4 - $len - $d.Length)
  "  $ic  $t$(' ' * $pad)${CIN}$d${RST}"
}

function Desenhar($tick) {
  $feitas = @($Etapas | Where-Object { $_.Estado -in 'ok', 'aviso' }).Count
  $agora = @($Etapas | Where-Object { $_.Estado -eq 'agora' }).Count
  $segs = [Math]::Min(12, $feitas * 2 + $agora)
  $pct = [int][Math]::Round($segs * 100 / 12)
  $n = [Math]::Min(6, $feitas + $agora); if ($n -lt 1) { $n = 1 }
  $barra = ''
  for ($i = 0; $i -lt 12; $i++) {
    if ($i -lt $segs) { $barra += "${AMB}━━━━━${RST} " } else { $barra += "${ESC}━━━━━${RST} " }
  }
  $esq = "Etapa $n de 6"; $dir = "$pct%"
  $linhas = @(Cabecalho $tick)
  foreach ($e in $Etapas) { $linhas += (Linha $e) }
  $linhas += ''
  $linhas += "  ${CIN}$esq${RST}$(' ' * ($Largura - 2 - $esq.Length - $dir.Length))${AMB}$dir${RST}"
  $linhas += "  $barra"
  $linhas += ''
  $cur = if ($tick % 2 -eq 0) { "${AMB}▁${RST}" } else { ' ' }
  $linhas += "  $($Rodape[0])"
  $linhas += "  $($Rodape[1]) $cur"
  $linhas += ''
  [Console]::Write("${CSI}[H")
  foreach ($l in $linhas) { [Console]::Write("$l${CSI}[K`n") }
  [Console]::Write("${CSI}[J")
}

function Duracao($s) {
  if ($s -lt 60) { return "$([int]$s)s" }
  return "$([int][Math]::Floor($s / 60))m $([int]($s % 60))s"
}

# Roda o trabalho de uma etapa em segundo plano e redesenha a tela enquanto espera.
function Etapa($i, [scriptblock]$bloco, $argumentos) {
  $e = $Etapas[$i]; $e.Estado = 'agora'
  $Rodape[0] = "${CIN}$($e.Faz)...${RST}"
  $ini = Get-Date; $tick = 0
  $job = Start-Job -ScriptBlock $bloco -ArgumentList $argumentos
  while ($job.State -eq 'Running') { Desenhar $tick; $tick++; Start-Sleep -Milliseconds 300 }
  $res = $null; $falha = $null
  try { $res = Receive-Job $job -ErrorAction Stop | Select-Object -Last 1 } catch { $falha = $_.Exception.Message }
  Remove-Job $job -Force
  if ($falha -or -not $res) { $res = @{ Ok = $false; Erro = if ($falha) { $falha } else { 'A etapa não respondeu.' } } }
  if ($res.Ok) {
    $e.Estado = if ($res.Aviso) { 'aviso' } else { 'ok' }
    $e.Feito = $res.Feito
    $e.Det = if ($res.Det) { $res.Det } else { Duracao ((Get-Date) - $ini).TotalSeconds }
    $Rodape[0] = ''
    return $res
  }
  $e.Estado = 'erro'; $e.Feito = $e.Pend; $e.Det = ''
  $Rodape[0] = "${BRA}$($res.Erro)${RST}"; $Rodape[1] = "${CIN}Detalhes em $Pasta\instalacao.log${RST}"
  Desenhar 0
  Write-Host ''
  throw 'parou'
}

$Log = Join-Path $Pasta 'instalacao.log'
[Console]::Write("${CSI}[?25l")
Clear-Host
try {
  New-Item -ItemType Directory -Force $Pasta | Out-Null
  Set-Content -Path $Log -Value "Escuta instalador $(Get-Date -Format s)" -Encoding UTF8

  # 1. Python
  $r1 = Etapa 0 {
    function Testa($c) {
      $o = & cmd /c "$c --version 2>&1"
      if ($LASTEXITCODE -eq 0 -and "$o" -match 'Python (3\.(\d+)\.\d+)' -and [int]$Matches[2] -ge 9) { return $Matches[1] }
    }
    foreach ($c in 'py -3', 'python', 'python3') {
      $v = Testa $c
      if ($v) { return @{ Ok = $true; Py = $c; Feito = "Python $($v -replace '\.\d+$','') encontrado"; Det = $v } }
    }
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      & winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Null
      $exe = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
      if (Test-Path $exe) { return @{ Ok = $true; Py = "`"$exe`""; Feito = 'Python 3.12 instalado'; Det = '3.12' } }
    }
    return @{ Ok = $false; Erro = 'Python não encontrado. Instale em python.org e rode de novo.' }
  } @()

  # 2. Escuta + ambiente
  $null = Etapa 1 {
    param($pasta, $log, $zip, $origem, $py)
    $dest = $pasta
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('escuta-' + [guid]::NewGuid().ToString('N'))
    try {
      if ($origem) { $fonte = $origem }
      else {
        New-Item -ItemType Directory -Force $tmp | Out-Null
        $arq = Join-Path $tmp 'escuta.zip'
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $zip -OutFile $arq -UseBasicParsing
        Expand-Archive -Path $arq -DestinationPath $tmp -Force
        $fonte = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
      }
      if ((Resolve-Path $fonte).Path -ne (Resolve-Path $dest).Path) {
        & robocopy $fonte $dest /E /XD .venv .git node_modules __pycache__ /XF .env instalacao.log /NFL /NDL /NJH /NJS /NP | Out-Null
      }
    } catch { return @{ Ok = $false; Erro = 'Não consegui baixar o Escuta. Confira a internet e rode de novo.' } }
    finally { if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue } }
    & cmd /c "set `"ESCUTA_PY=$py`" && call `"$dest\server\setup.bat`" >> `"$log`" 2>&1"
    if ($LASTEXITCODE -ne 0) { return @{ Ok = $false; Erro = 'A instalação do ambiente Python falhou.' } }
    return @{ Ok = $true; Feito = 'Ambiente criado' }
  } @($Pasta, $Log, $Zip, $env:ESCUTA_ORIGEM, $r1.Py)

  # 3. Modelo Whisper
  $null = Etapa 2 {
    param($pasta, $log)
    $gpu = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
    $modelo = if ($gpu) { 'large-v3-turbo' } else { 'small' }
    $py = Join-Path $pasta 'server\.venv\Scripts\python.exe'
    & $py -c "from faster_whisper.utils import download_model; download_model('$modelo')" >> $log 2>&1
    if ($LASTEXITCODE -ne 0) { return @{ Ok = $false; Erro = 'Não consegui baixar o modelo Whisper. Confira a internet.' } }
    $nome = if ($gpu) { 'turbo' } else { 'small' }
    return @{ Ok = $true; Feito = "Whisper $nome baixado"; Det = if ($gpu) { '~1,6 GB' } else { '~0,5 GB' } }
  } @($Pasta, $Log)

  # 4. Resumo
  $r4 = Etapa 3 {
    param($pasta, $chave)
    $env_ = Join-Path $pasta 'server\.env'
    if ($chave -and -not (Test-Path $env_)) { Set-Content -Path $env_ -Value "GEMINI_API_KEY=$chave" -Encoding ASCII }
    $temChave = (Test-Path $env_) -and ((Get-Content $env_ -Raw) -match '(?m)^GEMINI_API_KEY=\S')
    if ($temChave) { return @{ Ok = $true; Feito = 'Resumo pelo Gemini'; Det = 'Gemini' } }
    $ollama = $false
    try { Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -UseBasicParsing -TimeoutSec 3 | Out-Null; $ollama = $true } catch {}
    if (-not $ollama -and (Get-Command ollama -ErrorAction SilentlyContinue)) { $ollama = $true }
    if ($ollama) { return @{ Ok = $true; Feito = 'Resumo pelo Ollama'; Det = 'Ollama' } }
    return @{ Ok = $true; Aviso = $true; Feito = 'Resumo: falta o Ollama ou uma chave do Gemini'; Det = 'ollama.com/download' }
  } @($Pasta, $Chave)

  # 5. Servidor
  $null = Etapa 4 {
    param($pasta, $auto)
    $server = Join-Path $pasta 'server'
    if ($auto) { & cmd /c "call `"$server\autostart.bat`"" | Out-Null }
    function NoAr { try { Invoke-WebRequest -Uri 'http://127.0.0.1:8765/health' -UseBasicParsing -TimeoutSec 3 | Out-Null; $true } catch { $false } }
    if (-not (NoAr)) {
      Start-Process -FilePath (Join-Path $server '.venv\Scripts\pythonw.exe') -ArgumentList 'server.py' -WorkingDirectory $server -WindowStyle Hidden
      for ($i = 0; $i -lt 60 -and -not (NoAr); $i++) { Start-Sleep -Seconds 1 }
    }
    if (-not (NoAr)) { return @{ Ok = $false; Erro = "O servidor não respondeu. Veja $server\escuta.log" } }
    return @{ Ok = $true; Feito = 'Servidor no ar'; Det = '127.0.0.1:8765' }
  } @($Pasta, $Autostart)

  # 6. Extensão
  $ext = Join-Path $Pasta 'extension'
  $null = Etapa 5 {
    param($ext)
    try { Set-Clipboard -Value $ext } catch {}
    $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) { Start-Process $chrome 'chrome://extensions' }
    Start-Process explorer.exe $ext
    return @{ Ok = $true; Feito = 'Extensão pronta para carregar'; Det = 'caminho copiado' }
  } @($ext)

  $Rodape[0] = "${BRA}Tudo pronto.${RST}"
  $Rodape[1] = "${CIN}Chrome: Modo do desenvolvedor > Carregar sem compactação > cole o caminho. Depois, WhatsApp Web e F5.${RST}"
  for ($t = 0; $t -lt 6; $t++) { Desenhar $t; Start-Sleep -Milliseconds 300 }
  Write-Host ''
} catch {
  if ($_.Exception.Message -ne 'parou') {
    Write-Host "`n  ${VRM}✗${RST} $($_.Exception.Message)`n"
  }
} finally {
  [Console]::Write("${CSI}[?25h${RST}")
}
