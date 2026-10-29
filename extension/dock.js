// Injetado na aba da reunião (chrome.scripting, quando a pessoa começa a gravar). Desenha um
// painel flutuante no lado direito, como o do Tactiq, que é só uma moldura para live.html: a
// transcrição, as notas e os botões moram lá dentro. Este arquivo cuida da casca: posição,
// minimizar, fechar. Rodá-lo de novo numa aba que já tem o painel só o traz de volta.
//
// Nada de innerHTML nem de atributo style: o Google Meet (e outras páginas do Google) exige
// Trusted Types e CSP de estilo restrita, e uma atribuição dessas faria o painel não aparecer.
(() => {
  const KEY = "__escutaDock";
  if (window[KEY]) {
    window[KEY].show();
    return;
  }

  const CSS = `
    :host { all: initial; }
    .panel {
      position: fixed; top: 12px; right: 12px; bottom: 12px; width: 384px; max-width: calc(100vw - 24px);
      z-index: 2147483647; border-radius: 14px; overflow: hidden;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px #2a3354;
      background: #161d32;
    }
    .panel iframe { display: block; width: 100%; height: 100%; border: 0; color-scheme: normal; }
    .pill {
      position: fixed; right: 16px; bottom: 96px; z-index: 2147483647; width: 52px; height: 52px;
      display: none; align-items: center; justify-content: center; border: 0; border-radius: 50%;
      background: #ffc53d; color: #0e1424; cursor: pointer; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    }
    .pill:hover { filter: brightness(1.1); }
    .pill:focus-visible { outline: 3px solid #f6f4ef; outline-offset: 2px; }
    .pill svg { width: 24px; height: 24px; }
    .minimized .panel { display: none; }
    .minimized .pill { display: flex; }
    @media (prefers-reduced-motion: no-preference) { .panel { animation: in 160ms ease-out; } }
    @keyframes in { from { opacity: 0; transform: translateX(16px); } }
  `;

  const host = document.createElement("div");
  host.setAttribute("data-escuta", "dock");
  // Shadow root fechado: nem o CSS da reunião muda o painel, nem o painel muda a reunião.
  const root = host.attachShadow({ mode: "closed" });

  // Folha de estilo construída por código: não passa pela CSP de estilo da página, ao contrário de um <style>.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(style);
  }

  const SVG = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(SVG, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "currentColor");
  icon.setAttribute("aria-hidden", "true");
  for (const [x, y, h] of [[3, 9, 6], [8, 5, 14], [13, 8, 8], [18, 4, 16]]) {
    const bar = document.createElementNS(SVG, "rect");
    for (const [name, value] of Object.entries({ x, y, width: 3, height: h, rx: 1.5 })) bar.setAttribute(name, value);
    icon.append(bar);
  }

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  const panel = document.createElement("div");
  panel.className = "panel";
  const pill = document.createElement("button");
  pill.className = "pill";
  pill.type = "button";
  pill.title = "Abrir a transcrição ao vivo";
  pill.setAttribute("aria-label", "Abrir a transcrição ao vivo");
  pill.append(icon);

  const frame = document.createElement("iframe");
  frame.title = "Escuta · transcrição ao vivo";
  frame.allow = "clipboard-write"; // o botão Copiar, de dentro da moldura
  frame.src = chrome.runtime.getURL("live.html?dock=1");
  panel.append(frame);
  wrap.append(panel, pill);
  root.append(wrap);

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
  pill.addEventListener("click", api.show);

  window[KEY] = api;
  api.show();
})();
