(() => {
  // WhatsApp Web changes its markup often. Everything that depends on it lives in this block.
  const SEL = {
    voiceIcon:
      '[data-icon="audio-play"], [data-icon="audio-pause"], [data-icon="audio-download"], [data-icon="ptt-status"]',
    playIcon: '[data-icon="audio-play"], [data-icon="audio-download"], [data-icon*="play"]',
    pauseIcon: '[data-icon="audio-pause"], [data-icon*="pause"]',
    playLabel: '[aria-label*="Reproduzir" i], [aria-label*="Play" i], [aria-label*="voz" i], [aria-label*="voice" i]',
    message: "[data-id]",
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
      const onMessage = (event) => {
        const msg = event.data;
        if (event.source !== window || !msg?.escuta || msg.token !== token) return;
        if (msg.type === "audio") finish(resolve, msg);
        else if (msg.type === "error") finish(reject, { code: "audio_timeout" });
      };
      const timer = setTimeout(() => {
        window.postMessage({ escuta: true, type: "disarm" }, location.origin);
        finish(reject, { code: "audio_timeout" });
      }, 25000);

      window.addEventListener("message", onMessage);
      window.postMessage({ escuta: true, type: "arm", token, playing }, location.origin);
      if (playing) return; // already playing: page-hook grabs it directly

      const target = row.querySelector(SEL.playIcon) || row.querySelector(SEL.playLabel);
      const button = target?.closest('button, [role="button"]') || target;
      if (!button) {
        console.debug("[escuta] play button not found", row.outerHTML.slice(0, 1500));
        window.postMessage({ escuta: true, type: "disarm" }, location.origin);
        finish(reject, { code: "no_audio" });
        return;
      }
      button.click();
    });
  }

  async function transcribe(id, row) {
    const state = states.get(id);
    state.status = "working";
    state.error = null;
    paint(id);
    try {
      const { b64, mime, duration } = await grabAudio(row);
      state.duration = duration;
      const res = await chrome.runtime.sendMessage({ type: "transcribe", audio: b64, mime });
      if (!res.ok) throw res;
      state.text = res.data.text || "";
      state.status = "done";
    } catch (err) {
      state.status = "error";
      state.error = errorText(err);
    }
    paint(id);
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

  function renderInto(root, id, row) {
    const state = states.get(id);
    root.replaceChildren();

    if (state.status === "idle") {
      const btn = action("Transcrever", () => transcribe(id, row), "start");
      btn.prepend(waveform());
      root.append(btn);
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
      box.append(h("p", "escuta-error", state.error), action("Tentar de novo", () => transcribe(id, row)));
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
        paint(id);
      }),
    );
    card.append(bar);
    root.append(card);
  }

  function paint(id) {
    const row = document.querySelector(`${SEL.message}[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    if (!states.has(id)) states.set(id, { status: "idle" });
    let root = row.querySelector(":scope > .escuta");
    if (!root) {
      root = h("div", "escuta");
      if (id.startsWith("true_")) root.classList.add("escuta--out");
      row.append(root);
    }
    renderInto(root, id, row);
  }

  // ---- discovery ---------------------------------------------------------

  function scan() {
    for (const icon of document.querySelectorAll(SEL.voiceIcon)) {
      const row = icon.closest(SEL.message);
      if (!row || row.querySelector(":scope > .escuta")) continue;
      const id = row.getAttribute("data-id");
      if (!states.has(id)) states.set(id, { status: "idle" });
      paint(id);
    }
  }

  let pending = 0;
  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(scan, 250);
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
