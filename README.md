# Escuta

Extensão pessoal para o Chrome. Adiciona um botão **Transcrever** em cada mensagem de voz do WhatsApp Web e, depois, **Resumir**. Tudo roda na sua máquina.

```
WhatsApp Web ── extensão ──> servidor local (127.0.0.1:8765) ──> Whisper (transcrição)
                                                             └─> Ollama ou Gemini (resumo)
```

Transcrição: **faster-whisper** no Windows/Linux (usa a GPU NVIDIA quando existe, senão CPU) e **mlx-whisper** no Mac com Apple Silicon. O `setup` escolhe sozinho.

## Instalação — Windows

1. [Python 3](https://python.org) instalado, com **Add Python to PATH** marcado.
2. Servidor (uma vez), na pasta `server`, dê dois cliques em **`setup.bat`**.
3. Ollama para os resumos: baixe em [ollama.com/download](https://ollama.com/download) e rode no terminal:
   ```
   ollama pull qwen2.5:7b
   ```
   (Ou pule o Ollama e use o Gemini — veja abaixo.)
4. Extensão: abra `chrome://extensions`, ligue o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha a pasta `extension`.

Com placa NVIDIA o `setup.bat` instala também o cuBLAS/cuDNN (uns 700 MB) e a transcrição usa CUDA. Essas DLLs vêm pelo pip e não ficam no PATH do Windows; o servidor as registra sozinho no boot. Se mesmo assim a GPU falhar, ele refaz a transcrição na CPU e avisa no log — mais lento, mas não quebra. Para forçar um modo, use `ESCUTA_DEVICE=cpu` ou `cuda` no `.env`.

## Instalação — Mac / Linux

1. Servidor (uma vez):
   ```bash
   cd server && ./setup.sh
   ```
2. Ollama: `brew install --cask ollama` e `ollama pull qwen2.5:7b`.
3. Extensão: igual ao passo 4 acima.

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

1. Gere um segredo: `python -c "import secrets;print(secrets.token_urlsafe(24))"`
2. Ponha em `server/.env` como `ESCUTA_TOKEN=...` e reinicie o servidor.
3. Cole o mesmo texto no campo **Token do servidor** no ícone da extensão e salve.

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

O ícone da extensão mostra o estado do servidor, do Whisper (e qual motor está em uso) e do Ollama, e deixa trocar idioma e modelos.

## Notas

- O modelo Whisper baixa na primeira transcrição (`large-v3-turbo` ≈ 1,6 GB). Depois ele é carregado já no boot do servidor e fica na memória, então a primeira mensagem de voz não paga essa espera.
- Na GPU a transcrição usa inferência em lote (`BatchedInferencePipeline`): cerca de 4x mais rápida que o modo sequencial, mesmo texto. Medido numa RTX 5060 Ti: 4min25s de áudio em 2,8s. Ajuste `ESCUTA_BATCH` no `.env` se a placa tiver pouca VRAM.
- O log do servidor mostra o tempo de cada transcrição, útil pra saber se está indo na GPU ou na CPU.
- Para transcrever, a extensão aperta o botão de reproduzir da própria mensagem e pausa em seguida. Isso pode marcar o áudio como ouvido.
- O WhatsApp muda o HTML de vez em quando. Os seletores ficam no objeto `SEL` no topo de `extension/content.js`.
- O servidor só aceita conexões locais e só de extensões do navegador; com `ESCUTA_TOKEN` ele também exige o segredo.
- Rodando o servidor no WSL: funciona pelo encaminhamento de `localhost` do WSL2, mas sem acesso à GPU por padrão. Rodar nativo no Windows é mais simples.
- Teste rápido do servidor: `python server\server.py --selfcheck`.
