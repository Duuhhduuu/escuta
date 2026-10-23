(() => {
  // WhatsApp Web changes its markup often. Everything that depends on it lives in this block.
  // Em out/2026 o WhatsApp trocou data-icon="..." por <svg><title>nome</title> e tirou
  // .message-out e o prefixo true_/false_ do data-id. Os seletores antigos ficam
  // como reserva; os rótulos acessíveis (aria-label) são o que muda menos.
  const SEL = {
    voiceIcon:
      '[data-icon="audio-play"], [data-icon="audio-pause"], [data-icon="audio-download"], [data-icon="ptt-status"]',
    voiceLabel:
      '[aria-label*="voice message" i], [aria-label*="voice note" i], [aria-label*="mensagem de voz" i], [aria-label*="mensagem de áudio" i]',
    playIcon: '[data-icon="audio-play"], [data-icon="audio-download"], [data-icon*="play"]',
    pauseIcon: '[data-icon="audio-pause"], [data-icon*="pause"]',
    // Começa com: "Change playback speed" também contém "play".
    playButton:
      'button[aria-label^="play" i], button[aria-label^="reproduzir" i], [role="button"][aria-label^="play" i], [role="button"][aria-label^="reproduzir" i]',
    pauseButton:
      'button[aria-label^="pause" i], button[aria-label^="pausar" i], [role="button"][aria-label^="pause" i], [role="button"][aria-label^="pausar" i]',
    playLabel: '[aria-label*="Reproduzir" i], [aria-label*="Play" i], [aria-label*="voz" i], [aria-label*="voice" i]',
    message: "[data-id]",
    outgoing: ".message-out",
  };

  // Nomes que aparecem no <title> dos ícones svg.
  const ICON = {
    voice: /^(ic-keyboard-voice|ptt)/,
    play: /play/,
    pause: /pause/,
    download: /download|arrow-downward/,
    outgoing: /^tail-out$/,
    incoming: /^tail-in$/,
  };

  const titled = (root, re) => [...root.querySelectorAll("svg title")].find((t) => re.test(t.textContent))?.closest("svg");

  // Mensagem de voz tem player (play, pause ou baixar). Uma resposta que cita um
  // áudio também mostra o microfone, mas não tem player, e fica sem botão.
  const playerIn = (row) =>
    row.querySelector(`${SEL.playButton}, ${SEL.pauseButton}, ${SEL.voiceIcon}`) ||
    titled(row, ICON.play) ||
    titled(row, ICON.pause) ||
    titled(row, ICON.download);

  function voiceRows() {
    const root = document.querySelector("#main") || document.body;
    const hits = [...root.querySelectorAll(`${SEL.voiceIcon}, ${SEL.voiceLabel}`)];
    for (const t of root.querySelectorAll("svg title")) if (ICON.voice.test(t.textContent)) hits.push(t);
    const rows = new Set(hits.map((el) => el.closest(SEL.message)));
    rows.delete(null);
    return [...rows].filter(playerIn);
  }

  const MESSAGES = {
    server_offline: "Servidor local desligado. Rode start.bat (ou ./start.sh) na pasta server.",
    whisper_missing: "Whisper não instalado. Rode setup.bat (ou ./setup.sh) na pasta server.",
    ffmpeg_missing: "ffmpeg não encontrado. Instale o ffmpeg e tente de novo.",
    ollama_offline: "Ollama não está rodando. Abra o app Ollama.",
    bad_token: "Token do servidor não confere. Ajuste no ícone da extensão.",
    no_audio: "Não achei o áudio desta mensagem. Toque em reproduzir e tente de novo.",
    audio_timeout: "O áudio não carregou. Tente de novo.",
    context_invalidated: "A extensão foi atualizada. Recarregue o WhatsApp (F5) e tente de novo.",
  };

  const warn = (what) => (err) => console.warn(`[escuta] ${what}:`, err);

  // Depois que a extensão é recarregada ou atualizada, qualquer chrome.* nesta aba
  // lança na hora em vez de rejeitar. Sem isso o erro escapa e a tela fica parada.
  // Script órfão: a extensão foi recarregada com esta aba aberta. Conforme o
  // navegador, chrome.runtime vira undefined ou lança "context invalidated".
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  function safely(what, job) {
    try {
      Promise.resolve(job()).catch(warn(what));
    } catch (err) {
      warn(what)(err);
    }
  }

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
    const state = states.get(id);
    if (!state) return; // fechada enquanto o servidor respondia
    const { text, duration, summary, collapsed, chat, who } = state;
    // "at" é quando foi transcrita: recolher ou resumir depois não muda a ordem na pesquisa.
    state.at ??= Date.now();
    const entry = {
      text,
      duration: duration ?? null,
      summary: summary ?? null,
      collapsed: Boolean(collapsed),
      chat: chat ?? null,
      who: who ?? null,
      at: state.at,
    };
    saved.set(id, entry);
    safely("não salvou a transcrição", () => chrome.storage.local.set({ [STORE_PREFIX + id]: entry }));
    if (saved.size <= STORE_MAX) return;
    // Passou do limite: apaga as 10% mais antigas de uma vez, não uma por uma.
    const oldest = [...saved].sort((a, b) => a[1].at - b[1].at).slice(0, STORE_MAX / 10);
    for (const [old] of oldest) saved.delete(old);
    safely("não podou as antigas", () => chrome.storage.local.remove(oldest.map(([old]) => STORE_PREFIX + old)));
  }

  function forget(id) {
    saved.delete(id);
    safely("não apagou a transcrição", () => chrome.storage.local.remove(STORE_PREFIX + id));
  }

  function ensureState(id) {
    if (!states.has(id)) {
      const entry = saved.get(id);
      states.set(
        id,
        entry
          ? {
              status: "done",
              text: entry.text,
              duration: entry.duration,
              summary: entry.summary,
              sumStatus: entry.summary ? "done" : null,
              collapsed: Boolean(entry.collapsed),
              chat: entry.chat,
              who: entry.who,
              at: entry.at,
            }
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
    if (area === "local") {
      // Apagada na página de pesquisa: some daqui também, sem recarregar.
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith(STORE_PREFIX) || change.newValue !== undefined) continue;
        const id = key.slice(STORE_PREFIX.length);
        saved.delete(id);
        if (states.get(id)?.status === "done") {
          states.delete(id);
          paint(id);
        }
      }
      return;
    }
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
    if (id.startsWith("false_")) return false;
    if (row.matches(SEL.outgoing) || row.querySelector(SEL.outgoing) || titled(row, ICON.outgoing)) return true;
    if (titled(row, ICON.incoming)) return false;
    const icon = playerIn(row);
    if (!icon) return false;
    const box = row.getBoundingClientRect();
    const bubble = icon.getBoundingClientRect();
    if (box.width <= 0) return false;
    return bubble.left - box.left > box.right - bubble.right;
  }

  // Nome da conversa aberta, no cabeçalho. Melhor esforço: se o WhatsApp mudar,
  // a transcrição continua salva, só sem esse rótulo na pesquisa.
  function chatTitle() {
    const name = document.querySelector("#main header")?.querySelector('span[dir="auto"][title], span[dir="auto"]');
    return (name?.getAttribute("title") || name?.textContent || "").trim() || null;
  }

  // Quem mandou: em grupo a mensagem recebida tem um rótulo "Nome:".
  function senderOf(row, id) {
    if (isOutgoing(row, id)) return "Você";
    const label = row.querySelector('[aria-label$=":"]')?.getAttribute("aria-label");
    return label ? label.slice(0, -1).trim() : null;
  }

  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };

  // Arredonda antes de dividir: 59,6 s vira 1:00, não 0:60.
  const fmtDuration = (s) => {
    if (!Number.isFinite(s)) return "";
    const total = Math.round(s);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  const errorText = (res) => {
    if (!alive() || /context invalidated/i.test(res?.message || "")) return MESSAGES.context_invalidated;
    return MESSAGES[res?.code] || res?.message || "Algo deu errado.";
  };

  // WhatsApp only builds the audio after the voice note starts playing. page-hook.js (page world)
  // mutes that playback, copies the audio out, and pauses it; here we arm it and press play.
  function grabAudio(row) {
    const token = crypto.randomUUID();
    const playing = Boolean(row.querySelector(`${SEL.pauseButton}, ${SEL.pauseIcon}`) || titled(row, ICON.pause));

    return new Promise((resolve, reject) => {
      const finish = (settle, value) => {
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        settle(value);
      };
      const target = playing
        ? null
        : row.querySelector(SEL.playButton) ||
          row.querySelector(SEL.playIcon) ||
          titled(row, ICON.play) ||
          titled(row, ICON.download) ||
          row.querySelector(SEL.playLabel);
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

  // Transcrições em andamento, por data-id. Cancelar desconecta a porta, e o
  // background aborta o fetch: o servidor para de gastar GPU com esse áudio.
  const jobs = new Map();

  function requestTranscription(id, audio, mime, onSegment) {
    return new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: "transcribe" });
      let settled = false;
      const settle = (msg) => {
        if (settled) return;
        settled = true;
        jobs.delete(id);
        resolve(msg);
      };
      jobs.set(id, () => {
        port.disconnect();
        settle({ ok: false, code: "aborted" });
      });
      port.onMessage.addListener((msg) => {
        if (msg.segment != null) return onSegment(msg.segment);
        port.disconnect();
        settle(msg);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        settle({ ok: false, code: "context_invalidated" });
      });
      port.postMessage({ audio, mime });
    });
  }

  // O resultado de uma execução que a pessoa cancelou ou fechou chega depois e
  // não pode sobrescrever a tela: cada execução tem um número, e o estado também.
  const current = (id, state, run) => states.get(id) === state && state.run === run;

  function cancel(id) {
    jobs.get(id)?.();
    states.delete(id);
    paint(id);
  }

  async function transcribe(id) {
    const state = ensureState(id);
    if (state.status === "working") return;
    const run = (state.run || 0) + 1;
    Object.assign(state, { run, status: "working", error: null, text: "", summary: null, sumStatus: null });
    paint(id);
    try {
      // Antes de tocar o áudio: órfão, ele seria marcado como ouvido à toa.
      if (!alive()) throw { code: "context_invalidated" };
      const { b64, mime, duration } = await grabQueued(id);
      if (!current(id, state, run)) return;
      state.duration = Number.isFinite(duration) ? duration : null;
      const res = await requestTranscription(id, b64, mime, (segment) => {
        state.text += segment;
        paint(id);
      });
      if (!current(id, state, run)) return;
      if (!res.ok) throw res;
      state.text = res.data.text || "";
      state.duration ??= res.data.duration || null;
      state.status = "done";
      // Para a página de pesquisa saber de onde veio. A linha pode ter sumido da tela.
      const row = rowFor(id);
      state.chat = chatTitle();
      state.who = row ? senderOf(row, id) : null;
      state.at = Date.now();
      persist(id);
    } catch (err) {
      if (!current(id, state, run)) return;
      state.status = "error";
      state.error = errorText(err);
    }
    paint(id);
    if (state.status === "done" && settings.autoSummary && state.text && state.duration >= LONG_AUDIO_S) summarize(id);
  }

  async function summarize(id) {
    const state = states.get(id);
    if (!state?.text || state.sumStatus === "working") return;
    state.sumStatus = "working";
    state.sumError = null;
    paint(id);
    let res;
    try {
      if (!alive()) throw { code: "context_invalidated" };
      res = await chrome.runtime.sendMessage({ type: "summarize", text: state.text });
    } catch (err) {
      res = { ok: false, code: err?.code, message: String(err?.message || err) };
    }
    if (states.get(id) !== state) return; // fechada enquanto resumia
    if (res?.ok) {
      state.summary = res.data.summary;
      state.sumStatus = "done";
      persist(id);
    } else {
      state.sumStatus = "error";
      state.sumError = errorText(res || { code: "context_invalidated" });
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
      status.append(waveform(), h("span", null, "Transcrevendo…"), action("Cancelar", () => cancel(id), "ghost"));
      card.append(status, h("p", "escuta-text", state.text.trim()));
      root.append(card);
      return;
    }

    if (state.status === "working") {
      const status = h("div", "escuta-working");
      status.setAttribute("role", "status");
      status.append(waveform(), h("span", null, "Transcrevendo…"), action("Cancelar", () => cancel(id), "ghost"));
      root.append(status);
      return;
    }

    if (state.status === "error") {
      const box = h("div", "escuta-card escuta-card--error");
      const bar = h("div", "escuta-actions");
      // Órfão, tentar de novo não adianta: só recarregar a página liga a extensão de volta.
      const retry = alive()
        ? action("Tentar de novo", () => transcribe(id), "primary")
        : action("Recarregar o WhatsApp", () => location.reload(), "primary");
      bar.append(retry, action("Fechar", () => cancel(id)));
      box.append(h("p", "escuta-error", state.error), bar);
      root.append(box);
      return;
    }

    const label = ["Transcrição", fmtDuration(state.duration)].filter(Boolean).join(" · ");

    // Recolhida: só uma pílula. O texto continua salvo e volta num clique.
    if (state.collapsed) {
      const btn = action(`${label}${state.summary ? " · com resumo" : ""}`, () => setCollapsed(id, false), "start");
      btn.prepend(waveform());
      btn.title = "Mostrar a transcrição";
      btn.setAttribute("aria-expanded", "false");
      root.append(btn);
      return;
    }

    const card = h("div", "escuta-card");
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
        try {
          await navigator.clipboard.writeText(state.summary ? `${state.text}\n\nResumo: ${state.summary}` : state.text);
          copy.textContent = "Copiado ✓";
        } catch {
          copy.textContent = "Não copiou";
        }
        setTimeout(() => (copy.textContent = "Copiar"), 1500);
      });
      bar.append(copy);
    }
    if (state.text) {
      const hide = action("Recolher", () => setCollapsed(id, true));
      hide.setAttribute("aria-expanded", "true");
      bar.append(hide);
    }
    // Apagar pede um segundo clique: a transcrição salva some de vez.
    const erase = action("Apagar", () => {
      if (erase.dataset.armed) {
        states.delete(id);
        forget(id);
        paint(id);
        return;
      }
      erase.dataset.armed = "1";
      erase.textContent = "Apagar mesmo?";
      erase.classList.add("escuta-btn--danger");
      setTimeout(() => {
        if (!erase.isConnected) return;
        delete erase.dataset.armed;
        erase.textContent = "Apagar";
        erase.classList.remove("escuta-btn--danger");
      }, 3000);
    });
    bar.append(erase);
    card.append(bar);
    root.append(card);
  }

  function setCollapsed(id, collapsed) {
    const state = states.get(id);
    if (!state) return;
    state.collapsed = collapsed;
    persist(id);
    paint(id);
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
    for (const row of voiceRows()) {
      if (row.querySelector(":scope > .escuta")) continue;
      const id = row.getAttribute("data-id");
      ensureState(id);
      paint(id);
      maybeAuto(id, row);
    }
    report(health());
  }

  // ---- saúde dos seletores ------------------------------------------------

  // Sinais largos de "tem mensagem de voz aqui", que não dependem dos seletores
  // finos lá de cima. Achar isso sem nenhuma mensagem reconhecida quer dizer que
  // o WhatsApp mudou o HTML de novo: em vez de sumir calado, o ícone avisa.
  const LOOSE = /voice|voz|ptt|áudio|audio/i;
  const SLIDER =
    '[role="slider"], input[type="range"], [aria-label*="slider" i], [aria-label*="progress" i], [aria-label*="progresso" i]';
  const BROKEN_AFTER_MS = 3000; // a conversa carregando passa por estados estranhos

  const nameOf = (el) =>
    el.tagName.toLowerCase() === "title" ? el.textContent : el.getAttribute("aria-label") || el.getAttribute("data-icon") || "";

  function looseVoiceRows(root) {
    const rows = new Set();
    for (const el of root.querySelectorAll("[aria-label], [data-icon], svg title")) {
      if (!LOOSE.test(nameOf(el))) continue;
      const row = el.closest(SEL.message) || el.closest('[role="row"]');
      // Áudio de verdade tem barra de progresso; citação de áudio numa resposta não.
      if (row?.querySelector(SLIDER)) rows.add(row);
    }
    return rows;
  }

  let brokenSince = 0;

  function health() {
    const root = document.querySelector("#main");
    if (!root) return { chat: false, messages: 0, voice: 0, broken: false };
    const messages = root.querySelectorAll(SEL.message).length;
    const voice = voiceRows().length;
    const suspect =
      (messages === 0 && root.querySelectorAll('[role="row"]').length > 0) || (voice === 0 && looseVoiceRows(root).size > 0);
    if (!suspect) brokenSince = 0;
    else if (!brokenSince) {
      brokenSince = Date.now();
      setTimeout(scan, BROKEN_AFTER_MS + 100); // confere de novo mesmo sem mudança na página
    }
    return { chat: true, messages, voice, broken: Boolean(brokenSince) && Date.now() - brokenSince >= BROKEN_AFTER_MS };
  }

  let lastBroken = null;

  function report(status) {
    if (status.broken === lastBroken) return;
    lastBroken = status.broken;
    safely("não avisou o ícone", () => chrome.runtime.sendMessage({ type: "selectors", broken: status.broken }));
  }

  // O que o botão Diagnóstico do popup copia: nomes de ícones e rótulos de botão,
  // nunca o texto das mensagens. É o que basta para atualizar SEL e ICON.
  function diagnose() {
    const root = document.querySelector("#main") || document.body;
    const icons = [...new Set([...root.querySelectorAll("[data-icon], svg title")].map(nameOf).filter(Boolean))];
    const labels = [
      ...new Set(
        [...root.querySelectorAll("[aria-label]")]
          .map(nameOf)
          .filter((l) => /voz|voice|reproduz|play|tocar|paus|áudio|audio|ouvir|slider|progress/i.test(l)),
      ),
    ];
    const anchor = [...looseVoiceRows(root)][0]?.querySelector(SLIDER) || root.querySelector(SEL.voiceLabel);
    const chain = [];
    for (let el = anchor; el && el !== root && chain.length < 18; el = el.parentElement) {
      const attrs = [...el.attributes]
        .filter((a) => /^(data-|role$|aria-label$)/.test(a.name))
        .map((a) => `[${a.name}="${a.name === "data-id" ? `${a.value.slice(0, 6)}…` : a.value.slice(0, 40)}"]`);
      chain.push(el.tagName.toLowerCase() + attrs.join(""));
    }
    const { messages, voice, broken } = health();
    return { version: chrome.runtime.getManifest().version, at: new Date().toISOString(), messages, voice, broken, icons, labels, chain };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "page-status") reply(health());
    else if (msg.type === "page-diagnose") reply(diagnose());
  });

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
