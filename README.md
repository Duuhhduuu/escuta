<p align="center">
  <img src="brand/readme-header.png" alt="escuta: transcreve e resume mensagens de voz e reuniões" width="760">
</p>

# Escuta

Extensão pessoal para o Chrome. Adiciona um botão **Transcrever** em cada mensagem de voz do WhatsApp Web e, depois, **Resumir**. Tudo roda na sua máquina.

```
WhatsApp Web ── extensão ──> servidor local (127.0.0.1:8765) ──> Whisper (transcrição)
                                                             └─> Ollama ou Gemini (resumo)
```

Transcrição: **faster-whisper** no Windows/Linux (usa a GPU NVIDIA quando existe, senão CPU) e **mlx-whisper** no Mac com Apple Silicon. O `setup` escolhe sozinho.

## Baixar

**Sem git (mais simples):** abra <https://github.com/Duuhhduuu/escuta>, clique no botão verde **Code** e depois em **Download ZIP**. Extraia o ZIP e mova a pasta de dentro para um lugar fixo, por exemplo `C:\escuta`. O `instalar.bat` tem que ficar na raiz dessa pasta:

```
C:\escuta\
  instalar.bat      <- este aqui
  README.md
  extension\
  server\
```

Evite deixar em `Downloads` ou na área de trabalho: o servidor roda dali toda vez que você liga o PC, então mover a pasta depois quebra o atalho de inicialização (é só rodar o `instalar.bat` de novo no lugar novo).

**Com git:**

```bash
git clone https://github.com/Duuhhduuu/escuta.git
```

## Instalação — Windows

