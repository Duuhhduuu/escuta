# Como a Tactiq pega as legendas do Google Meet

Análise de leitura da extensão Tactiq 3.1.7473 (instalada no Brave), feita para entender o **padrão técnico** e reimplementá-lo do zero. Nada do código deles foi copiado: o que está aqui são fatos sobre o funcionamento (arquitetura, canais, campos do protocolo) descritos com palavras nossas.

> Aviso: o que a Tactiq lê é o **protocolo interno do Meet**, sem documentação pública. Pode mudar sem aviso (ver "Pontos frágeis").

## 1. A ideia em uma frase

O Meet já gera as legendas no servidor do Google e as entrega pelo próprio WebRTC, em canais de dados (`RTCDataChannel`) da conexão da chamada. A Tactiq **espiona esses canais** e, se o Meet não abriu o de legendas, **abre um por conta própria**. Não toca no áudio nem precisa que a legenda apareça na tela.

## 2. Arquitetura

```
 página do Meet (mundo "MAIN")                       mundo isolado da extensão
 ┌───────────────────────────────────────────┐      ┌──────────────────────────────┐
 │ rtcinjector.js  (content script,          │      │ content.js                    │
 │ document_start) cria <script src=         │      │  - ouve "tactiq-message"      │
 │ chrome.runtime.getURL(inline.js)>         │      │  - guarda e sincroniza        │
 │            │                              │      │  - manda comandos             │
 │            ▼                              │      │    "tactiq-rtc" de volta      │
 │ googlemeet.inline.js (roda como a página) │      └──────────────▲───────────────┘
 │  ├─ troca window.RTCPeerConnection        │                     │
 │  │    └─ createDataChannel / "datachannel"│    CustomEvent no   │
 │  ├─ canais: collections, media-session,   │    <html> (detail)  │
 │  │          meet_messages, captions(_v2)  │─────────────────────┘
 │  ├─ decodifica protobuf                   │
 │  └─ deduplica por id + versão             │
 └───────────────────────────────────────────┘
            ▲ (iframe do Google Chat)
 chatgoogle.main.inline.js: troca fetch/XHR, captura create_topic
 └─ window.parent.postMessage("tactiq-chat-captured") ──► content.js
```

Fluxo de dados: **página → injetor → gancho WebRTC → evento DOM → content script → armazenamento**. No caso deles o armazenamento é um estado em memória (Redux) sincronizado com a nuvem da Tactiq; para nós será local.

## 3. Manifest e injeção

- Manifest V3. Permissões: `storage`, `scripting`, `activeTab`, `alarms`, entre outras; hosts `*://meet.google.com/*-*-*` (só salas com código `abc-defg-hij`).
- Dois content scripts na mesma sala: `content.js` (mundo isolado, UI e dados) e `rtcinjector.js` em **`document_start`**.
- O injetor cria um `<script>` com `src = chrome.runtime.getURL("googlemeet.inline.js")` e o põe **no início** do `<head>`. Esse arquivo precisa estar em `web_accessible_resources`. É assim que o código roda no **mundo da própria página** e enxerga o `RTCPeerConnection` real.
- Há uma trava por `window.tactiqrtc` para não injetar duas vezes.
- Equivalente moderno: no manifest, `"world": "MAIN"` no content script. Dispensa `web_accessible_resources` e injeção por `<script>` (Chrome 111+).

## 4. O gancho WebRTC (`googlemeet.inline.js`)

### 4.1 Troca do construtor
- `window.RTCPeerConnection` é substituído por um embrulho que cria a conexão real, observa `connectionstatechange` (limpa as referências quando `closed`/`failed`) e escuta o evento **`datachannel`** (canais abertos pelo outro lado).
- `RTCPeerConnection.prototype.createDataChannel` também é trocado, para ver os canais que o **Meet** cria localmente.
- `RTCDataChannel.prototype.send` é trocado para olhar o que o Meet **envia** no canal `media-session` (ver idioma, 4.5).

### 4.2 Canais que importam

| Canal | Quem abre | Para que serve |
|---|---|---|
| `captions_v2` | o Meet ou a extensão | legendas atuais (um pacote por fala, com versões) |
| `captions` | o Meet ou a extensão | legendas no formato antigo (ainda tratado) |
| `collections` | o Meet (remoto) | informações da sala; traz o **nome de cada participante** (id do aparelho → nome) e é o sinal de "esta é a conexão principal" |
| `meet_messages` | o Meet | o chat da chamada |
| `media-session` | o Meet | controle da sessão de mídia; é por onde se troca o **idioma** da legenda |

Qualquer outro canal com "caption", "transcri" ou "subtitle" no nome é só registrado como inesperado.

