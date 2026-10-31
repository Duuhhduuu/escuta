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
      position: fixed; right: 12px; bottom: 12px; width: 340px; height: min(calc(100vh - 24px), 640px); max-width: calc(100vw - 24px);
      z-index: 2147483647; border-radius: 14px; overflow: hidden;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px #2a3354;
      background: #161d32;
    }
    .panel iframe { display: block; width: 100%; height: 100%; border: 0; color-scheme: normal; }
    .pill {
      position: fixed; right: 16px; bottom: 96px; z-index: 2147483647; width: 52px; height: 52px; box-sizing: border-box;
      display: none; align-items: center; justify-content: center; padding: 0; border-radius: 50%;
      background: #161d32; color: #ffc53d; border: 1px solid #2a3354; cursor: pointer; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    }
    .pill::after {
      content: ""; position: absolute; top: -2px; right: -2px; width: 11px; height: 11px; box-sizing: border-box;
      border-radius: 50%; background: #ff6b5b; border: 2px solid #161d32; animation: blink 1.2s steps(1) infinite;
    }
    @keyframes blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0.15; } }
    .pill:hover { filter: brightness(1.1); }
    .pill:focus-visible { outline: 3px solid #f6f4ef; outline-offset: 2px; }
    .pill svg { width: 30px; height: 30px; }
    .pill .bar { stroke: #0e1424; }
    .pill .cur { stroke: #3347ff; }
    @media (prefers-color-scheme: light) {
      .pill { background: #fff; color: #0e1424; border-color: #dad6cb; }
      .pill::after { border-color: #fff; background: #d92d20; }
      .pill .bar { stroke: #fff; } .pill .cur { stroke: #ffc53d; }
    }
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

  // Símbolo do Escuta: balão âmbar, barras de voz e o cursor azul.
  const SVG = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(SVG, "svg");
  icon.setAttribute("viewBox", "0 0 64 64");
  icon.setAttribute("aria-hidden", "true");
  const shape = (tag, attrs) => {
    const el = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    return el;
  };
  icon.append(shape("path", { d: "M20 4H44A16 16 0 0 1 60 20V36A16 16 0 0 1 44 52H30C22 52 14 57 6 60C5 54 4 48 4 40V20A16 16 0 0 1 20 4Z", fill: "currentColor", stroke: "currentColor", "stroke-width": 2, "stroke-linejoin": "round" }));
  for (const d of ["M14.5 24V32", "M23 19V37", "M31.5 15V41", "M40 21V35"]) icon.append(shape("path", { d, class: "bar", fill: "none", "stroke-width": 5, "stroke-linecap": "round" }));
  icon.append(shape("path", { d: "M49 20V36", class: "cur", fill: "none", "stroke-width": 5, "stroke-linecap": "round" }));

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