Precisa do [Python 3](https://python.org) instalado, com **Add Python to PATH** marcado. Na hora de instalar o Python, marque a caixa **Add python.exe to PATH** no primeiro passo — sem isso o `instalar.bat` não acha o Python.

Depois, dê dois cliques em **`instalar.bat`** na raiz do projeto. Ele faz tudo:

1. Instala o servidor e, se houver placa NVIDIA, as bibliotecas CUDA
2. Pergunta sua chave do Gemini para os resumos (pode pular e usar o Ollama)
3. Configura o servidor para subir sozinho a cada login, sem janela
4. Liga o servidor e abre a pasta da extensão

Sobra um passo manual, que o Chrome não deixa automatizar: em `chrome://extensions` (no Brave, `brave://extensions`), ligue o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha a pasta `extension`.

Depois de atualizar os arquivos da extensão, clique em ⟳ no card dela em `chrome://extensions` e recarregue o WhatsApp Web (F5).

Pode rodar o `instalar.bat` de novo quando quiser — ele pula tudo que já estiver instalado.

## Instalação — Mac / Linux

1. Servidor (uma vez):
   ```bash
   cd server && ./setup.sh
   ```
2. Ollama: `brew install --cask ollama` e `ollama pull qwen2.5:7b`.
3. Extensão: em `chrome://extensions`, ligue o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha a pasta `extension`.

## Subir sozinho no login (Mac)

```bash
cd server && ./autostart.sh
```

Cria um LaunchAgent (`~/Library/LaunchAgents/com.escuta.server.plist`): o servidor sobe a cada login, sem Terminal aberto, e volta sozinho se cair. O log vai para `server/escuta.log`.

- Reiniciar depois de mudar o `.env`: `launchctl kickstart -k gui/$(id -u)/com.escuta.server`
- Desfazer: `./autostart.sh --remover`
- Com o autostart ligado, não rode o `start.sh` junto: os dois querem a porta 8765.

### Firefox

1. Abra `about:debugging#/runtime/this-firefox` e clique em **Carregar extensão temporária**. Escolha `extension/manifest.json`.
2. Abra `about:addons`, entre em Escuta, aba **Permissões**, e ative o acesso a `127.0.0.1`. O Firefox não concede isso sozinho.
3. A extensão temporária some ao fechar o Firefox. Para instalar de forma permanente é preciso assiná-la (Mozilla, distribuição própria, grátis) ou usar o Firefox Developer Edition.

## Resumos pelo Gemini (em vez do Ollama)

1. Pegue uma chave em [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Copie `server/.env.example` para `server/.env` e preencha:
   ```
   GEMINI_API_KEY=sua-chave
   # GEMINI_MODEL=gemini-flash-lite-latest
   ```
3. Reinicie o servidor. Com a chave presente, todo resumo vai pro Gemini e o Ollama deixa de ser necessário — o ícone da extensão passa a mostrar `Gemini · <modelo>`.

Só o texto já transcrito sai da máquina; o áudio nunca sai. Sem a chave, tudo continua local no Ollama.

## Token do servidor (opcional)

Por padrão o servidor recusa páginas da web, mas aceita qualquer programa rodando na sua máquina. Para fechar isso:

São **dois lados** e os dois precisam do mesmo valor. Preencher só o campo da extensão não protege nada — o servidor continua aceitando qualquer um.

1. Gere um segredo: `python -c "import secrets;print(secrets.token_urlsafe(24))"`
2. Ponha em `server/.env` como `ESCUTA_TOKEN=...`, numa linha só dele.
3. **Reinicie o servidor.** O `.env` é lido no boot; enquanto não reiniciar, nada muda.
4. Cole o mesmo texto no campo **Token do servidor** no ícone da extensão e salve.

Se você preencher só o campo da extensão, o popup avisa. Editando o `.env` à mão, confira que cada variável fica na sua própria linha: sem a quebra de linha no fim do arquivo, a linha seguinte gruda na anterior e as duas variáveis se perdem.

Sem `ESCUTA_TOKEN` no `.env`, nada muda e o campo pode ficar vazio.

## Subir sozinho no login (Windows)

Na pasta `server`, dê dois cliques em **`autostart.bat`**. Ele cria um atalho na pasta Inicializar do Windows e o servidor passa a subir a cada login **sem abrir janela nenhuma** — roda pelo `pythonw.exe`, que não tem console.

Como não há janela, o que apareceria nela vai para `server/escuta.log` (tempo de cada transcrição, erros, se caiu para a CPU). Para parar o servidor: Gerenciador de Tarefas, encerre o `pythonw.exe`. Para ver o que está acontecendo ao vivo, rode o `start.bat` à mão — esse abre console.

Para desfazer o autostart, rode `autostart.bat /remover`.

O servidor pré-carrega o modelo no boot e segura ~2 GB de VRAM enquanto está ligado. Se preferir a placa livre, ponha `ESCUTA_PRELOAD=0` no `.env` — aí ele carrega só na primeira transcrição.

## Uso

1. Se não configurou o autostart acima, inicie o servidor e deixe a janela aberta: **`server\start.bat`** no Windows, `cd server && ./start.sh` no Mac/Linux.
2. Abra o WhatsApp Web. Cada mensagem de voz ganha um botão **Transcrever**.
3. Depois da transcrição, use **Resumir** ou **Copiar**.

Em áudio longo o texto aparece aos poucos, trecho a trecho, enquanto o resto ainda é transcrito.

As transcrições (e os resumos) ficam salvas no navegador. Recarregar o WhatsApp ou voltar a uma conversa mostra o texto na hora, sem transcrever de novo. **Recolher** esconde o cartão e deixa só uma pílula, que reabre num clique (fica recolhido mesmo depois de recarregar). **Apagar** pede um segundo clique e apaga a transcrição salva daquela mensagem.

### Pesquisar transcrições

No ícone da extensão, **Pesquisar transcrições** abre uma página com tudo que já foi transcrito, do mais recente para o mais antigo. A busca ignora acento e maiúscula ("reuniao" acha "Reunião"), aceita várias palavras e procura no texto, no resumo, no nome da conversa e em quem mandou. Dá para filtrar por conversa, copiar e apagar.

A conversa e quem mandou passaram a ser guardados na versão 1.4. Transcrições anteriores aparecem em "Sem conversa (salvas antes)". Tudo fica no navegador; nada vai para o servidor.

No ícone da extensão:

- **Transcrever sozinho o áudio mais recente recebido** (desligado por padrão): quando o último recado da conversa aberta é um áudio recebido, ele é transcrito sem clique. Vale para o que acabou de chegar e para o último ao abrir a conversa; áudios mais antigos continuam no botão. Como a extensão toca o áudio sem som para copiá-lo, ele fica marcado como ouvido.
- **Resumir sozinho áudios com mais de 1 min** (ligado por padrão): logo depois da transcrição, gera o resumo.

O ícone da extensão mostra o estado do servidor, do Whisper (e qual motor está em uso) e do Ollama, e deixa trocar idioma e modelos.

## Reuniões

Além das mensagens do WhatsApp, o Escuta grava reuniões online (Google Meet, Teams, Zoom no navegador…) e escreve a ata.

1. Abra a aba da reunião e clique no ícone do Escuta **nessa aba**.
2. Em **Reunião**, escolha o modelo da ata e clique em **Gravar esta aba**. Na primeira vez o navegador pede permissão de microfone numa aba à parte; é só permitir: a gravação começa sozinha e você volta para a reunião.
3. Quando terminar, **Parar e gerar a ata**. O ícone mostra **REC** enquanto grava, **…** enquanto processa e **✓** quando a ata está pronta. Ela aparece em **Pesquisar transcrições**, com a ata formatada, a transcrição de quem falou o quê (**Você** e **Participantes**) e botões para copiar, baixar em `.md` e refazer a ata com outro modelo.

Como funciona: a extensão grava o áudio da aba e o seu microfone **em canais separados** do mesmo arquivo. O servidor transcreve cada canal sozinho e junta por horário, então sabe o que foi você e o que foram os outros sem adivinhar vozes. A ata é gerada pelo Gemini ou pelo Ollama, o mesmo dos resumos.

- **Painel ao vivo, ao lado da reunião:** ao começar a gravar, um painel flutuante aparece no lado direito da própria aba (como o do Tactiq), com a transcrição ao vivo, uns 1 a 2 s depois de cada frase, quem falou e o horário. O áudio é cortado nas pausas da fala, então as frases saem inteiras. É uma prévia: a transcrição final, mais precisa, vem ao parar.
  - No cabeçalho: **minimizar** (vira uma bolinha que traz o painel de volta), **abrir em janela separada** e **fechar** (a gravação continua).
  - **Notas:** a caixa embaixo é sua. Anote nomes, prazos, o que importa. Elas entram na ata (a IA as usa para acertar a grafia de nomes e destacar o que você marcou) e ficam na página de transcrições.
  - Se a página não aceitar o painel, ele abre como janela separada. **Mostrar a transcrição ao vivo** no popup liga e desliga, e **Abrir a transcrição ao vivo** reabre o painel se você o fechar. Se o servidor não responder, o painel avisa e a gravação continua. O painel abre sozinho ao começar a gravar; se a página não deixar, uma janela abre ao lado e o popup mostra o motivo.
- **Use fones de ouvido.** Sem fone, o microfone também capta o alto-falante. O servidor descarta o que for repetição do que saiu da aba, mas fone é mais limpo.
- A gravação é salva no disco do navegador a cada 10 s. Se o servidor estiver desligado ao parar, ou o navegador cair, o áudio não se perde: a reunião aparece com **Tentar de novo**.
- Fechar a aba da reunião encerra a gravação e gera a ata com o que foi gravado.
- Se algo não aparecer, abra o popup: **O que aconteceu na última gravação** lista cada etapa (captura da aba, microfone, painel, servidor), com um botão para copiar.
- Uma reunião de 1 h tem uns 30 MB e leva alguns minutos para transcrever numa placa NVIDIA. Enquanto isso, mensagens de voz do WhatsApp esperam a vez.
- Só Chrome e Brave. O Firefox não tem a captura de aba que isso usa; lá a seção Reunião nem aparece.
- Modelos de ata: reunião padrão, daily, projeto, retrospectiva, cliente e aula, em `server/templates/`. Para criar o seu, copie um `.json` da pasta e mude; vale na hora, sem reiniciar. Os cinco primeiros são adaptados do [Meetily](https://github.com/Zackriya-Solutions/meetily) (MIT); veja `server/templates/CREDITS.md`.
- Com o Ollama, desligamos o "pensamento" do modelo (`think: false`): em transcrição longa, modelos que pensam gastavam o contexto raciocinando e a ata saía vazia.

## Notas

- O modelo Whisper baixa na primeira transcrição (`large-v3-turbo` ≈ 1,6 GB). Depois ele é carregado já no boot do servidor e fica na memória, então a primeira mensagem de voz não paga essa espera.
- Na GPU a transcrição usa inferência em lote (`BatchedInferencePipeline`): cerca de 4x mais rápida que o modo sequencial, mesmo texto. Medido numa RTX 5060 Ti: 4min25s de áudio em 2,8s. Ajuste `ESCUTA_BATCH` no `.env` se a placa tiver pouca VRAM.
- O log do servidor mostra o tempo de cada transcrição, útil pra saber se está indo na GPU ou na CPU.
- Para transcrever, a extensão aperta o botão de reproduzir da própria mensagem e pausa em seguida. Isso pode marcar o áudio como ouvido.
- O WhatsApp muda o HTML de vez em quando. Quando a conversa tem áudios e a extensão não reconhece nenhum, o ícone dela ganha um **!** vermelho. No popup, **Copiar diagnóstico** copia os nomes de ícones e rótulos da página (nunca o texto das mensagens), que é o que basta para atualizar os seletores. Eles ficam nos objetos `SEL` e `ICON` no topo de `extension/content.js`.
- Áudios de até 90 s são transcritos no modo sequencial, mais completo; os mais longos usam o lote, uns 4x mais rápido. Ajuste com `ESCUTA_SEQUENCIAL` no `.env`.
- O servidor só aceita conexões locais e só de extensões do navegador; com `ESCUTA_TOKEN` ele também exige o segredo.
- Rodando o servidor no WSL: funciona pelo encaminhamento de `localhost` do WSL2, mas sem acesso à GPU por padrão. Rodar nativo no Windows é mais simples.
- Teste rápido do servidor: `python server\server.py --selfcheck`.
- Teste completo (sobe o servidor numa porta livre, transcreve de verdade e confere o streaming): `server/.venv/bin/python server/test_server.py` no Mac, `server\.venv\Scripts\python server\test_server.py` no Windows.

## Identidade visual

Logo, símbolo, banner e ícones ficam em `brand/`. Cores: âmbar `#FFC53D`, tinta `#0E1424`, sinal `#3347FF`. Fontes: Bricolage Grotesque, Instrument Sans e JetBrains Mono (empacotadas em `extension/fonts`).
