// Grava a reunião: o áudio da aba (os outros participantes) e o microfone (você),
// num arquivo estéreo com o microfone à esquerda e a aba à direita. O servidor
// transcreve cada lado sozinho e sabe quem falou sem precisar adivinhar vozes.
(() => {
  const CHUNK_MS = 10_000;
  const MIC_WAIT_MS = 5_000; // um documento offscreen não mostra o pedido de permissão: sem resposta, segue sem microfone
  const BITRATE = 64_000;

  let job = null;

  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms))]);

  async function start({ streamId, recId }) {
    if (job) throw new Error("Já existe uma gravação em andamento.");

    const tab = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });

    let mic = null;
    let micError = null;
    try {
      mic = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
        MIC_WAIT_MS,
      );
    } catch (err) {
      micError = err.name || "erro";
    }

    const ctx = new AudioContext({ sampleRate: 48000 });
    const merger = ctx.createChannelMerger(2);
    // Cada fonte vira mono antes de entrar no seu canal.
    const toChannel = (stream, channel) => {
      const source = ctx.createMediaStreamSource(stream);
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = "explicit";
      source.connect(mono);
      mono.connect(merger, 0, channel);
      return source;
    };
    if (mic) toChannel(mic, 0);
    const tabSource = toChannel(tab, 1);
    // Capturar a aba a deixa muda; tocar de volta mantém o som para quem está na reunião.
    tabSource.connect(ctx.destination);

    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    dest.channelCountMode = "explicit";
    dest.channelInterpretation = "discrete";
    merger.connect(dest);

    const recorder = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: BITRATE });
    const state = { recId, recorder, ctx, streams: [tab, mic].filter(Boolean), n: 0, writes: Promise.resolve(), writeError: null, startedAt: Date.now(), mic: Boolean(mic) };
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
    return { ok: true, mic: state.mic, micError };
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
    await state.writes; // o último pedaço chega antes do evento stop, mas a gravação no disco demora um instante
    for (const stream of state.streams) for (const track of stream.getTracks()) track.stop();
    await state.ctx.close().catch(() => {});
    if (state.writeError) return { ok: false, message: `Não consegui salvar a gravação: ${state.writeError.message || state.writeError}`, chunks: state.n };
    return { ok: true, duration: (Date.now() - state.startedAt) / 1000, chunks: state.n, mic: state.mic };
  }

  const fail = (err) => ({ ok: false, message: String(err?.message || err), name: err?.name });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.target !== "offscreen") return; // mensagem para outro contexto: não responde
    if (msg.type === "start") start(msg).then(reply, (err) => reply(fail(err)));
    else if (msg.type === "stop") stop().then(reply, (err) => reply(fail(err)));
    else return;
    return true;
  });
})();
