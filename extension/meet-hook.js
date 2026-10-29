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
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      source.connect(mixes[who]);
      sources.set(track, source);
      track.addEventListener("ended", () => {
        source.disconnect();
        sources.delete(track);
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
      post({ type: "audio", voce, outros }, [voce, outros]);
    };
    const mute = ctx.createGain(); // o processador só roda ligado ao destino; ganho 0 não toca nada
    mute.gain.value = 0;
    merger.connect(tap);
    tap.connect(mute);
    mute.connect(ctx.destination);

    capture = { ctx, attach, sources };
    for (const track of locals) attach("voce", track);
    for (const track of remotes) attach("outros", track);
    for (const pc of pcs) for (const receiver of pc.getReceivers?.() || []) if (receiver.track?.kind === "audio") addTrack(remotes, receiver.track);
    ctx.resume().catch(() => {});
  }

  function stopCapture() {
    if (!capture) return;
    const { ctx } = capture;
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
