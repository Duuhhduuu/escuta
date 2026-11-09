# Escuta Legendas (Meet)

Guarda a transcrição do Google Meet **pelas legendas que o próprio Meet gera**, sem gravar áudio e sem precisar da GPU. Tudo fica no navegador: sem conta, sem servidor, sem telemetria.

Como funciona, o formato das mensagens e os pontos frágeis: [docs/analise-tactiq.md](../docs/analise-tactiq.md).

## Instalar (Brave ou Chrome)

```bash
cd captions-meet
npm install
npm run build
```

Depois, em `brave://extensions` (ou `chrome://extensions`): ligue o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha a pasta `captions-meet`.

Entre em uma chamada do Meet (código no formato `abc-defg-hij`): as legendas começam a ser guardadas sozinhas, mesmo com a legenda desligada na tela do Meet. Quem manda é o servidor do Meet; se ele não entregar, o popup mostra o estado (`falhou`, `descartado: …`).

O ícone da extensão lista as reuniões guardadas, com **Exportar .md**, **Exportar .txt** e **Apagar**.

## Permissões

Só `storage` e o endereço `meet.google.com` das salas. Nada sai do navegador.

## O que tem aqui

| Pasta | O que faz |
|---|---|
| `src/page/hook.ts` | gancho do `RTCPeerConnection` (mundo da página): vê os canais, abre `captions_v2` e `captions`, confirma cada fala (ACK), recria o canal que cai |
| `src/page/protocol.ts` | leitura/escrita do protobuf, nomes dos participantes, gzip |
| `src/page/dedupe.ts` | deduplicação por id + versão, fusão de ids repetidos, lotes de 500 ms |
| `src/content/bridge.ts`, `store.ts` | ponte página → content script (`postMessage` com origem e etiqueta checadas) e gravação por sala |
| `src/export.ts`, `src/popup.ts` | exportação `.txt`/`.md` e a lista do popup |

## Desenvolvimento

```bash
npm run typecheck   # TypeScript
npm test            # 28 testes sem navegador (protocolo, dedupe, gravação, exportação, gancho com conexão falsa)
npm run test:e2e    # teste de verdade: Chromium + WebRTC real, sala falsa em https://meet.google.com
npm run watch       # recompila ao salvar
```

O teste `e2e` precisa de um Chromium que aceite `--load-extension` (o Chrome de marca não aceita; o do Playwright serve; defina `CHROMIUM` se necessário) e do `openssl`.

## Limites

- Usa um protocolo interno do Meet, sem documentação pública: pode mudar sem aviso.
- Ainda **não** troca o idioma da legenda (fica no padrão da sessão) nem captura o chat.
- O que o Meet transcreve é o que vale: sem pontuação em alguns idiomas, idioma errado, nome do participante ausente.
- Validado até aqui com testes e uma chamada WebRTC simulada. **Falta provar numa chamada real do Meet**, principalmente se a legenda chega com a legenda desligada na tela.