### 4.3 Abrir o canal de legendas por conta própria
1. O content script manda o evento `tactiq-rtc` com `{type: "con"}`.
2. A página espera (até ~5 s, em passos de 100 ms) a conexão marcada pelo canal `collections`.
3. Nessa conexão, chama `createDataChannel("captions", …)` e `createDataChannel("captions_v2", …)` com `ordered: true`, `maxRetransmits: 10` e um **`id` explícito** vindo de um contador que começa alto (~50001), para não colidir com os ids do Meet.
4. O Meet, ao ver o canal aberto, passa a mandar as legendas por ele. Pelo código, a extensão não liga as legendas na tela para isso; que o Meet entregue **mesmo com a legenda desligada na tela** é uma **inferência** (o código não prova), e é a primeira coisa a validar na prática.
5. Cuidados: não abrir `captions_v2` duas vezes na mesma conexão (um `WeakSet` marca quem já tem), e um teto de canais "inesperados" (5).

### 4.4 Reabrir quando cai
- Um verificador a cada ~1 s olha se o canal está `closing`/`closed` e a conexão ainda viva (nem `closed` nem `failed`); se estiver, **recria** o canal com os mesmos parâmetros.
- Há checagem de saúde 5 s depois de abrir: sem canal aberto, avisa o content script (`google-meet-captions-failed`).
- O content script também pode pedir "peça as legendas de novo" (por exemplo, depois de a chamada mudar de modo ponto-a-ponto) e "recupere o canal".

### 4.5 Idioma da legenda
- A legenda sai no idioma configurado **no servidor da sessão de mídia**. A Tactiq o guarda no `localStorage` (chave `tactiq-gmeet-caption-language`) e também lê o idioma que o próprio Meet gravou.
- Para trocar, ela **envia no canal `media-session`** a mesma mensagem que a interface do Meet enviaria (um protobuf com contadores de sequência), junto de dois reconhecimentos, e espera a confirmação (até 5 s).
- Se falhar, cai para o caminho pela interface, ou reafirma o idioma depois. Também existem chamadas HTTP internas (`media_sessions/modify` e `/query`) usadas em outro caminho.
- O gancho de `send` também **reescreve** a mensagem de idioma que o próprio Meet manda, se for diferente do desejado.

## 5. Formato das mensagens (decodificado)

Tudo é **protobuf**. Antes de decodificar: se os 3 primeiros bytes são `1F 8B 08` (gzip), descomprime (às vezes depois de pular 3 bytes de prefixo).

### 5.1 `captions_v2` (o formato atual)
```
Pacote            { 1: Fala }
Fala              { 1: utteranceId (int64)   2: version (int64)   3: Legenda }
Legenda           { 3: text (string)   4: languageCode (string)   6: deviceId (string) }
```
- Sem `Fala`, sem `deviceId` ou sem `utteranceId` → descartado.
- Id estável da fala: `utteranceId + "/@" + deviceId`. A versão sobe a cada revisão do texto.
- **Reconhecimento (ACK):** a Tactiq responde, no mesmo canal, cada fala recebida (só quando o canal foi aberto por ela):
```
Ack  { 1: Corpo }     Corpo { 1: Ref }     Ref { 1: utteranceId   2: version   3: uint32 = 1 }
```

### 5.2 `captions` (formato antigo)
```
Embrulho   { 1: Mensagem   2: string "desconhecido" (se presente = só controle, ignorar) }
Mensagem   { 1: deviceId (string)  2: messageId (int64)  3: messageVersion (int64)  6: text (string)  8: langId (int64) }
```
Só vale se vierem `deviceId`, `messageId`, `messageVersion` e `langId`. O `langId` é um número que mapeia para um código como `pt-BR` (tabela própria).

### 5.3 Quem está falando
- O `deviceId` da legenda é do tipo `spaces/<sala>/devices/<id>`.
- O nome vem do canal `collections`: mensagens com `{1: deviceId (string), 2: deviceName (string)}` formam o mapa **id → nome**. A página dispara um evento `deviceinfo` a cada novo nome.
- "Você" (o próprio aparelho) é descoberto por um `spaces/…/devices/…` visto nos dados; vira o evento `self-device`.

### 5.4 Chat
- **Dentro da chamada (`meet_messages` / `collections`):** a Tactiq procura no binário as marcas de texto `/messages/` e `spaces/`, lê um tamanho em varint e extrai o texto. Heurística, sem schema formal. Há também um schema formal para outro formato do chat.
- **Chat do Google Chat (iframe):** `chatgoogle.main.inline.js` troca `window.fetch` e `XMLHttpRequest`. Quando o caminho termina em `/api/create_topic`, lê o **corpo da requisição** (um JSON: o texto é o 2º elemento da lista) e a **resposta** (que começa com `)]}'`; o id da mensagem fica em `[0][1][1]`). Então avisa a página pai com `postMessage` (`tactiq-chat-captured`, origem checada).

