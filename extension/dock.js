// Injetado na aba da reunião (chrome.scripting, quando a pessoa começa a gravar). Desenha um
// painel flutuante no lado direito, como o do Tactiq, que é só uma moldura para live.html: a
// transcrição, as notas e os botões moram lá dentro. Este arquivo cuida da casca: posição,
// minimizar, fechar. Rodá-lo de novo numa aba que já tem o painel só o traz de volta.
(() => {
  const KEY = "__escutaDock";
  if (window[KEY]) {
    window[KEY].show();
    return;
  }

  const host = document.createElement("div");
  host.setAttribute("data-escuta", "dock");
  // O estilo fica dentro de um shadow root fechado: nem o CSS da reunião muda o painel, nem o
  // painel muda a reunião.
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        position: fixed; top: 12px; right: 12px; bottom: 12px; width: 384px; max-width: calc(100vw - 24px);
        z-index: 2147483647; border-radius: 14px; overflow: hidden;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08);
        background: #1c2430;
      }
      .panel iframe { display: block; width: 100%; height: 100%; border: 0; color-scheme: normal; }
      .pill {
        position: fixed; right: 16px; bottom: 96px; z-index: 2147483647; width: 52px; height: 52px;
        display: none; align-items: center; justify-content: center; border: 0; border-radius: 50%;
        background: #3347ff; color: #fff; cursor: pointer; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
      }
      .pill:hover { filter: brightness(1.1); }
      .pill:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
      .pill svg { width: 24px; height: 24px; }
      .minimized .panel { display: none; }
      .minimized .pill { display: flex; }
      @media (prefers-reduced-motion: no-preference) { .panel { animation: in 160ms ease-out; } }
      @keyframes in { from { opacity: 0; transform: translateX(16px); } }
    </style>
    <div class="wrap">
      <div class="panel"></div>
      <button class="pill" type="button" title="Abrir a transcrição ao vivo" aria-label="Abrir a transcrição ao vivo">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="9" width="3" height="6" rx="1.5"/><rect x="8" y="5" width="3" height="14" rx="1.5"/><rect x="13" y="8" width="3" height="8" rx="1.5"/><rect x="18" y="4" width="3" height="16" rx="1.5"/></svg>
      </button>
    </div>`;

  const wrap = root.querySelector(".wrap");
  const frame = document.createElement("iframe");
  frame.title = "Escuta · transcrição ao vivo";
  frame.allow = "clipboard-write"; // o botão Copiar, de dentro da moldura
  frame.src = chrome.runtime.getURL("live.html?dock=1");
  root.querySelector(".panel").append(frame);

  const api = {
    show() {
      wrap.classList.remove("minimized");
      // Só reanexa se a página tiver removido o painel: mover um iframe no DOM recarrega o que há dentro.
      if (!host.isConnected) document.documentElement.append(host);
    },
    minimize() {
      wrap.classList.add("minimized");
    },
    close() {
      window.removeEventListener("message", onMessage);
      host.remove();
      delete window[KEY];
    },
  };

  // A moldura (live.js) pede por postMessage; só vale o que vem dela mesma.
  function onMessage(event) {
    if (event.source !== frame.contentWindow || event.data?.escuta !== "dock") return;
    if (event.data.action === "minimize") api.minimize();
    else if (event.data.action === "close") api.close();
  }
  window.addEventListener("message", onMessage);
  root.querySelector(".pill").addEventListener("click", api.show);

  window[KEY] = api;
  api.show();
})();
