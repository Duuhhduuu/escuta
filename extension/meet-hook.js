// Gravação automática no Google Meet. Roda no mundo da própria página (manifest "world": "MAIN")
// para ver o que o Meet usa para levar o áudio da chamada: o microfone (getUserMedia) e as
// conexões WebRTC com as faixas dos outros participantes. Daqui sai o áudio, em duas pistas
// (você e os participantes), e o meet-bridge.js o repassa à extensão. Nada disso exige clicar
// no ícone nem dar permissão de microfone: o Meet já tem as duas coisas.
(() => {
  if (window.__escutaMeet) return;
  window.__escutaMeet = true;

  const RATE = 16000; // basta para voz e é o que o Whisper usa
  const BLOCK = 4096; // 256 ms por bloco
  const END_GRACE_MS = 5000; // a chamada pode reconectar; só termina se ficar sem conexão esse tempo

  const post = (payload, transfer) => window.postMessage({ escutaMeet: true, from: "hook", ...payload }, location.origin, transfer || []);

  const locals = new Set(); // faixas do seu microfone
  const remotes = new Set(); // faixas dos outros participantes
  const pcs = new Set();
  let inCall = false;
  let endTimer = 0;
  let capture = null;

  // ---- o que o Meet usa ----------------------------------------------------------------

  const devices = navigator.mediaDevices;
  if (devices?.getUserMedia) {
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      if (constraints?.audio) for (const track of stream.getAudioTracks()) addTrack(locals, track);
      return stream;
    };
  }

  const Native = window.RTCPeerConnection;
  if (Native) {
    const Hooked = function (...args) {
      const pc = new Native(...args);
      pcs.add(pc);
      pc.addEventListener("track", (event) => {
        if (event.track.kind === "audio") addTrack(remotes, event.track);
      });
      pc.addEventListener("connectionstatechange", () => onConnection(pc));
      return pc;
    };
    Hooked.prototype = Native.prototype;
    Object.setPrototypeOf(Hooked, Native);
    window.RTCPeerConnection = Hooked;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Hooked;
  }

  // Uma faixa de entrada (microfone) tem a mesma origem das que o getUserMedia entregou.
  const isLocalId = (track) => [...locals].some((l) => l.id === track.id);

  // Para investigar no console da página do Meet: __escutaDebug()
  const peak = { voce: 0, outros: 0 };
  window.__escutaDebug = () => ({
    gravando: Boolean(capture),
    voce: [...locals].map((t) => ({ id: t.id, estado: t.readyState, mudo: t.muted })),
    outros: [...remotes].map((t) => ({ id: t.id, estado: t.readyState, mudo: t.muted, ativa: t.enabled })),
    conexoes: [...pcs].map((p) => p.connectionState),
    pico: { ...peak }, // maior volume (0 a 1) desde o início da captura: "outros" em 0 = chega mudo
    elementos: [...document.querySelectorAll("audio, video")].map((e) => ({ tag: e.tagName, stream: e.srcObject instanceof MediaStream, faixas: e.srcObject?.getAudioTracks?.().length ?? 0 })),
  });

  function addTrack(set, track) {
    set.add(track);
    track.addEventListener("ended", () => set.delete(track));
    if (capture) capture.attach(set === locals ? "voce" : "outros", track);
  }

  // ---- começo e fim da chamada ------------------------------------------------------------

  function onConnection(pc) {
    const state = pc.connectionState;
    if (state === "closed" || state === "failed") pcs.delete(pc);
    const live = [...pcs].some((p) => p.connectionState === "connected");
    if (live) {
      clearTimeout(endTimer);
      endTimer = 0;
      if (!inCall) {
        inCall = true;
        post({ type: "call", state: "started", title: document.title });
      }
    } else if (inCall && !endTimer) {
      endTimer = setTimeout(() => {
        endTimer = 0;
        if ([...pcs].some((p) => p.connectionState === "connected")) return;
        inCall = false;
        post({ type: "call", state: "ended" });
      }, END_GRACE_MS);
    }
  }
  window.addEventListener("pagehide", () => {
    if (inCall) post({ type: "call", state: "ended" });
  });

  // ---- captura -------------------------------------------------------------------------------

  function startCapture() {
    if (capture) return;
    const ctx = new AudioContext({ sampleRate: RATE });
    const merger = ctx.createChannelMerger(2); // 0 = você, 1 = participantes
    const mixes = { voce: ctx.createGain(), outros: ctx.createGain() };
    mixes.voce.connect(merger, 0, 0);
    mixes.outros.connect(merger, 0, 1);

    const sources = new Map();
    const attach = (who, track) => {
      if (track.readyState !== "live" || sources.has(track)) return;
      const stream = new MediaStream([track]);
      // O Chrome só entrega o som de uma faixa remota (WebRTC) ao Web Audio se ela também estiver
      // ligada a um elemento de mídia. Sem isso o canal dos participantes sai mudo. O elemento fica
      // mudo: quem toca o som para você continua sendo o Meet.
      let keep = null;
      if (who === "outros") {
        keep = new Audio();
        keep.muted = true;
        keep.srcObject = stream;
        keep.play().catch(() => {});
      }
      const source = ctx.createMediaStreamSource(stream);
      source.connect(mixes[who]);
      sources.set(track, source);
      track.addEventListener("ended", () => {
        source.disconnect();
        sources.delete(track);
        if (keep) keep.srcObject = null;
      });
    };

    // O ScriptProcessor (antigo, mas funciona em qualquer página) evita carregar um módulo de
    // áudio, que a política de segurança do Meet poderia barrar.
    const tap = ctx.createScriptProcessor(BLOCK, 2, 2);
    const toPcm = (floats) => {
      const out = new Int16Array(floats.length);
      for (let i = 0; i < floats.length; i++) out[i] = Math.max(-1, Math.min(1, floats[i])) * 32767;
      return out.buffer;
    };
    tap.onaudioprocess = (event) => {
      const voce = toPcm(event.inputBuffer.getChannelData(0));
      const outros = toPcm(event.inputBuffer.getChannelData(1));
      for (const [who, ch] of [["voce", 0], ["outros", 1]]) {
        const data = event.inputBuffer.getChannelData(ch);
        for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > peak[who]) peak[who] = Math.abs(data[i]);
      }
      post({ type: "audio", voce, outros }, [voce, outros]);
    };
    const mute = ctx.createGain(); // o processador só roda ligado ao destino; ganho 0 não toca nada
    mute.gain.value = 0;
    merger.connect(tap);
    tap.connect(mute);
    mute.connect(ctx.destination);

    // Faixas que o Meet liga sem disparar o evento "track" (ou antes de o gancho existir) só
    // aparecem nos receptores da conexão: confere de tempos em tempos enquanto grava.
    const scan = () => {
      for (const pc of pcs) for (const receiver of pc.getReceivers?.() || []) if (receiver.track?.kind === "audio" && !remotes.has(receiver.track)) addTrack(remotes, receiver.track);
      // O que o Meet toca para você sai de elementos <audio>/<video> ligados a um MediaStream:
      // é a voz dos outros, e vale mesmo quando a faixa não passou pelo gancho da conexão.
      for (const el of document.querySelectorAll("audio, video")) {
        const stream = el.srcObject;
        if (!(stream instanceof MediaStream)) continue;
        for (const track of stream.getAudioTracks()) {
          if (track.readyState === "live" && !remotes.has(track) && !locals.has(track) && !isLocalId(track)) addTrack(remotes, track);
        }
      }
    };
    capture = { ctx, attach, sources, scanner: setInterval(scan, 2000) };
    for (const track of locals) attach("voce", track);
    for (const track of remotes) attach("outros", track);
    scan();
    ctx.resume().catch(() => {});
  }

  function stopCapture() {
    if (!capture) return;
    const { ctx, scanner } = capture;
    clearInterval(scanner);
    capture = null;
    ctx.close().catch(() => {});
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window || !data?.escutaMeet || data.from !== "bridge") return;
    if (data.cmd === "start") startCapture();
    else if (data.cmd === "stop") stopCapture();
  });
})();