## 6. Dedupe e atualização (parcial vira final)

- **Chave:** `messageId` (já composto, ver 5.1). Regra: um item novo só **substitui** o existente se a versão for **maior ou igual**; senão é ignorado.
- **Lote de 500 ms:** as mensagens entram num buffer; a cada 500 ms o buffer inteiro vira **um** evento `tactiq-message` com `type: "speech"` e `messages: [...]`. Dentro do lote vale a regra acima. O consumidor ainda precisa fazer a mesma regra ao gravar (o texto cresce com o tempo).
- **Fusão de ids repetidos:** como o Meet às vezes reenvia a mesma fala com outro id, existe uma camada extra: (a) um mapa "id novo → id original" por até 30 s; (b) uma assinatura `deviceId | versão | texto` vista nos últimos 700 ms; se bater, o novo id é trocado pelo original. Os dois mapas são podados (máx. ~512 entradas).

## 7. Eventos entre página e content script

Tudo por `CustomEvent` disparado em `document.documentElement` (a página e o mundo isolado compartilham o DOM):

| Sentido | Evento | `detail` |
|---|---|---|
| página → content | `tactiq-message` | `{type: "speech", messages: [...]}`, `deviceinfo`, `self-device`, `meeting-id`, `language-changed`, `google-meet-captions-failed`, `debug`, … |
| content → página | `tactiq-rtc` | `{type: "con"}`, `checkCaptions`, `setGoogleMeetLanguage`, `requestGoogleMeetCaptionsAgain`, `recoverGoogleMeetCaptionsChannel`, … |
| content → página | `tactiq-content-ready` | aviso de que o content script já escuta; antes disso a página **enfileira** os avisos (`pendingLogs`) e despeja tudo quando chega |

(`tactiq-captions-parsed` e similares são nomes de telemetria interna, sem função para nós.)

No content script, cada mensagem de `speech` ganha o nome do participante (pelo mapa id → nome), e o chat capturado ganha um id próprio (`<timestamp>/<aparelho>`).

## 8. Pontos frágeis (o que quebra se o Google mudar algo)

1. **Rótulos dos canais** (`captions_v2`, `collections`, `media-session`, `meet_messages`): renomear qualquer um quebra a detecção.
2. **Números dos campos do protobuf** (5.1 a 5.3). Não há schema público; um campo novo ou renumerado quebra a leitura **sem erro visível** (a fala some).
3. **O servidor deixar de aceitar o canal aberto pela extensão** (parâmetros, ids, ordem de abertura). Hoje o Meet entrega as legendas assim; se exigir outra coisa, não vem nada.
4. **O ACK por fala.** Se o Meet passar a exigir confirmação diferente, reenvia ou corta o fluxo.
5. **O idioma pela mensagem de `media-session`**: depende de contadores de sequência e do formato exato; é o trecho mais acoplado.
6. **Chat por varredura de bytes** (`/messages/`, `spaces/`): heurística, pode ler lixo ou perder mensagem.
7. **Chat do Google Chat** depende do caminho `/api/create_topic` e do prefixo `)]}'`.
8. **O gancho do `RTCPeerConnection`:** o código do Meet pode guardar o construtor original antes do gancho (precisa rodar em `document_start`), usar outra janela (iframe) ou outra API.
9. **A conexão "principal"** é reconhecida pelo canal `collections`; mudar isso apaga o ponto de partida.
10. **Chamadas HTTP internas** (`/hangouts/v1_meetings/...`, `$rpc/google.rtc...`): ficam fora do plano por serem as mais instáveis e exigirem sessão.
11. **Texto das legendas** é o que o Meet produz: sem pontuação, idioma errado ou nome "Você" quando a conta não tem nome, por exemplo. Não há como melhorar do nosso lado.
12. Possível **política do Google** contra clientes não oficiais do protocolo; usar só com a própria conta e com os participantes avisados.

## 9. O que vale levar para o Escuta

- **Texto sem Whisper:** o texto vem pronto, com **nome de quem falou** e fala por fala, de graça, sem GPU.
- **Independe do áudio:** a captura de áudio do Escuta depende de como o Meet entrega o som (já deu problema em chamada grande). As legendas não.
- **Custo:** depende do Google gerar as legendas (idiomas suportados) e de um protocolo não oficial.
- Dá para usar as duas fontes juntas: legendas como transcrição principal e o áudio/Whisper como reserva.
