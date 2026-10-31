// Quem está falando na chamada do Meet. O áudio dos participantes vem misturado numa pista só, então
// os nomes saem da própria tela do Meet, sem ligar nada: os quadros dos participantes trazem o nome
// (e, numa chamada de duas pessoas, só há um nome possível). Com a opção "nomes pelas legendas" ligada
// ele lê também as legendas, que dizem exatamente quem fala. Os avisos seguem para a extensão, que
// depois cruza cada um com a hora do trecho da transcrição.
(() => {
  if (window.__escutaSpeakers) return;
  window.__escutaSpeakers = true;

  const SELF = /^(voc[eê]|you|tu|usted)$/i; // o Meet chama quem grava de "Você": isso já é a pista do microfone
  const CAPTIONS = /caption|legenda|subt[ií]tulo|sous-titre|untertitel/i;
  const CC_BUTTON = /caption|legenda|subt[ií]tulo|sous-titre|untertitel/i;
  const POLL_MS = 250;
  const REPEAT_MS = 700; // enquanto a mesma pessoa fala, reafirma de tempos em tempos

  let useCaptions = false; // opcional: nome pelas legendas do Meet (escondidas) em vez da animação do quadro
  let running = false;
  let timer = 0;
  let tries = 0;
  let seen = { name: "", text: "", at: 0 };

  // As legendas precisam estar ligadas para eu ler os nomes, mas não precisam aparecer: a barra sai
  // da tela (sem display:none, que faz o Meet parar de atualizar). Por folha adotada, que a política
  // de segurança do Meet aceita.
  const HIDE = "data-escuta-cc";
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`[${HIDE}]{position:fixed!important;left:-10000px!important;top:0!important;opacity:0!important;pointer-events:none!important}`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // sem folha adotada, as legendas ficam visíveis: o resto funciona igual
  }

  // Sobe da região de legendas até a barra inteira (idioma, tamanho, ajustes), sem pegar a chamada.
  function hideBar(box) {
    if (box.closest(`[${HIDE}]`)) return;
    let bar = box;
    for (let i = 0; i < 4; i++) {
      const parent = bar.parentElement;
      if (!parent || parent === document.body) break;
      if (parent.getBoundingClientRect().height > innerHeight * 0.5) break;
      if (parent.querySelector('[role="toolbar"], button[jsname="CQylAd"]') || parent.querySelector('button[aria-label][data-tooltip*="Sair"], button[aria-label*="Sair da chamada"], button[aria-label*="Leave call"]')) break;
      bar = parent;
    }
    bar.setAttribute(HIDE, "");
  }

  const send = (message) => {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // extensão recarregada com a página aberta
    }
  };

  const region = () => {
    for (const el of document.querySelectorAll('[role="region"]')) if (CAPTIONS.test(el.getAttribute("aria-label") || "")) return el;
    return null;
  };

  const linesOf = (el) =>
    (el.innerText || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  // A última linha de legenda: sobe da última foto de perfil até o bloco que a contém sozinha.
  function lastCaption(box) {
    const photos = box.querySelectorAll("img");
    let node = photos[photos.length - 1]?.parentElement;
    let found = null;
    while (node && node !== box && node.querySelectorAll("img").length === 1) {
      const lines = linesOf(node);
      if (lines.length) found = { name: lines[0], text: lines.slice(1).join(" ") };
      if (lines.length >= 2) break;
      node = node.parentElement;
    }
    return found;
  }

  function enableCaptions() {
    if (region() || tries >= 8) return;
    tries++;
    for (const button of document.querySelectorAll("button[aria-label]")) {
      const label = button.getAttribute("aria-label") || "";
      if (!CC_BUTTON.test(label)) continue;
      if (button.getAttribute("aria-pressed") === "true") return; // já ligada; a região aparece em instantes
      button.click();
      return;
    }
  }

  // ---- quadros dos participantes ----------------------------------------------------------
  const ICON = /^[a-z]+(_[a-z]+)+$|^(mic|pinned|keep|devices|videocam)$/; // nome de ícone, não de pessoa

  function tiles() {
    const seenIds = new Set();
    const out = [];
    for (const el of document.querySelectorAll("[data-participant-id]")) {
      if (el.parentElement?.closest("[data-participant-id]")) continue;
      const id = el.getAttribute("data-participant-id");
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      out.push(el);
    }
    return out;
  }

  // Texto de botão e de menu do quadro ("Planos de fundo e efeitos", "Fixar", "Silenciar"...) não é nome de ninguém.
  const UI_LABEL = /planos? de fundo|efeitos?|backgrounds?|effects?|fixar|\bpin(ned)?\b|silenciar|\bmute|remover|remove|mais op[cç][õo]es|more options|apresent|present|tela cheia|full ?screen|ajustar|adjust|aplicar|apply|desativar|ativar|turn (on|off)|c[âa]mera|camera|microfone|microphone|legenda|caption|sinalizar|flag|reconect|conectando|aguardando|waiting/i;

  // Nome de gente é curto e não é frase: sem ponto final, sem mais de cinco palavras e sem falar do que
  // o Meet está fazendo ("As pessoas ainda podem ver seu vídeo completo.").
  const SENTENCE = /pessoas|podem ver|ainda|v[ií]deo|vendo|compartilh|voc[eê] est[aá]|you are|can see|everyone|ningu[eé]m|reuni[aã]o/i;
  function looksLikeName(text) {
    if (text.length < 2 || text.length > 40) return false;
    if (/[!?:;]$/.test(text) || /\d{4,}/.test(text)) return false;
    // Ponto no fim é frase, a não ser que seja inicial ou abreviatura de nome ("Renan F.", "Carlos Jr.").
    if (text.endsWith(".") && !/(^|\s)(\p{Lu}|Jr|Sr|Dr|Dra|Sra|Prof)\.$/u.test(text)) return false;
    if (text.split(/\s+/).length > 5) return false;
    return !ICON.test(text) && !UI_LABEL.test(text) && !SENTENCE.test(text);
  }

  function tileName(el) {
    const named = el.querySelector("[data-self-name]")?.textContent?.trim();
    if (named && looksLikeName(named)) return named;
    // Só texto que não esteja dentro de um botão ou menu. Entre os que parecem nome vale o mais baixo no
    // quadro, que é onde o Meet escreve o nome; avisos e dicas ficam em cima ou no meio.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let best = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (!looksLikeName(text)) continue;
      if (node.parentElement?.closest('button, [role="button"], [role="menu"], [role="menuitem"], [role="tooltip"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const bottom = range.getBoundingClientRect().bottom;
      if (!best || bottom > best.bottom + 1) best = { text, bottom };
    }
    return best?.text || "";
  }

  // ---- o meu quadro: o que acende quando só a minha voz está no ar ----------------------------------------------
  // O hook da página manda o áudio do meu microfone ("voce") e o dos outros ("outros"), separados. Nos instantes em que
  // só o meu microfone tem voz, o quadro com animação rodando é o meu. Vale com câmera ligada ou desligada, em reunião
  // de 2 ou de 20 pessoas, sem depender de nome, de posição do quadro nem de nada guardado de outra reunião.
  const MIC_ON = 0.012; // acima disso o meu microfone tem voz
  const OTHERS_OFF = 0.004; // abaixo disso ninguém mais está falando
  const MIN_SOLO = 8; // leituras só com a minha voz (2 s) antes de dar o quadro como meu
  const mic = { voce: 0, outros: 0, at: 0 };
  const soloHits = new Map(); // id do quadro -> leituras em que ele animou enquanto só eu falava
  let soloReads = 0;
  let selfId = ""; // o quadro que descobri ser o meu

  const rmsOf = (buffer) => {
    const pcm = new Int16Array(buffer);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2;
    return pcm.length ? Math.sqrt(sum / pcm.length) : 0;
  };

  window.addEventListener("message", (event) => {
    const d = event.data;
    if (event.source !== window || !d?.escutaMeet || d.from !== "hook" || d.type !== "audio") return;
    mic.voce = rmsOf(d.voce);
    mic.outros = rmsOf(d.outros);
    mic.at = Date.now();
  });

  // O áudio dos outros está calado (e o hook está mandando): então quem anima é só eu, e ninguém mais recebe nome.
  const onlyMeTalking = () => Date.now() - mic.at < 700 && mic.outros <= OTHERS_OFF;
  // O meu microfone tem voz agora (sozinho ou junto com os outros).
  const myVoiceNow = () => Date.now() - mic.at < 700 && mic.voce >= MIC_ON;

  const tileId = (el) => el.getAttribute("data-participant-id") || "";

  function learnSelf(named) {
    if (Date.now() - mic.at > 700 || mic.voce < MIC_ON || mic.outros > OTHERS_OFF) return; // não é só a minha voz
    soloReads++;
    for (const p of named) {
      const id = tileId(p.el);
      if (id && animating(p.el)) soloHits.set(id, (soloHits.get(id) || 0) + 1);
    }
    if (soloReads < MIN_SOLO) return;
    const ranked = [...soloHits.entries()].sort((a, b) => b[1] - a[1]);
    const [bestId, best] = ranked[0] || [];
    const second = ranked[1]?.[1] || 0;
    // O quadro que animou em quase todas as leituras e bem mais que o segundo.
    if (bestId && best / soloReads >= 0.6 && second / soloReads <= 0.4) selfId = bestId;
  }

  // ---- o meu quadro também quando falo junto com os outros ----------------------------------------------------
  // Só com a minha voz sozinha (acima) demora a achar o meu quadro, e falar junto com os outros logo no começo faz o
  // meu quadro entrar na disputa como se fosse de outra pessoa. Então compara, para cada quadro, quanto ele anima
  // quando o meu microfone tem voz e quando não tem: o meu anima bem mais com a minha voz; o dos outros anima quando
  // eles mesmos falam, não quando eu falo. Em dados reais: +26 pontos para o meu quadro e −35 para os dos outros;
  // acha o meu em ~6 s de conversa e não trocou de ideia depois.
  const LIFT_READS = 8; // leituras com e sem a minha voz antes de decidir
  const LIFT_MIN = 0.2; // quanto a mais o meu quadro anima com a minha voz
  const LIFT_GAP = 0.2; // folga sobre o segundo colocado
  const liftOn = new Map(); // id do quadro -> leituras com animação enquanto o meu microfone tinha voz
  const liftOff = new Map(); // ... e enquanto não tinha
  let readsOn = 0;
  let readsOff = 0;

  function learnSelfByLift(named) {
    if (selfId || Date.now() - mic.at > 700) return; // só com o hook mandando áudio
    const on = mic.voce >= MIC_ON;
    if (on) readsOn++;
    else readsOff++;
    for (const p of named) {
      const id = tileId(p.el);
      if (!id || !animating(p.el)) continue;
      const bucket = on ? liftOn : liftOff;
      bucket.set(id, (bucket.get(id) || 0) + 1);
    }
    if (readsOn < LIFT_READS || readsOff < LIFT_READS) return;
    const lifts = named
      .map((p) => {
        const id = tileId(p.el);
        return { id, v: (liftOn.get(id) || 0) / readsOn - (liftOff.get(id) || 0) / readsOff };
      })
      .sort((a, b) => b.v - a.v);
    if (lifts[0]?.id && lifts[0].v >= LIFT_MIN && lifts[0].v - (lifts[1]?.v ?? -1) >= LIFT_GAP) selfId = lifts[0].id;
  }

  // Quem grava aparece como "Você" (ou com o nome, no quadrinho), e o próprio vídeo é espelhado.
  function isSelf(el, name, all) {
    if (selfId) return tileId(el) === selfId; // descoberto pela minha voz: vale mais que qualquer palpite abaixo
    if (SELF.test(name) || /\((voc[eê]|you)\)/i.test(name)) return true;
    const video = el.querySelector("video");
    if (video && /^matrix\(-1,/.test(getComputedStyle(video).transform)) return true;
    if (all.length === 2) {
      const area = (n) => n.getBoundingClientRect().width * n.getBoundingClientRect().height;
      const [a, b] = all;
      return el === (area(a) <= area(b) ? a : b); // com duas pessoas, o quadro menor é o seu
    }
    return false;
  }

  // O nome de quem grava, lido do próprio quadro (o Meet às vezes escreve "Nome (Você)").
  const bare = (name) => name.replace(/\s*\((voc[eê]|you)\)\s*$/i, "").trim();
  let myName = "";
  let groupTicks = 0; // leituras seguidas com duas ou mais outras pessoas na chamada

  // ---- quem fala: o quadro com animação rodando --------------------------------------------------------------
  // Medido numa chamada real de quatro pessoas: o quadro de quem está calado não tem nenhuma animação; o de quem
  // fala tem (anel, indicador de voz); e o do próprio usuário acende só quando ele fala. Pergunta ao navegador
  // quais animações estão rodando no quadro, sem depender de nome de classe do Meet (que muda de versão).
  // Ajustado numa conversa real de 5 quadros, tendo as legendas do Google como resposta certa (anima quando fala em
  // ~75% das leituras, não em 100%): memória de 2,5 s com as leituras recentes pesando mais, e troca rápida quando
  // outro passa à frente. Esperar duas confirmações atrasava a troca e rotulava o começo da fala com a pessoa
  // anterior. Nessa conversa: 93% certo e 5% errado, contra 79% e 11% antes (86% e 11% contra 69% e 19% numa
  // metade que o ajuste nunca viu).
  const HISTORY = 10; // leituras de 250 ms
  const DECAY = 0.8; // cada leitura mais antiga pesa 0,8 da seguinte
  const MIN_ACTIVITY = 0.3; // abaixo disso ninguém (além de mim) está falando
  const KEEP_ACTIVITY = 0.3; // quem já falava só continua se ainda tem isto
  const SWITCH_MARGIN = 0.15; // quanto outro precisa passar de quem já falava para tomar a vez
  const ME_MARGIN = 0.4; // se o meu quadro anima bem mais que o melhor dos outros, sou eu falando
  const history = new WeakMap(); // quadro -> 1 (com animação) ou 0, por leitura
  const animating = (el) => el.getAnimations({ subtree: true }).some((a) => a.playState === "running");
  // Divide pelo peso da janela inteira, e não só das leituras que já existem: quadro recém-visto com uma única
  // leitura "animando" não pode valer 100%. Leitura que falta conta como "sem animação".
  let FULL = 0;
  for (let i = 0, w = 1; i < HISTORY; i++, w *= DECAY) FULL += w;
  const activity = (el) => {
    const h = history.get(el) || [];
    let weight = 1;
    let sum = 0;
    for (let i = h.length - 1; i >= 0; i--) {
      sum += h[i] * weight;
      weight *= DECAY;
    }
    return sum / FULL;
  };
  let current = ""; // quem estava falando
  let sent = { name: "", at: 0 };

  function pickSpeaker(others, me) {
    const scored = others.map((p) => ({ name: p.name, s: activity(p.el) })).sort((a, b) => b.s - a.s);
    const best = scored[0];
    if (best.s < MIN_ACTIVITY) return ""; // ninguém além de mim tem animação: não há o que dizer
    if (me && activity(me.el) > best.s + ME_MARGIN) return ""; // sou eu falando mais forte: não vira nome de outra pessoa
    const cur = scored.find((x) => x.name === current);
    // Quem já falava continua, a menos que outro passe dele com folga.
    if (cur && cur.s >= KEEP_ACTIVITY && best.name !== current && best.s < cur.s + SWITCH_MARGIN) return current;
    current = best.name;
    return current;
  }

  function tickTiles() {
    const all = tiles();
    const named = all.map((el) => ({ el, name: tileName(el) })).filter((p) => p.name);
    for (const p of named) {
      const h = history.get(p.el) || [];
      h.push(animating(p.el) ? 1 : 0);
      if (h.length > HISTORY) h.shift();
      history.set(p.el, h);
    }
    learnSelf(named);
    learnSelfByLift(named);
    const mine = named.find((p) => isSelf(p.el, p.name, all) && bare(p.name) && !SELF.test(bare(p.name)));
    if (mine && bare(mine.name) !== myName) {
      myName = bare(mine.name);
      send({ type: "meet-self", name: myName.slice(0, 80) });
    }
    const others = named.filter((p) => !isSelf(p.el, p.name, all));
    groupTicks = others.length >= 2 ? groupTicks + 1 : 0;
    let name = "";
    if (others.length === 1) name = others[0].name; // só uma outra pessoa na chamada: é ela quem fala
    else if (others.length >= 2 && !useCaptions && !onlyMeTalking() && (selfId || !myVoiceNow())) name = pickSpeaker(others, named.find((p) => isSelf(p.el, p.name, all)));
    if (!name) return;
    const now = Date.now();
    if (name === sent.name && now - sent.at < REPEAT_MS) return; // não repete a cada leitura
    sent = { name, at: now };
    // solo: só havia uma outra pessoa na chamada. Se todos os avisos forem assim, a chamada é de dois e toda fala
    // dos outros leva o nome dela.
    send({ type: "meet-speaker", name: name.slice(0, 80), t: now, solo: others.length === 1 });
  }

  function tick() {
    tickTiles();
    // Opcional: com a opção ligada, em reunião com várias pessoas o nome vem das legendas do Meet (escondidas da tela),
    // em vez da animação do quadro.
    if (!useCaptions || groupTicks < 2) return;
    const box = region();
    if (!box) {
      enableCaptions();
      return;
    }
    hideBar(box);
    const line = lastCaption(box);
    if (!line || !line.name || SELF.test(line.name) || line.name === myName || !looksLikeName(line.name)) return;
    const now = Date.now();
    const changed = line.name !== seen.name || line.text !== seen.text;
    if (!changed) return;
    if (line.name === seen.name && now - seen.at < REPEAT_MS) {
      seen.text = line.text;
      return;
    }
    seen = { name: line.name, text: line.text, at: now };
    send({ type: "meet-speaker", name: line.name.slice(0, 80), t: now, solo: false });
  }

  function setRunning(on) {
    if (on === running) return;
    running = on;
    clearInterval(timer);
    if (!on) for (const el of document.querySelectorAll(`[${HIDE}]`)) el.removeAttribute(HIDE); // mostra as legendas de novo
    if (on) {
      tries = 0;
      seen = { name: "", text: "", at: 0 };
      myName = "";
      current = "";
      sent = { name: "", at: 0 };
      selfId = "";
      soloReads = 0;
      soloHits.clear();
      readsOn = readsOff = 0;
      liftOn.clear();
      liftOff.clear();
      timer = setInterval(tick, POLL_MS);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "meet-speakers") return;
    if (msg.action !== "start") return setRunning(false);
    chrome.storage.sync
      .get({ speakerNames: false })
      .then(({ speakerNames }) => {
        useCaptions = speakerNames === true;
        setRunning(true);
      })
      .catch(() => setRunning(true));
  });
})();
