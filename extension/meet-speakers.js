// Quem está falando na chamada do Meet. O áudio dos participantes vem misturado numa pista só, então
// os nomes saem das legendas do próprio Meet: cada linha delas traz o nome de quem fala. Este script
// liga as legendas quando a gravação começa, lê o nome da última linha e avisa a extensão, que depois
// cruza esses avisos com a hora de cada trecho da transcrição.
(() => {
  if (window.__escutaSpeakers) return;
  window.__escutaSpeakers = true;

  const SELF = /^(voc[eê]|you|tu|usted)$/i; // o Meet chama quem grava de "Você": isso já é a pista do microfone
  const CAPTIONS = /caption|legenda|subt[ií]tulo|sous-titre|untertitel/i;
  const CC_BUTTON = /caption|legenda|subt[ií]tulo|sous-titre|untertitel/i;
  const POLL_MS = 500;
  const REPEAT_MS = 700; // enquanto a mesma pessoa fala, reafirma de tempos em tempos

  let running = false;
  let timer = 0;
  let tries = 0;
  let seen = { name: "", text: "", at: 0 };

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

  function tick() {
    const box = region();
    if (!box) {
      enableCaptions();
      return;
    }
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
    if (on) {
      tries = 0;
      seen = { name: "", text: "", at: 0 };
      timer = setInterval(tick, POLL_MS);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "meet-speakers") return;
    if (msg.action !== "start") return setRunning(false);
    chrome.storage.sync.get({ speakerNames: true }).then(({ speakerNames }) => setRunning(speakerNames !== false)).catch(() => {});
  });
})();
