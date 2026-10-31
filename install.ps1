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
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

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
Write-Host "  ${CIN}·${RST} instalar o Python se faltar e preparar o Whisper"
Write-Host "  ${CIN}·${RST} configurar resumos com Ollama (local) ou Gemini (nuvem)"
Write-Host "  ${CIN}·${RST} no Ollama, baixar um modelo local (~1,9 GB) se faltar"
Write-Host "  ${CIN}·${RST} ligar o servidor local e abrir a extensão no Chrome"
Write-Host ''
if (-not (Pergunta 'Continuar?' $true)) { Write-Host "`n  Tudo bem, nada foi instalado.`n"; return }
$Autostart = if ($env:ESCUTA_AUTOSTART -eq '0') { $false } else { Pergunta 'Ligar o Escuta sozinho quando o Windows iniciar (sem janela)?' $true }
$Chave = ''
$Resumo = 'ollama'
if (-not $Sim) {
  Write-Host ''
  Write-Host "  ${CIN}Ollama roda localmente e é a opção recomendada. Gemini usa a nuvem do Google.${RST}"
  Write-Host "  ${AMB}1${RST} Ollama (local, padrão)    ${AMB}2${RST} Gemini (nuvem)"
  $escolha = (Read-Host "  ${AMB}?${RST} Como quer gerar resumos e atas? [1/2]").Trim()
  if ($escolha -match '^(2|gemini)$') {
    $Resumo = 'gemini'
    $envExistente = Join-Path $Pasta 'server\.env'
    $chaveExistente = ''
    if (Test-Path $envExistente) {
      $linhaChave = Get-Content $envExistente | Where-Object { $_ -match '^\s*GEMINI_API_KEY\s*=' } | Select-Object -Last 1
      if ($linhaChave) { $chaveExistente = (($linhaChave -split '=', 2)[1]).Trim().Trim('"').Trim("'") }
    }
    if ($chaveExistente -and (Pergunta 'Já existe uma chave Gemini. Reutilizar?' $true)) {
      $Chave = $chaveExistente
    } else {
      Write-Host "  ${CIN}Pegue uma chave em aistudio.google.com/apikey.${RST}"
      do { $Chave = (Read-Host "  ${AMB}?${RST} Chave do Gemini").Trim() } while (-not $Chave)
    }
  }
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
    param($log)
    function AtualizaPath {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
      $env:Path = "$machinePath;$userPath;$env:Path"
    }
    function Testa($c) {
      $o = & cmd /c "$c --version 2>&1"
      if ($LASTEXITCODE -eq 0 -and "$o" -match 'Python (3\.(\d+)\.\d+)' -and [int]$Matches[2] -ge 9) { return $Matches[1] }
    }
    function ProcuraPython {
      AtualizaPath
      foreach ($c in 'py -3', 'python', 'python3') {
        $v = Testa $c
        if ($v) { return @{ Py = $c; Versao = $v } }
      }
      $bases = @((Join-Path $env:LOCALAPPDATA 'Programs\Python'), (Join-Path $env:ProgramFiles 'Python'))
      foreach ($base in $bases) {
        if (Test-Path $base) {
          $exe = Get-ChildItem -Path $base -Filter python.exe -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
          if ($exe) {
            $v = Testa ('"' + $exe.FullName + '"')
            if ($v) { return @{ Py = '"' + $exe.FullName + '"'; Versao = $v } }
          }
        }
      }
      return $null
    }

    $encontrado = ProcuraPython
    if ($encontrado) {
      return @{ Ok = $true; Py = $encontrado.Py; Feito = "Python $($encontrado.Versao -replace '\.\d+$','') encontrado"; Det = $encontrado.Versao }
    }

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
      & $winget.Source install -e --id Python.Python.3.14 --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 |
        Out-File -FilePath $log -Append -Encoding utf8
      $encontrado = ProcuraPython
      if ($encontrado) {
        return @{ Ok = $true; Py = $encontrado.Py; Feito = "Python $($encontrado.Versao -replace '\.\d+$','') instalado"; Det = $encontrado.Versao }
      }
    }

    # Fallback oficial para Windows sem winget ou quando o catálogo não consegue instalar.
    $versao = '3.14.10'
    $sha256 = '92480239264744fe0386a1bd8275786fefa126e3129e56a68e22b52c73329965'
    $setup = Join-Path ([IO.Path]::GetTempPath()) "python-$versao-amd64.exe"
    $destino = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python314'
    try {
      Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$versao/python-$versao-amd64.exe" -OutFile $setup -UseBasicParsing
      if ((Get-FileHash -Path $setup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
        return @{ Ok = $false; Erro = 'A verificação do instalador oficial do Python falhou.' }
      }
      $proc = Start-Process -FilePath $setup -ArgumentList @('/quiet', 'InstallAllUsers=0', ('TargetDir="' + $destino + '"'), 'Include_pip=1', 'Include_launcher=0', 'PrependPath=0', 'Include_test=0') -Wait -PassThru
      if ($proc.ExitCode -ne 0) { return @{ Ok = $false; Erro = "O instalador do Python terminou com código $($proc.ExitCode)." } }
      $exe = Join-Path $destino 'python.exe'
      $v = Testa ('"' + $exe + '"')
      if ($v) { return @{ Ok = $true; Py = '"' + $exe + '"'; Feito = "Python $($v -replace '\.\d+$','') instalado"; Det = $v } }
    } catch {
      "Fallback Python: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8
    } finally {
      Remove-Item $setup -Force -ErrorAction SilentlyContinue
    }
    return @{ Ok = $false; Erro = 'Não consegui instalar o Python. Confira a internet e veja o log para o erro do winget ou do instalador oficial.' }
  } @($Log)

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
    param($pasta, $provedor, $chave, $log)
    $env_ = Join-Path $pasta 'server\.env'
    $linhas = if (Test-Path $env_) { @(Get-Content $env_) } else { @() }
    $linhas = @($linhas | Where-Object { $_ -notmatch '^\s*ESCUTA_SUMMARY_PROVIDER\s*=' })
    if ($provedor -eq 'gemini') {
      if (-not $chave) { return @{ Ok = $false; Erro = 'A chave do Gemini está vazia.' } }
      $linhas = @($linhas | Where-Object { $_ -notmatch '^\s*GEMINI_API_KEY\s*=' })
      $linhas += "GEMINI_API_KEY=$chave"
      $linhas += 'ESCUTA_SUMMARY_PROVIDER=gemini'
      Set-Content -Path $env_ -Value $linhas -Encoding ASCII
      return @{ Ok = $true; Feito = 'Resumo pelo Gemini'; Det = 'Gemini' }
    }
    $linhas += 'ESCUTA_SUMMARY_PROVIDER=ollama'
    Set-Content -Path $env_ -Value $linhas -Encoding ASCII

    $modelo = 'qwen2.5:3b-instruct'
    function TestaOllama {
      try { return Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3 } catch { return $null }
    }
    $cli = Get-Command ollama -ErrorAction SilentlyContinue
    $ollamaExe = if ($cli) { $cli.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }
    if (-not (Test-Path $ollamaExe)) {
      $winget = Get-Command winget -ErrorAction SilentlyContinue
      if ($winget) {
        & $winget.Source install -e --id Ollama.Ollama --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 |
          Out-File -FilePath $log -Append -Encoding utf8
      }
      $cli = Get-Command ollama -ErrorAction SilentlyContinue
      $ollamaExe = if ($cli) { $cli.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }
    }
    if (-not (Test-Path $ollamaExe)) {
      # Fallback pelo instalador oficial, conferindo a assinatura do fornecedor.
      $setup = Join-Path ([IO.Path]::GetTempPath()) 'OllamaSetup.exe'
      try {
        Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $setup -UseBasicParsing
        $sig = Get-AuthenticodeSignature -FilePath $setup
        if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Ollama') {
          return @{ Ok = $false; Erro = 'Não consegui confirmar a assinatura do instalador do Ollama.' }
        }
        $proc = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-') -Wait -PassThru
        if ($proc.ExitCode -ne 0) { return @{ Ok = $false; Erro = "O instalador do Ollama terminou com código $($proc.ExitCode)." } }
      } catch {
        "Fallback Ollama: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8
        return @{ Ok = $false; Erro = 'Não consegui instalar o Ollama. Confira a internet e o log.' }
      } finally { Remove-Item $setup -Force -ErrorAction SilentlyContinue }
      $ollamaExe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    }
    if (-not (Test-Path $ollamaExe)) { return @{ Ok = $false; Erro = 'O Ollama instalou, mas o comando não apareceu no local esperado.' } }

    $api = TestaOllama
    if (-not $api) {
      Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden
      for ($i = 0; $i -lt 90 -and -not $api; $i++) { Start-Sleep -Seconds 1; $api = TestaOllama }
    }
    if (-not $api) { return @{ Ok = $false; Erro = 'O Ollama foi instalado, mas não iniciou. Abra o aplicativo Ollama e rode o instalador de novo.' } }

    $temModelo = @($api.models | Where-Object { $_.name -eq $modelo -or $_.model -eq $modelo }).Count -gt 0
    if (-not $temModelo) {
      & $ollamaExe pull $modelo 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
      if ($LASTEXITCODE -ne 0) { return @{ Ok = $false; Erro = 'Não consegui baixar o modelo local. Rode o instalador de novo para tentar novamente.' } }
    }
    return @{ Ok = $true; Feito = 'Ollama e modelo local prontos'; Det = $modelo }
  } @($Pasta, $Resumo, $Chave, $Log)

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
