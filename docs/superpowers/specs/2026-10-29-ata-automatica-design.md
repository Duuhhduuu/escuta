# Ata automática: a reunião se escreve sozinha

Data: 2026-10-29. Origem: o Granola como referência, adaptado ao que a pessoa pediu.

## O que a pessoa quer

- Participar da reunião sem fazer nada na Escuta. Anotar é possível, nunca necessário.
- A ata ir sendo salva **sozinha, durante** a reunião, sem esperar o clique no fim.
- Depois, abrir a reunião e **conversar com a IA** sobre ela.

## O que já existe e fica como está

- Gravação automática das chamadas do Meet (opção `autoMeet`) e fim automático quando a chamada acaba ou a aba fecha (`meetCall`, `onRemoved`), com o "Desfazer" de alguns segundos.
- Texto ao vivo (`/live`) guardado em `chrome.storage.session` (`live`).
- Campo de notas e objetivo (opcionais). Continuam opcionais e sem horário nem marcação.
- Reunião aberta com Resumo, abas Perguntar/Ata/Transcrição e chat (`/ask`).
- Ata final gerada depois da transcrição completa (`processMeeting` → `/minutes`).

## O que muda

### 1. A reunião existe desde o primeiro segundo

Hoje a reunião só é gravada no histórico quando a pessoa para (`stopMeeting` → `saveMeeting`). Passa a ser criada **ao começar**, com `status: "recording"`, e atualizada enquanto grava. Se o navegador cair no meio, sobra uma reunião com o texto e a ata parcial, e não só pedaços de áudio.

Campos novos da reunião:

| Campo | Para quê |
| --- | --- |
| `status: "recording"` | Aparece no histórico como "Ao vivo", aberta e consultável. |
| `segments` | Já existe. Durante a gravação recebe o texto ao vivo, já com os nomes. A transcrição final o substitui. |
| `minutes` | Já existe. Durante a gravação guarda o rascunho da ata. |
| `draftAt` | Quando o rascunho foi escrito. Some quando a ata final chega. |

### 2. Rascunho da ata a cada poucos minutos

Um ciclo no service worker (`draftMinutes`), com estas regras:

- Roda a cada **3 minutos** e uma vez ao pausar. Não roda se houver menos de **8 falas novas** desde o último rascunho.
- Só roda com a fila do texto ao vivo vazia, para o modelo de resumo não competir com o Whisper pela placa de vídeo. Se estiver ocupada, tenta no ciclo seguinte.
- Usa o mesmo caminho da ata final (`/minutes`, com o modelo, o objetivo e as notas da pessoa). A entrada é o texto ao vivo acumulado.
- Se o servidor falhar ou demorar mais de 90 s, **mantém o rascunho anterior** e tenta de novo no próximo ciclo. Nunca apaga nem esvazia a ata.
- Salva sempre pela `patchMeeting`, que relê a reunião antes de gravar, para não sobrescrever o que mudou no meio.

Ao parar, o fluxo atual não muda: transcrição completa, ata final, que **substitui** o rascunho. Se a final falhar, o rascunho continua lá e a reunião não fica vazia.

### 3. Sem cliques obrigatórios

- O botão "Parar e gerar a ata" continua, mas é opcional. A chamada que termina e a aba que fecha já param e geram a ata.
- `autoMeet` continua **desligado até a pessoa ligar uma vez**. Ligar grava os participantes sem aviso na chamada, e essa escolha é da pessoa. O popup oferece a chave logo na primeira tela (ver "Interface"). Não liga sozinho.

### 4. Conversar com a IA

O chat já funciona na reunião aberta. Passa a funcionar também **durante** a gravação, sobre o que já foi dito e o rascunho da ata. Nenhuma mudança no servidor.

## Interface

- **Histórico:** reunião com `status: "recording"` mostra "Ao vivo" no lugar da duração final e abre normalmente. A ata e a transcrição mostram um selo "Rascunho · atualizado às 21:17" enquanto `draftAt` existir.
- **Painel ao vivo:** uma linha discreta no rodapé: "Ata salva às 21:17". Sem botão novo.
- **Popup, primeira tela:** quando `autoMeet` está desligado, um aviso curto com a chave "Gravar sozinho as chamadas do Meet", explicando que a pessoa avisa os participantes.

## Servidor

Nenhuma rota nova. O `/minutes` já aceita texto, modelo, objetivo e notas, e o rascunho o reaproveita. Fica de fora qualquer indexação ou rota nova.

## Falhas e limites

- **Modelo de resumo fora do ar:** o rascunho não se atualiza, a gravação segue, a ata final tenta de novo quando a pessoa parar.
- **Nomes de quem fala** (quando disponíveis) entram nos segmentos do rascunho.
- **Pausa:** o rascunho roda uma vez ao pausar e não roda enquanto pausado.
- **Texto ao vivo desligado:** sem texto ao vivo não há rascunho. A reunião só ganha ata ao parar, como hoje.

## Testes

- Lógica pura de quando rodar (`shouldDraft`: intervalo, falas novas, fila ocupada, pausa) extraída do service worker e testada sem navegador.
- Teste de que um rascunho que falha **não apaga** o anterior.
- Teste de que a ata final substitui o rascunho e remove `draftAt`.
- Conferência manual numa chamada real do Meet, com a lista do que olhar: reunião "Ao vivo" aparece, rascunho atualiza, queda do navegador deixa texto e ata parcial.

## Fora do escopo (decidido)

- Notas automáticas separadas da ata, marcações com horário e a seção "O que você marcou". O rascunho da ata já cumpre o papel de "a IA vai escrevendo".
- Botões de ação rápida (e-mail de acompanhamento, tarefas por pessoa) e conversa entre várias reuniões: ficam para uma próxima rodada.
- Integração com agenda, pastas e compartilhamento.
