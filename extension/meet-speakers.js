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

  let useCaptions = false; // opção da pessoa: ligar as legendas (escondidas) para saber quem fala
  const spoke = new Map(); // quadro -> horários de mudança recente (quem tem movimento está falando)
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

  function tileName(el) {
    const named = el.querySelector("[data-self-name]")?.textContent?.trim();
    if (named) return named;
    return linesOf(el).find((l) => l.length >= 2 && l.length <= 60 && !ICON.test(l)) || "";
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

  // Movimento no quadro (o anel de quem fala) a cada mudança de atributo.
  let watcher = null;
  function watch() {
    if (watcher) return;
    watcher = new MutationObserver((records) => {
      const now = Date.now();
      for (const r of records) {
        const tile = r.target.nodeType === 1 ? r.target.closest?.("[data-participant-id]") : null;
        if (!tile) continue;
        const list = spoke.get(tile) || [];
        list.push(now);
        spoke.set(tile, list.filter((t) => now - t < 1000));
      }
    });
    watcher.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-audio-level"], subtree: true });
  }

  // O nome de quem grava, lido do próprio quadro (o Meet às vezes escreve "Nome (Você)").
  const bare = (name) => name.replace(/\s*\((voc[eê]|you)\)\s*$/i, "").trim();
  let myName = "";

  function tickTiles() {
    watch();
    const all = tiles();
    const named = all.map((el) => ({ el, name: tileName(el) })).filter((p) => p.name);
    const mine = named.find((p) => isSelf(p.el, p.name, all) && bare(p.name) && !SELF.test(bare(p.name)));
    if (mine && bare(mine.name) !== myName) {
      myName = bare(mine.name);
      send({ type: "meet-self", name: myName.slice(0, 80) });
    }
    const others = named.filter((p) => !isSelf(p.el, p.name, all));
    let name = "";
    if (others.length === 1) {
      name = others[0].name; // só uma outra pessoa na chamada: é ela
    } else if (others.length > 1) {
      const now = Date.now();
      const score = others.map((p) => ({ name: p.name, n: (spoke.get(p.el) || []).filter((t) => now - t < 800).length })).sort((a, b) => b.n - a.n);
      if (score[0].n >= 2 && score[0].n >= score[1].n * 1.5) name = score[0].name; // sem vencedor claro: não chuta
    }
    if (name) send({ type: "meet-speaker", name: name.slice(0, 80), t: Date.now() });
  }

  function tick() {
    if (!useCaptions) return tickTiles();
    const box = region();
    if (!box) {
      enableCaptions();
      return tickTiles(); // enquanto as legendas não sobem, os quadros quebram o galho
    }
    if (running) hideBar(box);
    const line = lastCaption(box);
    if (!line || !line.name || SELF.test(line.name)) return;
    const now = Date.now();
    const changed = line.name !== seen.name || line.text !== seen.text;
    if (!changed) return;
    if (line.name === seen.name && now - seen.at < REPEAT_MS) {
      seen.text = line.text;
      return;
    }
    seen = { name: line.name, text: line.text, at: now };
    send({ type: "meet-speaker", name: line.name.slice(0, 80), t: now });
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
      .get({ speakerNames: false })
      .then(({ speakerNames }) => {
        useCaptions = speakerNames === true;
        setRunning(true);
      })
      .catch(() => setRunning(true));
  });
})();
