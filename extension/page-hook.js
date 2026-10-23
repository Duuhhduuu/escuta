// Runs in the page's own JS world (manifest "world": "MAIN") so it can see the audio
// elements WhatsApp builds. While armed by content.js, the next voice note that starts
// playing is muted, copied out as base64, then paused, so nothing is heard.
(() => {
  if (window.__escutaHook) return;
  window.__escutaHook = true;

  const ARM_MS = 20000;
  const RELEASE_MS = 300;

  let armed = null; // { token, timer }
  const touched = new Set(); // media elements we muted
  const seen = []; // WeakRefs to every element that called play()

  const post = (payload) => window.postMessage({ escuta: true, ...payload }, location.origin);
  const isBlob = (el) => (el.currentSrc || el.src || "").startsWith("blob:");

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function release() {
    for (const el of touched) {
      el.pause();
      el.muted = false;
      try {
        el.currentTime = 0;
      } catch {}
    }
    touched.clear();
  }

  function disarm() {
    if (!armed) return;
    clearTimeout(armed.timer);
    armed = null;
  }

  // mute=false: o áudio já estava tocando porque a pessoa está ouvindo. Só copia,
  // sem silenciar nem pausar no meio.
  async function capture(el, token, mute = true) {
    try {
      const blob = await (await fetch(el.currentSrc || el.src)).blob();
      post({ type: "audio", token, b64: await toBase64(blob), mime: blob.type || "audio/ogg", duration: el.duration });
    } catch (err) {
      post({ type: "error", token, message: String(err) });
    } finally {
      if (mute) setTimeout(release, RELEASE_MS);
    }
  }

  function tryCapture(el) {
    if (!armed || !isBlob(el)) return false;
    const { token } = armed;
    disarm();
    el.muted = true;
    touched.add(el);
    capture(el, token);
    return true;
  }

  function findPlaying() {
    const live = seen.map((ref) => ref.deref()).filter(Boolean);
    return [...live, ...document.querySelectorAll("audio")].find((el) => !el.paused && isBlob(el));
  }

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    // Sem poda a lista cresce a cada play durante horas de WhatsApp aberto.
    if (seen.length > 50) seen.splice(0, seen.length, ...seen.filter((ref) => ref.deref()?.isConnected).slice(-20));
    if (!seen.some((ref) => ref.deref() === this)) seen.push(new WeakRef(this));
    if (armed) {
      // Mute before the first sample, even if the source is attached a moment later.
      this.muted = true;
      touched.add(this);
      if (!tryCapture(this)) this.addEventListener("loadedmetadata", () => tryCapture(this), { once: true });
    }
    return nativePlay.apply(this, args);
  };

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== window || !msg?.escuta) return;

    if (msg.type === "disarm") {
      disarm();
      release();
    } else if (msg.type === "arm") {
      disarm();
      const playing = msg.playing && findPlaying();
      if (playing) {
        capture(playing, msg.token, false);
        return;
      }
      armed = {
        token: msg.token,
        timer: setTimeout(() => {
          disarm();
          release();
          post({ type: "error", token: msg.token, message: "timeout" });
        }, ARM_MS),
      };
      post({ type: "armed", token: msg.token });
    }
  });
})();
