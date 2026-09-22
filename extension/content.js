(() => {
  // WhatsApp Web changes its markup often. Everything that depends on it lives in this block.
  const SEL = {
    voiceIcon:
      '[data-icon="audio-play"], [data-icon="audio-pause"], [data-icon="audio-download"], [data-icon="ptt-status"]',
    playIcon: '[data-icon="audio-play"], [data-icon="audio-download"], [data-icon*="play"]',
    pauseIcon: '[data-icon="audio-pause"], [data-icon*="pause"]',
    playLabel: '[aria-label*="Reproduzir" i], [aria-label*="Play" i], [aria-label*="voz" i], [aria-label*="voice" i]',
    message: "[data-id]",
    outgoing: ".message-out",
  };

  const MESSAGES = {
    server_offline: "Servidor local desligado. Rode start.bat (ou ./start.sh) na pasta server.",
    whisper_missing: "Whisper não instalado. Rode setup.bat (ou ./setup.sh) na pasta server.",
    ffmpeg_missing: "ffmpeg não encontrado. Instale o ffmpeg e tente de novo.",
    ollama_offline: "Ollama não está rodando. Abra o app Ollama.",
    bad_token: "Token do servidor não confere. Ajuste no ícone da extensão.",
    no_audio: "Não achei o áudio desta mensagem. Toque em reproduzir e tente de novo.",
    audio_timeout: "O áudio não carregou. Tente de novo.",
  };

  // Per-message state survives WhatsApp re-rendering its virtualized list.
  const states = new Map();

  // Transcrições salvas por data-id: recarregar a página ou voltar à conversa
  // mostra o texto na hora, sem tocar o áudio nem chamar o servidor de novo.
  const STORE_PREFIX = "t:";
  const STORE_MAX = 2000; // ~1 KB cada; o chrome.storage.local aguenta 10 MB
  const saved = new Map();

  async function loadSaved() {
    const all = await chrome.storage.local.get(null);
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(STORE_PREFIX)) saved.set(key.slice(STORE_PREFIX.length), value);
    }
  }

  function persist(id) {
    const { text, duration, summary } = states.get(id);
    const entry = { text, duration: duration ?? null, summary: summary ?? null, at: Date.now() };
    saved.set(id, entry);
    chrome.storage.local.set({ [STORE_PREFIX + id]: entry });
    if (saved.size <= STORE_MAX) return;
    // Passou do limite: apaga as 10% mais antigas de uma vez, não uma por uma.
    const oldest = [...saved].sort((a, b) => a[1].at - b[1].at).slice(0, STORE_MAX / 10);
    for (const [old] of oldest) saved.delete(old);
    chrome.storage.local.remove(oldest.map(([old]) => STORE_PREFIX + old));
  }

  function forget(id) {
    saved.delete(id);
    chrome.storage.local.remove(STORE_PREFIX + id);
  }

  function ensureState(id) {
    if (!states.has(id)) {
      const entry = saved.get(id);
      states.set(
        id,
        entry
          ? { status: "done", text: entry.text, duration: entry.duration, summary: entry.summary, sumStatus: entry.summary ? "done" : null }
          : { status: "idle" },
      );
    }
    return states.get(id);
  }

  // Ajustes do popup. Mudou lá, vale aqui na hora, sem recarregar o WhatsApp.
  const settings = { autoTranscribe: false, autoSummary: true };
  const LONG_AUDIO_S = 60;

  async function loadSettings() {
    Object.assign(settings, await chrome.storage.sync.get(settings));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const key of Object.keys(settings)) {
      if (key in changes && changes[key].newValue !== undefined) settings[key] = changes[key].newValue;
    }
  });

  const rowFor = (id) => document.querySelector(`${SEL.message}[data-id="${CSS.escape(id)}"]`);

  // O data-id sozinho nao basta: o prefixo "true_" some quando o WhatsApp muda o
  // formato, e ai a mensagem enviada fica alinhada a esquerda. Tres sinais, do
  // mais barato ao mais teimoso, e o ultimo e geometria pura.
  function isOutgoing(row, id) {
    if (id.startsWith("true_")) return true;
    if (row.matches(SEL.outgoing) || row.querySelector(SEL.outgoing)) return true;
    const icon = row.querySelector(SEL.voiceIcon);
    if (!icon) return false;
    const box = row.getBoundingClientRect();
    const bubble = icon.getBoundingClientRect();
    if (box.width <= 0) return false;
    return bubble.left - box.left > box.right - bubble.right;
  }

  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };

  const fmtDuration = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

  const errorText = (res) => MESSAGES[res.code] || res.message || "Algo deu errado.";

  // WhatsApp only builds the audio after the voice note starts playing. page-hook.js (page world)
  // mutes that playback, copies the audio out, and pauses it; here we arm it and press play.
  function grabAudio(row) {
    const token = crypto.randomUUID();
    const playing = Boolean(row.querySelector(SEL.pauseIcon));

    return new Promise((resolve, reject) => {
      const finish = (settle, value) => {
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        settle(value);
      };
      const target = playing ? null : row.querySelector(SEL.playIcon) || row.querySelector(SEL.playLabel);
      const button = target?.closest('button, [role="button"]') || target;
      if (!playing && !button) {
        console.debug("[escuta] play button not found", row.outerHTML.slice(0, 1500));
        reject({ code: "no_audio" });
        return;
      }

      const onMessage = (event) => {
        const msg = event.data;
        if (event.source !== window || !msg?.escuta || msg.token !== token) return;
        // Só aperta o play depois que o page-hook confirma que armou. O postMessage
        // chega um instante depois; um áudio já carregado (ouvido antes, ou depois
        // de Fechar) começa a tocar dentro do próprio clique e escapava da captura,
        // tocando com som e estourando o tempo.
        if (msg.type === "armed") button?.click();
        else if (msg.type === "audio") finish(resolve, msg);
        else if (msg.type === "error") finish(reject, { code: "audio_timeout" });
      };
      const timer = setTimeout(() => {
        window.postMessage({ escuta: true, type: "disarm" }, location.origin);
        finish(reject, { code: "audio_timeout" });
      }, 25000);

      window.addEventListener("message", onMessage);
      // Já tocando: o page-hook copia direto, sem clique.
      window.postMessage({ escuta: true, type: "arm", token, playing }, location.origin);
    });
  }

  // page-hook.js só captura um áudio por vez. Sem fila, dois cliques seguidos
  // (ou o automático junto com um clique) disputam o mesmo "armar".
  let grabbing = Promise.resolve();

  function grabQueued(id) {
    const run = grabbing.then(() => {
      const row = rowFor(id); // procura de novo: a linha pode ter sido recriada enquanto esperava
      if (!row) throw { code: "no_audio" };
      return grabAudio(row);
    });
    grabbing = run.catch(() => {});
    return run;
  }

  function requestTranscription(audio, mime, onSegment) {
    return new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: "transcribe" });
      let settled = false;
      port.onMessage.addListener((msg) => {
        if (msg.segment != null) return onSegment(msg.segment);
        settled = true;
        port.disconnect();
        resolve(msg);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (!settled) resolve({ ok: false, code: "server_offline", message: "A extensão foi recarregada." });
      });
      port.postMessage({ audio, mime });
    });
  }

  async function transcribe(id) {
    const state = ensureState(id);
    if (state.status === "working") return;
    Object.assign(state, { status: "working", error: null, text: "", summary: null, sumStatus: null });
    paint(id);
    try {
      const { b64, mime, duration } = await grabQueued(id);
      state.duration = Number.isFinite(duration) ? duration : null;
      const res = await requestTranscription(b64, mime, (segment) => {
        state.text += segment;
        paint(id);
      });
      if (!res.ok) throw res;
      state.text = res.data.text || "";
      state.duration ??= res.data.duration || null;
      state.status = "done";
      persist(id);
    } catch (err) {
      state.status = "error";
      state.error = errorText(err);
    }
    paint(id);
    if (state.status === "done" && settings.autoSummary && state.text && state.duration >= LONG_AUDIO_S) summarize(id);
  }

  async function summarize(id) {
    const state = states.get(id);
    state.sumStatus = "working";
    state.sumError = null;
    paint(id);
    const res = await chrome.runtime.sendMessage({ type: "summarize", text: state.text });
    if (res.ok) {
      state.summary = res.data.summary;
      state.sumStatus = "done";
      persist(id);
    } else {
      state.sumStatus = "error";
      state.sumError = errorText(res);
    }
    paint(id);
  }

  // ---- rendering ---------------------------------------------------------

  const waveform = () => {
    const wave = h("span", "escuta-wave");
    wave.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 4; i++) wave.append(h("i"));
    return wave;
  };

  const action = (label, onClick, variant) => {
    const btn = h("button", `escuta-btn${variant ? ` escuta-btn--${variant}` : ""}`, label);
    btn.type = "button";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  };

  function renderInto(root, id) {
    const state = states.get(id);
    root.replaceChildren();

    if (state.status === "idle") {
      const btn = action("Transcrever", () => transcribe(id), "start");
      btn.prepend(waveform());
      root.append(btn);
      return;
    }

    if (state.status === "working" && state.text) {
      // Áudio longo: o texto aparece trecho a trecho enquanto o resto é transcrito.
      const card = h("div", "escuta-card");
      const status = h("div", "escuta-working escuta-working--label");
      status.setAttribute("role", "status");
      status.append(waveform(), h("span", null, "Transcrevendo…"));
      card.append(status, h("p", "escuta-text", state.text.trim()));
      root.append(card);
      return;
    }

    if (state.status === "working") {
      const status = h("div", "escuta-working");
      status.setAttribute("role", "status");
      status.append(waveform(), h("span", null, "Transcrevendo…"));
      root.append(status);
      return;
    }

    if (state.status === "error") {
      const box = h("div", "escuta-card escuta-card--error");
      box.append(h("p", "escuta-error", state.error), action("Tentar de novo", () => transcribe(id)));
      root.append(box);
      return;
    }

    const card = h("div", "escuta-card");
    const label = ["Transcrição", fmtDuration(state.duration)].filter(Boolean).join(" · ");
    card.append(h("div", "escuta-label", label));
    card.append(h("p", "escuta-text", state.text || "Nenhuma fala reconhecida."));

    if (state.sumStatus === "done") {
      const sum = h("div", "escuta-summary");
      sum.append(h("div", "escuta-label", "Resumo"), h("p", "escuta-text", state.summary));
      card.append(sum);
    } else if (state.sumStatus === "working") {
      const status = h("div", "escuta-working escuta-working--small");
      status.setAttribute("role", "status");
      status.append(waveform(), h("span", null, "Resumindo…"));
      card.append(status);
    } else if (state.sumStatus === "error") {
      card.append(h("p", "escuta-error", state.sumError));
    }

    const bar = h("div", "escuta-actions");
    if (state.text) {
      if (state.sumStatus !== "done" && state.sumStatus !== "working") {
        bar.append(action(state.sumStatus === "error" ? "Tentar resumir de novo" : "Resumir", () => summarize(id), "primary"));
      }
      const copy = action("Copiar", async () => {
        await navigator.clipboard.writeText(state.summary ? `${state.text}\n\nResumo: ${state.summary}` : state.text);
        copy.textContent = "Copiado";
        setTimeout(() => (copy.textContent = "Copiar"), 1500);
      });
      bar.append(copy);
    }
    bar.append(
      action("Fechar", () => {
        states.delete(id);
        forget(id);
        paint(id);
      }),
    );
    card.append(bar);
    root.append(card);
  }

  function paint(id) {
    const row = rowFor(id);
    if (!row) return;
    ensureState(id);
    let root = row.querySelector(":scope > .escuta");
    if (!root) {
      root = h("div", "escuta");
      if (isOutgoing(row, id)) root.classList.add("escuta--out");
      // Linha de mensagem em flex sem wrap empurra nosso bloco para o lado do
      // audio. Permitir a quebra e o que faz ele cair embaixo, como deve.
      if (getComputedStyle(row).display.includes("flex")) row.style.flexWrap = "wrap";
      row.append(root);
    }
    renderInto(root, id);
  }

  // ---- discovery ---------------------------------------------------------

  // O automático só pega o áudio recebido que é a última mensagem da conversa:
  // um que acabou de chegar, ou o mais recente ao abrir a conversa. Rolar para
  // cima carrega mensagens antigas acima dela, e essas ficam no botão.
  const autoTried = new Set();

  function isNewest(row) {
    const rows = document.querySelectorAll(SEL.message);
    const last = rows[rows.length - 1];
    return last === row || row.contains(last);
  }

  function maybeAuto(id, row) {
    if (!settings.autoTranscribe || autoTried.has(id)) return;
    if (states.get(id).status !== "idle" || isOutgoing(row, id) || !isNewest(row)) return;
    autoTried.add(id);
    transcribe(id);
  }

  function scan() {
    for (const icon of document.querySelectorAll(SEL.voiceIcon)) {
      const row = icon.closest(SEL.message);
      if (!row || row.querySelector(":scope > .escuta")) continue;
      const id = row.getAttribute("data-id");
      ensureState(id);
      paint(id);
      maybeAuto(id, row);
    }
  }

  function start() {
    let pending = 0;
    new MutationObserver(() => {
      clearTimeout(pending);
      pending = setTimeout(scan, 250);
    }).observe(document.body, { childList: true, subtree: true });
    scan();
  }

  Promise.all([loadSaved(), loadSettings()])
    .catch((err) => console.warn("[escuta] ajustes/transcrições salvas não carregaram:", err))
    .finally(start);
})();
