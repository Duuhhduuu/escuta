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
- Ao parar, o gravador **termina o texto ao vivo** (fecha a frase pendente e espera a fila esvaziar, até 25 s) e a reunião passa a `processing`.
- **A ata sai na hora, a partir do texto ao vivo**, já com os nomes de quem falou e sem o eco do microfone. A transcrição completa do áudio **não** é refeita: seria retrabalho.
- A transcrição completa só roda como reserva: se o texto ao vivo ficou vazio, quase vazio para a duração, ou **perdeu alguma janela** (`liveLost`). Um trecho que falha tenta de novo até 3 vezes antes de ser dado como perdido.
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
- **Texto ao vivo com buraco ou vazio:** no fim, a transcrição completa do áudio assume, como antes. Se ela falhar, a reunião fica "falhou" e "Tentar de novo" refaz.
- **Modelo de resumo fora do ar:** o texto fica salvo e a reunião termina sem ata; "Refazer ata" gera quando o modelo voltar.
- **Limite:** 20 mil falas guardadas na reunião enquanto grava (horas de conversa).

## Validação

- Implementação: os 40 testes automatizados passaram antes do merge; a tela foi conferida com uma reunião "Ao vivo" simulada.
- Pendente: validação numa chamada real. Confirmar que a reunião aparece como "Ao vivo", a transcrição cresce durante a chamada e a ata é gerada ao parar ou sair do Meet.
- Pendente: fechar o navegador durante uma gravação e confirmar que o texto já salvo permanece e que "Tentar de novo" transcreve o áudio restante.

## Fora do escopo

- Ata reescrita durante a reunião, notas automáticas separadas, marcações com horário.
- Botões de ação rápida (e-mail de acompanhamento, tarefas por pessoa) e conversa entre várias reuniões.
- Agenda, pastas e compartilhamento.
