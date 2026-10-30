# Reunião que se salva sozinha

Data: 2026-10-29. Origem: o Granola como referência, adaptado ao que a pessoa pediu.

## O que a pessoa quer

- Participar da reunião sem fazer nada na Escuta. Anotar é possível, nunca necessário.
- A **transcrição ser salva sozinha enquanto a reunião acontece**.
- A **ata ser gerada sozinha no fim**, sem clicar em nada.
- Depois, abrir a reunião e **conversar com a IA** sobre ela.

Decidido com a pessoa: a ata **não** vai sendo reescrita durante a reunião. Só a transcrição é salva ao longo do caminho. A ata sai uma vez, no fim.

## O que já existia e fica como está

- Gravação automática das chamadas do Meet (opção `autoMeet`) e fim automático quando a chamada acaba ou a aba fecha, com o "Desfazer" de alguns segundos.
- Ata final gerada depois da transcrição completa (`processMeeting` → `/minutes`).
- Campo de notas e objetivo, opcionais.
- Reunião aberta com Resumo, abas Perguntar/Ata/Transcrição e chat (`/ask`).

## O que muda

### A reunião existe desde o primeiro segundo

Antes, a reunião só entrava no histórico quando a pessoa parava. Agora `startMeeting` a cria ao começar, com `status: "recording"` e `provisional: true`.

- Cada trecho do texto ao vivo é gravado na reunião (`keepLiveLines`, em fila, para um não pisar no outro). Se o navegador cair, sobra a reunião com o texto até ali.
- Ao parar, a reunião passa a `processing` mantendo o texto ao vivo. A transcrição completa o substitui (`provisional: false`) e a ata é gerada.
- Descartar a gravação apaga também a reunião criada ao começar.
- Gravação cortada no meio (navegador fechou): a reunião vira "falhou", com o texto ao vivo preservado. O áudio que ficou no disco ainda pode ser transcrito com "Tentar de novo".
- `provisional` impede que "Tentar de novo" trate o texto ao vivo como se fosse a transcrição completa e pule a transcrição do áudio.

### Interface

- **Histórico:** reunião gravando mostra "Ao vivo" (ponto piscando, sem animação com movimento reduzido) e abre normalmente.
- **Reunião aberta, gravando:** aviso "Gravando. A transcrição é salva sozinha e a ata sai quando a reunião terminar." A transcrição e o chat já funcionam sobre o que foi dito até ali.

### Sem cliques obrigatórios

- Parar continua possível, mas a chamada que termina e a aba que fecha já param e geram a ata.
- `autoMeet` continua **desligado até a pessoa ligar uma vez**: ligar grava os participantes sem aviso na chamada, e essa escolha é dela. Depois de ligado, não precisa clicar mais.

## Servidor

Nenhuma mudança.

## Falhas e limites

- **Texto ao vivo desligado:** a reunião existe desde o começo, mas sem texto até parar. Como antes.
- **Transcrição final falha:** a reunião fica "falhou" com o texto ao vivo guardado. Hoje ele não vira ata sozinho; "Tentar de novo" refaz a transcrição do áudio.
- **Limite:** 20 mil falas guardadas na reunião enquanto grava (horas de conversa).

## Testes

- Sintaxe e conferência de tela com reunião "Ao vivo" simulada.
- Conferência manual numa chamada real: a reunião aparece como "Ao vivo", o texto cresce no histórico, parar gera a ata, fechar o navegador no meio deixa o texto salvo.

## Fora do escopo

- Ata reescrita durante a reunião, notas automáticas separadas, marcações com horário.
- Botões de ação rápida (e-mail de acompanhamento, tarefas por pessoa) e conversa entre várias reuniões.
- Agenda, pastas e compartilhamento.
