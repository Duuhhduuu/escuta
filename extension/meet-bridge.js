// Ponte entre a página do Meet (meet-hook.js, mundo da página) e a extensão. O hook avisa quando
// a chamada começa e termina e entrega o áudio; a extensão manda ligar ou desligar a captura.
(() => {
  if (window.__escutaMeetBridge) return;
  window.__escutaMeetBridge = true;

  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
    return btoa(binary);
  };

  const send = (message) => {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // a extensão foi recarregada com a página aberta: recarregue o Meet
    }
  };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window || !data?.escutaMeet || data.from !== "hook") return;
    if (data.type === "call") send({ type: "meet-call", state: data.state, title: data.title });
    else if (data.type === "audio") send({ type: "page-audio", voce: toBase64(data.voce), outros: toBase64(data.outros) });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "meet-capture") return;
    window.postMessage({ escutaMeet: true, from: "bridge", cmd: msg.action }, location.origin);
  });
})();
