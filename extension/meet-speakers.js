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
  const POLL_MS = 500;
  const REPEAT_MS = 700; // enquanto a mesma pessoa fala, reafirma de tempos em tempos

  let useCaptions = true; // ligar as legendas (escondidas) em reunião com várias pessoas; a pessoa pode desligar no popup
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
    if (/[.!?:;]$/.test(text) || /\d{4,}/.test(text)) return false;
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

  // Quem grava aparece como "Você" (ou com o nome, no quadrinho), e o próprio vídeo é espelhado.
  function isSelf(el, name, all) {
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

  function tickTiles() {
    const all = tiles();
    const named = all.map((el) => ({ el, name: tileName(el) })).filter((p) => p.name);
    const mine = named.find((p) => isSelf(p.el, p.name, all) && bare(p.name) && !SELF.test(bare(p.name)));
    if (mine && bare(mine.name) !== myName) {
      myName = bare(mine.name);
      send({ type: "meet-self", name: myName.slice(0, 80) });
    }
    const others = named.filter((p) => !isSelf(p.el, p.name, all));
    groupTicks = others.length >= 2 ? groupTicks + 1 : 0;
    // Só uma outra pessoa na chamada: é ela quem fala. solo: se todos os avisos forem assim, a chamada é de dois
    // e toda fala dos outros leva o nome dela.
    if (others.length === 1) send({ type: "meet-speaker", name: others[0].name.slice(0, 80), t: Date.now(), solo: true });
  }

  function tick() {
    tickTiles();
    // Reunião com várias pessoas: o movimento do quadro não diz de forma confiável quem fala (mexe por outros
    // motivos e errava, principalmente no começo). Quem atribui cada fala a uma pessoa é o próprio Google, nas
    // legendas. Elas só são ligadas (e escondidas da tela) quando há mais de duas pessoas; sem elas, a fala
    // fica como "Participantes" em vez de receber um nome errado.
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
      timer = setInterval(tick, POLL_MS);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "meet-speakers") return;
    if (msg.action !== "start") return setRunning(false);
    chrome.storage.sync
      .get({ speakerNames: true })
      .then(({ speakerNames }) => {
        useCaptions = speakerNames !== false;
        setRunning(true);
      })
      .catch(() => setRunning(true));
  });
})();
