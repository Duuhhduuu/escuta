# Escuta

Extensão pessoal para o Chrome. Adiciona um botão **Transcrever** em cada mensagem de voz do WhatsApp Web e, depois, **Resumir**. Tudo roda no seu Mac.

```
WhatsApp Web ── extensão ──> servidor local (127.0.0.1:8765) ──> mlx-whisper (transcrição)
                                                             └─> Ollama (resumo)
```

## Instalação

1. Servidor (uma vez):
   ```bash
   cd server && ./setup.sh
   ```
2. Ollama para os resumos:
   ```bash
   brew install --cask ollama
   ollama pull qwen2.5:7b
   ```
3. Extensão: abra `chrome://extensions`, ligue o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha a pasta `extension`.

### Firefox

1. Abra `about:debugging#/runtime/this-firefox` e clique em **Carregar extensão temporária**. Escolha `extension/manifest.json`.
2. Abra `about:addons`, entre em Escuta, aba **Permissões**, e ative o acesso a `127.0.0.1`. O Firefox não concede isso sozinho.
3. A extensão temporária some ao fechar o Firefox. Para instalar de forma permanente é preciso assiná-la (Mozilla, distribuição própria, grátis) ou usar o Firefox Developer Edition.

## Uso

1. Inicie o servidor e deixe a janela aberta:
   ```bash
   cd server && ./start.sh
   ```
2. Abra o WhatsApp Web. Cada mensagem de voz ganha um botão **Transcrever**.
3. Depois da transcrição, use **Resumir** ou **Copiar**.

O ícone da extensão mostra o estado do servidor, do Whisper e do Ollama e deixa trocar idioma e modelos.

## Notas

- O modelo Whisper baixa na primeira transcrição (`turbo` ≈ 1,6 GB).
- Para transcrever, a extensão aperta o botão de reproduzir da própria mensagem e pausa em seguida. Isso pode marcar o áudio como ouvido.
- O WhatsApp muda o HTML de vez em quando. Os seletores ficam no objeto `SEL` no topo de `extension/content.js`.
- O servidor só aceita conexões locais e só de extensões do Chrome.
