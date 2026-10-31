// Grava a reunião: o áudio da aba (os outros participantes) e o microfone (você),
// num arquivo estéreo com o microfone à esquerda e a aba à direita. O servidor
// transcreve cada lado sozinho e sabe quem falou sem precisar adivinhar vozes.
(() => {
  const CHUNK_MS = 10_000;
  const MIC_WAIT_MS = 1_500; // um documento offscreen não mostra o pedido de permissão: sem resposta, segue sem microfone
  const BITRATE = 96_000; // dois canais: a voz perde menos detalhe, que o Whisper usa para acertar

  let job = null;

  // ---- transcrição ao vivo ----------------------------------------------------------
  // Cada canal passa por um captador (pcm-tap.js) que entrega blocos de 100 ms. Aqui eles
  // viram PCM de 16 kHz e são cortados nas pausas da fala, não de tempo em tempo: janela de
  // tempo fixo parte frases ao meio e o Whisper erra as pontas. Cada janela vai para /live.
  const LIVE = {
    voiceRms: 0.01, // acima disso o bloco de 100 ms conta como fala (no seu microfone)
    voiceRmsOthers: 0.005, // a voz dos outros chega mais baixa, vinda da chamada; abaixo disso é ruído
    minWindowMs: 1800, // janela mais curta que isso espera mais fala, a não ser que haja pausa longa
    pauseMs: 450, // pausa que fecha uma frase
    maxWindowMs: 8000, // ninguém espera mais que isso para ver texto
    minVoiceMs: 200, // menos fala que isso na janela é tecla ou estalo: descarta. "Tá", "é", "não" e "sim" cabem aqui
    minPartialVoiceMs: 500, // o provisório é mais exigente: um palpite sobre meia palavra só atrapalha
    missedVoiceMs: 1200, // janela com tanta voz e nenhum texto do modelo aparece no painel como "(não entendi)"
    dropSilenceMs: 1500,
    maxQueue: 60, // servidor mais lento que a fala: só então descarta as mais velhas
    timeoutMs: 60_000,
    retries: 3, // uma janela que falha tenta de novo antes de ser dada como perdida
    retryMs: 1500,
    drainMs: 25_000, // ao parar, espera a fila esvaziar até aqui
    partialFirstMs: 700, // o primeiro provisório de uma frase sai cedo: é o que dá a sensação de "escrevendo"
    partialMs: 900, // depois, a cada tanto de fala nova
    partialMaxMs: 6000, // o provisório olha só os últimos segundos da frase: mais barato e continua rápido em frase longa
    partialTimeoutMs: 8000,
  };

  // 48 kHz -> 16 kHz por média de 3 amostras (basta para voz) e PCM de 16 bits.
  function downsample(block) {
    const out = new Int16Array(block.length / 3);
    let energy = 0;
    for (let i = 0; i < out.length; i++) {
      const v = (block[3 * i] + block[3 * i + 1] + block[3 * i + 2]) / 3;
      energy += v * v;
      out[i] = Math.max(-1, Math.min(1, v)) * 32767;
    }
    return { pcm: out, rms: Math.sqrt(energy / out.length) };
  }

  function liveChannel(who, emit, partial) {
    let frames = [];
    let ms = 0; // duração do que está pendente
    let voiceMs = 0;
    let silentMs = 0;
    let startMs = 0; // onde a janela pendente começa, desde o início da gravação
    let clock = 0; // total de áudio visto neste canal
    let lastPartial = 0;

    const reset = () => {
      frames = [];
      ms = voiceMs = silentMs = 0;
      lastPartial = 0;
    };

    // Os últimos segundos da frase em andamento, para o texto provisório.
    function snapshot() {
      const kept = frames.slice(-LIVE.partialMaxMs / 100);
      const pcm = new Int16Array(kept.length * kept[0].length);
      kept.forEach((frame, i) => pcm.set(frame, i * frame.length));
      return { who, t0: (clock - kept.length * 100) / 1000, pcm };
    }

    function flush() {
      const pcm = new Int16Array(frames.length * frames[0].length);
      frames.forEach((frame, i) => pcm.set(frame, i * frame.length));
      emit({ who, t0: startMs / 1000, pcm, voiceMs });
      reset();
    }

    // Ao parar: a frase que estava no meio da janela também vai, em vez de ser descartada.
    const finish = () => {
      if (frames.length && voiceMs >= LIVE.minVoiceMs) flush();
    };

    const push = (block) => {
      const { pcm, rms } = downsample(block);
      if (!frames.length) startMs = clock;
      clock += 100;
      frames.push(pcm);
      ms += 100;
      if (rms > (who === "outros" ? LIVE.voiceRmsOthers : LIVE.voiceRms)) {
        voiceMs += 100;
        silentMs = 0;
      } else {
        silentMs += 100;
      }

      if (!voiceMs && ms > 1000) {
        // Só silêncio: não acumula. Guarda os últimos 300 ms para não comer o começo da próxima fala.
        frames = frames.slice(-3);
        ms = 300;
        startMs = clock - 300;
      } else if (silentMs >= LIVE.dropSilenceMs && voiceMs < LIVE.minVoiceMs) {
        partial?.clear(who); // era barulho, não fala: o provisório some
        reset();
      } else if (voiceMs >= LIVE.minVoiceMs && ((silentMs >= LIVE.pauseMs && ms >= LIVE.minWindowMs) || ms >= LIVE.maxWindowMs)) {
        flush();
      } else if (partial && voiceMs >= LIVE.minPartialVoiceMs && silentMs < LIVE.pauseMs && clock - (lastPartial || startMs) >= (lastPartial ? LIVE.partialMs : LIVE.partialFirstMs)) {
        lastPartial = clock;
        partial.send(snapshot());
      }
    };
    push.finish = finish;
    return push;
  }

  async function startLive(ctx, nodes, cfg) {
    await ctx.audioWorklet.addModule(chrome.runtime.getURL("pcm-tap.js"));
    const abort = new AbortController();
    const queue = [];
    const lastText = { voce: "", outros: "" };
    // A mesma frase de novo, colada na anterior, é o Whisper repetindo. Mais de 3 s depois é a pessoa repetindo ("Sim." ... "Sim.").
    const lastLine = { voce: { text: "", end: -99 }, outros: { text: "", end: -99 } };
    const plain = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    let busy = false;
    let failing = false;
    const tell = (payload) => chrome.runtime.sendMessage(payload).catch(() => {});

    async function request(job, signal, partial = false) {
      const query = new URLSearchParams({ language: cfg.language, model: cfg.model, prompt: lastText[job.who] });
      if (partial) query.set("partial", "1"); // o servidor só devolve o que ouviu com confiança
      const res = await fetch(`${cfg.base}/live?${query}`, {
        method: "POST",
        body: new Blob([job.pcm.buffer]),
        headers: cfg.token ? { "X-Escuta-Token": cfg.token } : {},
        signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `Erro ${res.status}`);
      const { segments } = await res.json();
      return segments.map((s) => ({ who: job.who, start: job.t0 + s.start, end: job.t0 + s.end, text: s.text, ...(s.sound ? { sound: true } : {}) }));
    }

    async function send(job) {
      const all = await request(job, AbortSignal.any([abort.signal, AbortSignal.timeout(LIVE.timeoutMs)]));
      // Janela com voz de verdade (mais de 1,2 s) em que o modelo não achou fala nem som: em vez de sumir sem aviso,
      // o painel mostra "(não entendi)" no horário dela. Só no painel, não entra na transcrição salva nem na ata.
      if (!all.length && (job.voiceMs || 0) >= LIVE.missedVoiceMs) {
        all.push({ who: job.who, start: job.t0, end: job.t0 + job.pcm.length / 16000, text: "não entendi", sound: true });
      }
      const before = lastLine[job.who];
      const lines = all.filter((l) => !(plain(l.text) === before.text && l.start - before.end < 3));
      if (lines.length) {
        const tail = lines[lines.length - 1];
        lastLine[job.who] = { text: plain(tail.text), end: tail.end };
      }
      if (lines.length) {
        const said = lines.filter((l) => !l.sound).map((l) => l.text); // "hum" e "ruído" não servem de dica ao Whisper
        if (said.length) lastText[job.who] = `${lastText[job.who]} ${said.join(" ")}`.trim().slice(-220);
        tell({ type: "live-text", lines });
      }
    }

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function pump() {
      if (busy) return;
      busy = true;
      try {
        while (queue.length && !abort.signal.aborted) {
          const next = queue.shift();
          try {
            await send(next);
            pending(next, false); // o texto já foi (live-text vem antes)
            if (failing) tell({ type: "live-status", error: null });
            failing = false;
          } catch (err) {
            if (abort.signal.aborted) return;
            next.tries = (next.tries || 0) + 1;
            if (next.tries <= LIVE.retries) {
              // Servidor ocupado ou reiniciando: a janela volta para a frente da fila em vez de se perder.
              queue.unshift(next);
              await wait(LIVE.retryMs * next.tries);
              continue;
            }
            // Esgotou as tentativas: a janela se perde. A reunião fica sabendo que o texto ao vivo tem
            // buraco e, no fim, transcreve o áudio inteiro em vez de confiar nele.
            tell({ type: "live-status", error: String(err.message || err), lost: true });
            pending(next, false);
            failing = true;
          }
        }
      } finally {
        busy = false;
      }
    }

    // Texto provisório: a frase ainda em andamento, transcrita de novo a cada poucos instantes. É um extra e
    // nunca atrasa o que vale: só sai com a fila vazia, não é salvo e some quando a frase fecha.
    let partialBusy = false;
    const partial = {
      async send(job) {
        if (partialBusy || busy || queue.length || abort.signal.aborted) return;
        partialBusy = true;
        try {
          const lines = await request(job, AbortSignal.any([abort.signal, AbortSignal.timeout(LIVE.partialTimeoutMs)]), true);
          if (!busy && !queue.length && !abort.signal.aborted) tell({ type: "live-partial", who: job.who, t0: job.t0, lines });
        } catch {
          // sem provisório, a pessoa só espera a frase fechar
        } finally {
          partialBusy = false;
        }
      },
      clear: (who) => tell({ type: "live-partial", who, t0: 0, lines: [] }),
    };

    // Cada janela enviada ao servidor aparece no painel como "…" na posição do horário dela até o texto chegar,
    // para a fala de quem terminou primeiro não passar à frente da que ainda está sendo transcrita.
    let jobSeq = 0;
    const pending = (job, on) => tell({ type: "live-pending", id: job.id, who: job.who, t0: job.t0, on });

    function enqueue(job) {
      job.id = ++jobSeq;
      pending(job, true);
      queue.push(job);
      if (queue.length > LIVE.maxQueue) {
        pending(queue.shift(), false);
        tell({ type: "live-status", lag: true });
      }
      pump();
    }

    const sink = ctx.createGain(); // o worklet só roda se estiver ligado ao destino; ganho 0 não toca nada
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    const taps = [];
    const pushes = [];
    for (const [who, node] of Object.entries(nodes)) {
      if (!node) continue;
      const tap = new AudioWorkletNode(ctx, "pcm-tap");
      const push = liveChannel(who, enqueue, partial);
      pushes.push(push);
      tap.port.onmessage = (event) => {
        if (!job?.paused) push(event.data); // pausado: o texto ao vivo também espera
      };
      node.connect(tap);
      tap.connect(sink);
      taps.push(tap);
    }

    const stopLive = () => {
      abort.abort();
      queue.length = 0;
      for (const tap of taps) tap.disconnect();
    };
    // Termina o texto ao vivo: fecha a frase pendente de cada canal e espera a fila esvaziar.
    stopLive.drain = async () => {
      for (const push of pushes) push.finish();
      const until = Date.now() + LIVE.drainMs;
      while ((queue.length || busy) && Date.now() < until) await wait(200);
    };
    return stopLive;
  }

  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms))]);

  // Reunião gravada de dentro da página (Meet): o áudio chega em blocos de PCM de 16 kHz, duas
  // pistas, e aqui vira dois fluxos como se fossem a aba e o microfone, então o resto da gravação
  // (arquivo estéreo, texto ao vivo) é o mesmo de sempre.
  function createPageInput(ctx) {
    const dest = { voce: ctx.createMediaStreamDestination(), outros: ctx.createMediaStreamDestination() };
    const next = { voce: 0, outros: 0 };
    function feed(who, pcm) {
      const floats = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768;
      const buffer = ctx.createBuffer(1, floats.length, 16000);
      buffer.copyToChannel(floats, 0);
      const now = ctx.currentTime;
      if (next[who] < now + 0.05) next[who] = now + 0.3; // folga contra o atraso da mensagem
      // Blocos podem chegar em rajada (a extensão acorda e entrega o atraso de uma vez). Enfileira em
      // vez de perder fala; só descarta se o atraso virar absurdo, o que indica relógios desencontrados.
      if (next[who] > now + 10) {
        next[who] = now + 0.3;
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(dest[who]);
      source.start(next[who]);
      next[who] += buffer.duration;
    }
    return { voce: dest.voce.stream, outros: dest.outros.stream, feed };
  }

  const fromBase64 = (text) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  };

  async function start({ streamId, recId, live, mic: micAllowed, source }) {
    if (job) throw new Error("Já existe uma gravação em andamento.");

    let tab;
    let mic = null;
    let micError = null;
    let ctx;
    let pageIn = null;
    if (source === "page") {
      ctx = new AudioContext({ sampleRate: 48000 });
      pageIn = createPageInput(ctx);
      tab = pageIn.outros;
      mic = pageIn.voce;
    } else {
      tab = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      });
      try {
        // O popup diz se o microfone já foi liberado. Sem permissão, nem tenta: gravar não espera por ele.
        if (micAllowed === false) throw Object.assign(new Error("sem permissão"), { name: "NotAllowedError" });
        mic = await withTimeout(
          navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
          MIC_WAIT_MS,
        );
      } catch (err) {
        micError = err.name || "erro";
      }
      ctx = new AudioContext({ sampleRate: 48000 });
    }
    // Sem gesto da pessoa neste documento invisível, o navegador pode deixar o áudio suspenso:
    // o arquivo sairia mudo. Acorda explicitamente.
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    const merger = ctx.createChannelMerger(2);
    // Cada fonte vira mono antes de entrar no seu canal.
    const toChannel = (stream, channel) => {
      const source = ctx.createMediaStreamSource(stream);
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = "explicit";
      source.connect(mono);
      mono.connect(merger, 0, channel);
      return { source, mono };
    };
    const micNodes = mic ? toChannel(mic, 0) : null;
    const tabNodes = toChannel(tab, 1);
    // Capturar a aba a deixa muda; tocar de volta mantém o som para quem está na reunião.
    if (!pageIn) tabNodes.source.connect(ctx.destination); // na página, o Meet já toca o som sozinho

    // A prévia ao vivo é um extra: se o captador não carregar, a gravação segue sem ela.
    let stopLive = null;
    let liveError = null;
    if (live) {
      try {
        stopLive = await startLive(ctx, { voce: micNodes?.mono, outros: tabNodes.mono }, live);
      } catch (err) {
        console.warn("[escuta] transcrição ao vivo indisponível:", err);
        liveError = String(err?.message || err); // o painel mostra, em vez de falhar em silêncio
      }
    }

    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    dest.channelCountMode = "explicit";
    dest.channelInterpretation = "discrete";
    merger.connect(dest);

    const recorder = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: BITRATE });
    const state = { recId, recorder, ctx, stopLive, streams: [tab, mic].filter(Boolean), n: 0, writes: Promise.resolve(), writeError: null, startedAt: Date.now(), mic: Boolean(mic), pageIn, paused: false, pausedAt: 0, pausedMs: 0 };
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      const i = state.n++;
      state.writes = state.writes
        .then(() => RecDB.add(recId, i, event.data))
        .catch((err) => {
          state.writeError = err;
        });
    };
    // A aba fechou ou a captura foi cortada: avisa o background para fechar a gravação.
    tab.getAudioTracks()[0]?.addEventListener("ended", () => chrome.runtime.sendMessage({ type: "rec-ended" }).catch(() => {}));

    recorder.start(CHUNK_MS);
    job = state;
    return { ok: true, mic: state.mic, micError, live: Boolean(stopLive), liveError };
  }

  async function stop() {
    if (!job) return { ok: false, message: "Nenhuma gravação em andamento." };
    const state = job;
    job = null;
    await new Promise((resolve) => {
      if (state.recorder.state === "inactive") return resolve();
      state.recorder.onstop = resolve;
      state.recorder.stop();
    });
    // O áudio já está salvo. Agora o texto ao vivo termina o que faltava, para a ata sair completa.
    await state.stopLive?.drain?.().catch(() => {});
    state.stopLive?.();
    await state.writes; // o último pedaço chega antes do evento stop, mas a gravação no disco demora um instante
    for (const stream of state.streams) for (const track of stream.getTracks()) track.stop();
    await state.ctx.close().catch(() => {});
    if (state.writeError) return { ok: false, message: `Não consegui salvar a gravação: ${state.writeError.message || state.writeError}`, chunks: state.n };
    const paused = state.pausedMs + (state.paused ? Date.now() - state.pausedAt : 0);
    return { ok: true, duration: (Date.now() - state.startedAt - paused) / 1000, chunks: state.n, mic: state.mic };
  }

  // Pausar só segura o MediaRecorder: o arquivo não ganha o tempo parado. O som da reunião
  // continua tocando normalmente.
  function pause() {
    if (!job) return { ok: false, message: "Nenhuma gravação em andamento." };
    if (!job.paused) {
      job.recorder.pause();
      job.paused = true;
      job.pausedAt = Date.now();
    }
    return { ok: true };
  }

  function resume() {
    if (!job) return { ok: false, message: "Nenhuma gravação em andamento." };
    if (job.paused) {
      job.recorder.resume();
      job.pausedMs += Date.now() - job.pausedAt;
      job.paused = false;
    }
    return { ok: true };
  }

  const fail = (err) => ({ ok: false, message: String(err?.message || err), name: err?.name });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "page-audio") {
      // Áudio do Meet. Sem gravação em andamento, é resto de antes de parar: ignora.
      const pageIn = job?.paused ? null : job?.pageIn;
      if (pageIn) {
        pageIn.feed("voce", fromBase64(msg.voce));
        pageIn.feed("outros", fromBase64(msg.outros));
      }
      return;
    }
    if (msg?.target !== "offscreen") return; // mensagem para outro contexto: não responde
    if (msg.type === "start") start(msg).then(reply, (err) => reply(fail(err)));
    else if (msg.type === "stop") stop().then(reply, (err) => reply(fail(err)));
    else if (msg.type === "pause") reply(pause());
    else if (msg.type === "resume") reply(resume());
    else return;
    return true;
  });
})();
